import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = 3000;

// Configurations from env
const PANEL_URL = process.env.NUMBER_PANEL_URL || 'http://51.89.99.105/NumberPanel';
const USERNAME = process.env.NUMBER_PANEL_USERNAME || 'asik123';
const PASSWORD = process.env.NUMBER_PANEL_PASSWORD || 'asik123';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '7735071779:AAEFTzb4vVhweKEP9wem5b44LOjpjwU8_rA';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '-1003578388211';

// State
let sessionCookie = '';
let lastSeenCDRId: string | null = null;
let botStatus = 'Initializing...';
let logs: string[] = [];

function addLog(msg: string) {
  const timestamp = new Date().toLocaleTimeString();
  const logMsg = `[${timestamp}] ${msg}`;
  logs.unshift(logMsg);
  if (logs.length > 50) logs.pop();
  console.log(logMsg);
}

function escapeHTML(str: string) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function maskNumber(num: string) {
  if (num.length <= 7) return num;
  const first3 = num.substring(0, 3);
  const last4 = num.substring(num.length - 4);
  return `${first3}DXA${last4}`;
}

// Telegram Forwarding
async function sendToTelegram(message: string, otp: string | null = null) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    
    const payload: any = {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    };

    if (otp && otp !== 'No OTP Found') {
      payload.reply_markup = {
        inline_keyboard: [
          [{ text: `📋 ${otp}`, callback_data: `copy_${otp}` }]
        ]
      };
    }

    const res = await axios.post(url, payload);
    if (res.data && res.data.ok) {
      addLog('✅ Successfully forwarded message to Telegram.');
      return true;
    } else {
      addLog(`❌ Telegram API Error: ${JSON.stringify(res.data)}`);
      return false;
    }
  } catch (error: any) {
    const errorMsg = error.response?.data?.description || error.message;
    addLog(`❌ Telegram Request Failed: ${errorMsg}`);
    return false;
  }
}

function extractOTP(text: string): string {
  // Normalize text: handle common localized number formats or variations
  const cleanText = text.replace(/[\u200B-\u200D\uFEFF]/g, ''); // Remove zero-width spaces

  // 1. Specific Patterns (WhatsApp, Imo, etc. often use hyphenated or spaced codes)
  // Matches: 123-456, 123 456, 12-34-56
  const multiPartMatch = cleanText.match(/(\d{3}[-\s]\d{3})|(\d{2}[-\s]\d{2}[-\s]\d{2})/);
  if (multiPartMatch) return multiPartMatch[0];

  // 2. Keyword-based extraction
  // Handles English, Bengali, Arabic keywords for "code" or "is"
  // Keywords: code, is, otp, pin, verification, কোড, رمز, verification code, your code
  const otpPatterns = [
    /(?:code|is|otp|pin|verification|auth|verification code|কোড|رمز|your code)\s*(?:is|:|-|=)?\s*([a-z0-9]{4,10})/i,
    /([a-z0-9]{4,10})\s*(?:is your|is the|কোড)/i,
    /verification code\s*:?\s*([a-z0-9]{4,10})/i
  ];

  for (const pattern of otpPatterns) {
    const match = cleanText.match(pattern);
    if (match && match[1]) return match[1];
  }

  // 3. Falling back to any sequence of 4-10 digits that looks like a code
  // We avoid taking long strings like phone numbers by limiting to 10 digits
  const digitMatches = cleanText.match(/\d{4,10}/g);
  if (digitMatches) {
    // Filter out potential phone numbers (usually > 10 digits in many regions, or start with country code)
    // For a simple heuristic, we pick the first 4-8 digit sequence
    const codes = digitMatches.filter(d => d.length >= 4 && d.length <= 8);
    if (codes.length > 0) return codes[0];
  }

  return 'No OTP Found';
}

function solveCaptcha(text: string): string {
  try {
    // Matches 2 + 6, 10 - 5, etc.
    const match = text.match(/(\d+)\s*([\+\-])\s*(\d+)/);
    if (match) {
      const a = parseInt(match[1]);
      const op = match[2];
      const b = parseInt(match[3]);
      return op === '+' ? (a + b).toString() : (a - b).toString();
    }
  } catch (e) {
    addLog('Error solving captcha: ' + text);
  }
  return '0';
}

// Login to Panel
async function loginToPanel() {
  try {
    const loginUrl = `${PANEL_URL}/login`;
    addLog(`Fetching login page from ${loginUrl}...`);
    const getRes = await axios.get(loginUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
    });

    const $ = cheerio.load(getRes.data);
    const cookies = getRes.headers['set-cookie'] || [];
    const cookieHeader = cookies.join('; ');

    // Solve math captcha from text or labels
    // Patterns: "What is 2 + 6 = ?", "2 + 6 ="
    const bodyText = $('body').text();
    const captchaMatch = bodyText.match(/(\d+\s*\+\s*\d+)\s*=/i) || 
                         $('label:contains("+")').text().match(/(\d+\s*\+\s*\d+)/) ||
                         $('div:contains("+")').last().text().match(/(\d+\s*\+\s*\d+)/);
    
    const captchaText = captchaMatch ? captchaMatch[1] : null;
    const answer = captchaText ? solveCaptcha(captchaText) : '0';
    addLog(`Captcha Info: Text="${captchaText || 'Not Found'}", Answer="${answer}"`);

    const formData = new URLSearchParams();
    
    // Auto-detect form settings
    const $form = $('form').first();
    const actionAttr = $form.attr('action');
    const loginPostUrl = actionAttr ? (actionAttr.startsWith('http') ? actionAttr : new URL(actionAttr, loginUrl).href) : loginUrl;
    
    const usernameInput = $('input[name*="user" i], input[placeholder*="username" i]').first();
    const passwordInput = $('input[name*="pass" i], input[type="password"]').first();
    const answerInput = $('input[placeholder*="answer" i], input[name*="answer" i], input[name*="ans" i]').first();

    const userField = usernameInput.attr('name') || 'username';
    const passField = passwordInput.attr('name') || 'password';
    const captchaField = answerInput.attr('name') || 'answer';

    addLog(`Form Info: Action="${loginPostUrl}", User="${userField}", Pass="${passField}", Captcha="${captchaField}"`);

    // Collect all hidden fields (CSRF tokens etc)
    $form.find('input[type="hidden"]').each((i, el) => {
        const name = $(el).attr('name');
        const value = $(el).attr('value');
        if (name) formData.append(name, value || '');
    });

    formData.append(userField, USERNAME);
    formData.append(passField, PASSWORD);
    formData.append(captchaField, answer);
    
    addLog(`Submitting login to ${loginPostUrl}...`);
    const parsedPanelUrl = new URL(PANEL_URL);
    const origin = `${parsedPanelUrl.protocol}//${parsedPanelUrl.host}`;

    const postRes = await axios.post(loginPostUrl, formData.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieHeader,
        'Referer': loginUrl,
        'Origin': origin,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      maxRedirects: 0,
      validateStatus: () => true
    });

    const respCookies = postRes.headers['set-cookie'] || [];
    // Combine initial cookies with response cookies
    sessionCookie = [...cookies, ...respCookies].join('; ');
    
    // Check success via redirect or content
    if (postRes.status === 302 || postRes.headers.location || postRes.data.includes('Dashboard') || postRes.data.includes('SMS Reports') || postRes.data.toLowerCase().includes('logout')) {
      addLog('✅ Login Successful!');
      botStatus = 'Running (LoggedIn)';
      return true;
    } else {
        const $resPage = cheerio.load(postRes.data);
        const errorText = $resPage('.alert-danger, .error-msg, [class*="error"]').text().trim();
        addLog(`❌ Login Failed (Status: ${postRes.status}). ${errorText ? 'Portal says: ' + errorText : 'No error message found on page.'}`);
        botStatus = 'Error (Login Failed)';
        return false;
    }
  } catch (error: any) {
    addLog(`❌ Connection Error during login: ${error.message}`);
    botStatus = 'Error (Connection)';
    return false;
  }
}

async function checkCDRs() {
  if (!sessionCookie) {
    addLog('No session, trying to login...');
    await loginToPanel();
    return;
  }

  try {
    const cdrUrl = `${PANEL_URL}/client/SMSCDRStats`;
    const res = await axios.get(cdrUrl, {
      headers: { 
          'Cookie': sessionCookie,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Referer': cdrUrl
      }
    });

    const $ = cheerio.load(res.data);
    
    // Check if session expired
    if ($('form[action*="login"]').length > 0 || res.data.includes('Sign in to your account') || res.data.includes('Welcome back')) {
        if (!res.data.includes('SMS Reports')) {
          addLog('⚠️ Session expired or redirected to login. Re-logging...');
          sessionCookie = '';
          await loginToPanel();
          return;
        }
    }

    // Smart Column Detection
    let dateIdx = -1, numberIdx = -1, cliIdx = -1, smsIdx = -1;
    
    $('table thead tr th, table tr th').each((i, el) => {
        const text = $(el).text().toLowerCase().trim();
        if (text.includes('date') || text.includes('time')) dateIdx = i;
        if (text.includes('number') || text.includes('phone') || text.includes('destination')) numberIdx = i;
        if (text.includes('cli') || text.includes('sender') || text.includes('from')) cliIdx = i;
        if (text.includes('sms') || text.includes('body') || text.includes('message')) smsIdx = i;
    });

    // Fallback indices if header detection fails
    if (dateIdx === -1) dateIdx = 0;
    if (numberIdx === -1) numberIdx = 2;
    if (cliIdx === -1) cliIdx = 3;
    if (smsIdx === -1) smsIdx = 5;

    const cdrs: any[] = [];
    $('table tbody tr').each((i, el) => {
      const $tds = $(el).find('td');
      if ($tds.length < 4) return; // Skip empty rows

      const date = $tds.eq(dateIdx).text().trim();
      const number = $tds.eq(numberIdx).text().trim();
      const cli = $tds.eq(cliIdx).text().trim();
      const smsBody = $tds.eq(smsIdx).text().trim();

      // Create a unique ID if none exists
      const messageId = `${date}_${number}_${cli}`.replace(/\s+/g, '');

      if (number && smsBody) {
        cdrs.push({ date, number, cli, messageId, smsBody });
      }
    });

    if (cdrs.length > 0) {
      const newEntries = [];
      for (const cdr of cdrs.slice(0, 10)) { 
          if (cdr.messageId === lastSeenCDRId) break; 
          newEntries.push(cdr);
      }

      if (newEntries.length > 0) {
          addLog(`Found ${newEntries.length} new messages.`);
          
          for (let i = newEntries.length - 1; i >= 0; i--) {
              const cdr = newEntries[i];
              
              if (!lastSeenCDRId) {
                  addLog(`📍 Initial CDR benchmark set to Message ID: ${cdr.messageId}. (Skipping old messages)`);
                  lastSeenCDRId = cdr.messageId;
                  
                  const testMsg = `<b>🚀 Bot Initialized & Monitoring </b>\n\n` +
                                `Last Message ID: <code>${cdr.messageId}</code>\n` +
                                `Service: ${cdr.cli}\n` +
                                `Waiting for new messages...`;
                  await sendToTelegram(testMsg);
                  break;
              }

              addLog(`⚡ Forwarding new SMS from ${cdr.number}...`);
              const otp = extractOTP(cdr.smsBody);
              const maskedNumber = maskNumber(cdr.number);
              
              // Format: Service MaskedNumber
              const message = `<b>${escapeHTML(cdr.cli)} ${escapeHTML(maskedNumber)}</b>`;
              
              await sendToTelegram(message, otp);
          }
          lastSeenCDRId = cdrs[0].messageId;
      }
    }
  } catch (error: any) {
    addLog(`❌ CDR Polling Error: ${error.message}`);
  }
}

// Start Server
async function start() {
  // API Routes
  app.get('/api/status', (req, res) => {
    res.json({
      status: botStatus,
      logs: logs,
      lastSeen: lastSeenCDRId
    });
  });

  // Re-trigger login
  app.post('/api/restart', async (req, res) => {
    addLog('Manual restart triggered.');
    lastSeenCDRId = null;
    const success = await loginToPanel();
    res.json({ success });
  });

  app.post('/api/test-telegram', async (req, res) => {
    addLog('Manual Telegram Test Triggered.');
    const success = await sendToTelegram('<b>🔔 Test Message</b>\n\nYour Number Panel Forwarder is working correctly!');
    res.json({ success });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    addLog(`Server running on http://localhost:${PORT}`);
    
    // Initial Login
    loginToPanel().then(() => {
      // Schedule polling every 30 seconds
      cron.schedule('*/30 * * * * *', () => {
        checkCDRs();
      });
      addLog('Bot scheduled for polling every 30 seconds.');
    });
  });
}

start();
