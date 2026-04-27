import requests
import time
import re
import os
from bs4 import BeautifulSoup

# --- CONFIGURATIONS ---
# You can set these directly or use environment variables
PANEL_URL = "http://51.89.99.105/NumberPanel"
USERNAME = "asik123"
PASSWORD = "asik123"
TELEGRAM_TOKEN = "7735071779:AAEFTzb4vVhweKEP9wem5b44LOjpjwU8_rA"
TELEGRAM_CHAT_ID = "-1003578388211"

# SESSION STATE
session = requests.Session()
session.headers.update({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
})
last_seen_cdr_id = None

def log(msg):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}")

def mask_number(num):
    if len(num) <= 7:
        return num
    first_3 = num[:3]
    last_4 = num[-4:]
    return f"{first_3}DXA{last_4}"

def extract_otp(text):
    # Normalize text
    clean_text = re.sub(r'[\u200B-\u200D\uFEFF]', '', text)

    # 1. Multi-part OTPs
    multi_part = re.search(r'(\d{3}[-\s]\d{3})|(\d{2}[-\s]\d{2}[-\s]\d{2})', clean_text)
    if multi_part:
        return multi_part.group(0)

    # 2. Keyword-based extraction
    otp_keywords = ['code', 'is', 'otp', 'pin', 'verification', 'auth', 'কোড', 'رمز', 'your code']
    keywords_pattern = '|'.join(otp_keywords)
    
    keyword_match = re.search(rf'(?:{keywords_pattern})\s*(?:is|:|-|=)?\s*([a-z0-9]{{4,10}})', clean_text, re.I)
    if keyword_match:
        return keyword_match.group(1)
        
    keyword_match_rev = re.search(rf'([a-z0-9]{{4,10}})\s*(?:is your|is the|কোড)', clean_text, re.I)
    if keyword_match_rev:
        return keyword_match_rev.group(1)

    # 3. Digit sequences fallback
    digit_matches = re.findall(r'\d{4,10}', clean_text)
    if digit_matches:
        codes = [d for d in digit_matches if 4 <= len(d) <= 8]
        if codes:
            return codes[0]

    return "No OTP Found"

def solve_captcha(text):
    try:
        # Matches 2 + 6, 10 - 5, etc.
        match = re.search(r'(\d+)\s*([\+\-])\s*(\d+)', text)
        if match:
            a = int(match.group(1))
            op = match.group(2)
            b = int(match.group(3))
            return str(a + b) if op == '+' else str(a - b)
    except Exception as e:
        log(f"Error solving captcha: {e}")
    return "0"

def send_to_telegram(text, otp=None):
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
        payload = {
            "chat_id": TELEGRAM_CHAT_ID,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True
        }
        
        if otp and otp != "No OTP Found":
            payload["reply_markup"] = {
                "inline_keyboard": [
                    [{"text": f"📋 {otp}", "callback_data": f"copy_{otp}"}]
                ]
            }
            
        res = requests.post(url, json=payload)
        return res.json().get("ok", False)
    except Exception as e:
        log(f"Telegram Error: {e}")
        return False

def login():
    try:
        log(f"Attempting to login to {PANEL_URL}/login...")
        login_res = session.get(f"{PANEL_URL}/login")
        soup = BeautifulSoup(login_res.text, 'html.parser')
        
        # Solve math captcha
        all_text = login_res.text
        captcha_match = re.search(r'(\d+\s*[\+\-]\s*\d+)\s*=', all_text)
        if not captcha_match:
            labels = soup.find_all(["label", "div", "span"])
            for l in labels:
                if "+" in l.text or "-" in l.text:
                    captcha_match = re.search(r'(\d+\s*[\+\-]\s*\d+)', l.text)
                    if captcha_match: break
        
        captcha_text = captcha_match.group(1) if captcha_match else "0 + 0"
        answer = solve_captcha(captcha_text)
        log(f"Captcha Info: Text='{captcha_text}', Answer='{answer}'")

        # Form detection
        form = soup.find("form")
        if not form:
            log("❌ No login form found.")
            return False
            
        action = form.get("action")
        login_post_url = f"{PANEL_URL}/login"
        if action:
            from urllib.parse import urljoin
            login_post_url = urljoin(f"{PANEL_URL}/login", action)

        form_data = {}
        for hidden in form.find_all("input", type="hidden"):
            name = hidden.get("name")
            if name: form_data[name] = hidden.get("value") or ""
        
        # Detect inputs
        user_input = form.find("input", {"name": re.compile(r"user|email|id", re.I)}) or form.find("input", {"type": "text"})
        pass_input = form.find("input", {"name": re.compile(r"pass", re.I)}) or form.find("input", {"type": "password"})
        captcha_input = form.find("input", {"placeholder": re.compile(r"answer|ans|code", re.I)}) or \
                        form.find("input", {"name": re.compile(r"ans|captcha", re.I)})
        
        user_field = user_input.get("name") if user_input else "username"
        pass_field = pass_input.get("name") if pass_input else "password"
        captcha_field = captcha_input.get("name") if captcha_input else "answer"

        form_data[user_field] = USERNAME
        form_data[pass_field] = PASSWORD
        form_data[captcha_field] = answer
        
        log(f"Submitting form to: {login_post_url}")
        res = session.post(login_post_url, data=form_data, allow_redirects=True)
        
        # Success check
        check_res = session.get(f"{PANEL_URL}/client/SMSCDRStats")
        if 'logout' in res.text.lower() or 'SMS Reports' in check_res.text or 'Dashboard' in check_res.text:
            log("✅ Login Successful!")
            return True
        else:
            log(f"❌ Login Failed (Status: {res.status_code}). Check details.")
            return False
    except Exception as e:
        log(f"❌ Login Error: {e}")
        return False

def check_cdrs():
    global last_seen_cdr_id
    try:
        cdr_url = f"{PANEL_URL}/client/SMSCDRStats"
        res = session.get(cdr_url)
        
        # Check if session expired
        if "sign in to your account" in res.text.lower() or "welcome back" in res.text.lower():
            if "SMS Reports" not in res.text:
                log("⚠️ Session expired. Re-logging...")
                if login():
                    return check_cdrs()
                return

        soup = BeautifulSoup(res.text, 'html.parser')
        
        # Smart Column Detection
        date_idx, number_idx, cli_idx, sms_idx = 0, 2, 3, 5
        header = soup.find("thead") or soup.find("tr")
        if header:
            ths = header.find_all(["th", "td"])
            for i, th in enumerate(ths):
                txt = th.get_text().lower()
                if "date" in txt or "time" in txt: date_idx = i
                if "number" in txt or "phone" in txt or "destination" in txt: number_idx = i
                if "cli" in txt or "sender" in txt or "from" in txt: cli_idx = i
                if "sms" in txt or "body" in txt or "message" in txt: sms_idx = i

        rows = soup.find_all("tr")
        
        cdrs = []
        for row in rows:
            cols = row.find_all("td")
            if len(cols) >= 4:
                cdr_date = cols[date_idx].get_text(strip=True)
                number = cols[number_idx].get_text(strip=True)
                cli = cols[cli_idx].get_text(strip=True)
                sms_body = cols[sms_idx].get_text(strip=True)
                
                # Check if it looks like header row or empty
                if "number" in number.lower() or not number:
                    continue
                
                # Unique ID
                message_id = re.sub(r'\s+', '', f"{cdr_date}_{number}_{cli}")
                
                if number and sms_body:
                    cdrs.append({
                        "date": cdr_date,
                        "number": number,
                        "cli": cli,
                        "message_id": message_id,
                        "sms_body": sms_body
                    })

        if cdrs:
            new_entries = []
            for cdr in cdrs[:10]:
                if cdr["message_id"] == last_seen_cdr_id:
                    break
                new_entries.append(cdr)
            
            if new_entries:
                log(f"⚡ Found {len(new_entries)} new messages.")
                for cdr in reversed(new_entries):
                    if not last_seen_cdr_id:
                        log(f"📍 Initializing benchmark with Message ID: {cdr['message_id']}")
                        last_seen_cdr_id = cdr["message_id"]
                        break
                    
                    otp = extract_otp(cdr["sms_body"])
                    masked_num = mask_number(cdr["number"])
                    
                    message = f"<b>{cdr['cli']} {masked_num}</b>"
                    send_to_telegram(message, otp)
                    log(f"✅ Forwarded SMS from {cdr['number']}")
                
                last_seen_cdr_id = cdrs[0]["message_id"]
                
    except Exception as e:
        log(f"❌ Error during CDR check: {e}")

if __name__ == "__main__":
    if login():
        log("🚀 Bot is running and monitoring CDRs every 30 seconds...")
        while True:
            check_cdrs()
            time.sleep(30)
