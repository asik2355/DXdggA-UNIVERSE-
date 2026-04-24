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
const GRAND_PANEL_URL = process.env.GRAND_PANEL_URL || 'https://api.grand-panel.com';
const USERNAME = process.env.GRAND_PANEL_USERNAME || 'Team123';
const PASSWORD = process.env.GRAND_PANEL_PASSWORD || 'Team123';
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
  // Matches 3-3 digits (e.g. 349-734) or 4-8 continuous digits
  const match = text.match(/(\d{3}-\d{3})|(\d{4,8})/);
  return match ? match[0] : 'No OTP Found';
}

// Login to Grand Panel
async function loginToPanel() {
  try {
    addLog(`Fetching login page from ${GRAND_PANEL_URL}...`);
    const getRes = await axios.get(`${GRAND_PANEL_URL}/login`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
    });
    
    const $ = cheerio.load(getRes.data);
    const cookies = getRes.headers['set-cookie'] || [];
    const cookieHeader = cookies.join('; ');

    // Extract CSRF or hidden tokens
    const formData = new URLSearchParams();
    $('form input[type="hidden"]').each((i, el) => {
        const name = $(el).attr('name');
        const value = $(el).attr('value');
        if (name && value) {
            formData.append(name, value);
        }
    });

    formData.append('username', USERNAME);
    formData.append('password', PASSWORD);
    
    addLog('Submitting credentials...');
    const postRes = await axios.post(`${GRAND_PANEL_URL}/login`, formData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieHeader,
        'Referer': `${GRAND_PANEL_URL}/login`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 405
    });

    const newCookies = postRes.headers['set-cookie'] || [];
    sessionCookie = newCookies.length > 0 ? newCookies.join('; ') : cookieHeader;
    
    if (postRes.status === 302 || postRes.headers.location) {
      addLog('Login successful! Dashboard reached.');
      botStatus = 'Running (LoggedIn)';
      
      // Try to find correct ticket path by visiting home
      try {
        const homeRes = await axios.get(`${GRAND_PANEL_URL}/`, {
            headers: { 'Cookie': sessionCookie, 'User-Agent': 'Mozilla/5.0' }
        });
        const $home = cheerio.load(homeRes.data);
        const ticketLink = $home('a[href*="ticket"], a[href*="support"], a[href*="message"]').first().attr('href');
        if (ticketLink) {
            addLog(`Found potential ticket path: ${ticketLink}`);
            // If it's a relative path, prepend URL if needed
        }
      } catch (e) {
          addLog('Could not scrape home page for links.');
      }
      
      return true;
    } else {
        const $dashboard = cheerio.load(postRes.data);
        if ($dashboard('a[href*="logout"]').length > 0) {
            addLog('Login successful (Already logged in or direct access).');
            botStatus = 'Running (LoggedIn)';
            return true;
        }
        addLog('Login failed: Check credentials or panel security.');
        botStatus = 'Error (Login Failed)';
        return false;
    }
  } catch (error: any) {
    addLog(`Login Error: ${error.message}`);
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
    const res = await axios.get(`${GRAND_PANEL_URL}/cdrs`, {
      headers: { 
          'Cookie': sessionCookie,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Referer': `${GRAND_PANEL_URL}/cdrs`
      }
    });

    const $ = cheerio.load(res.data);
    
    // Check if session expired
    if ($('form[action*="login"]').length > 0 || res.data.includes('Sign in to your account')) {
        addLog('⚠️ Session expired. Re-logging...');
        sessionCookie = '';
        await loginToPanel();
        return;
    }

    const cdrs: any[] = [];
    $('table tbody tr').each((i, el) => {
      const date = $(el).find('td').eq(0).text().trim();
      const number = $(el).find('td').eq(4).text().trim();
      const cli = $(el).find('td').eq(5).text().trim();
      const messageId = $(el).find('td').eq(6).text().trim();
      const smsBody = $(el).find('td').eq(7).text().trim();

      if (messageId && messageId.length > 5) {
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
    const success = await sendToTelegram('<b>🔔 Test Message</b>\n\nYour Grand Panel Forwarder is working correctly!');
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
