import requests
import time
import re
import os
from bs4 import BeautifulSoup

# --- CONFIGURATIONS ---
# You can set these directly or use environment variables
GRAND_PANEL_URL = "https://api.grand-panel.com"
USERNAME = "Team123"
PASSWORD = "Team123"
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
    # Matches 3-3 digits (e.g. 349-734) or 4-8 continuous digits
    match = re.search(r'(\d{3}-\d{3})|(\d{4,8})', text)
    return match.group(0) if match else "No OTP Found"

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
        log(f"Attempting to login to {GRAND_PANEL_URL}...")
        login_page = session.get(f"{GRAND_PANEL_URL}/login")
        soup = BeautifulSoup(login_page.text, 'html.parser')
        
        # Collect hidden form fields (tokens/csrf)
        form_data = {}
        for hidden_input in soup.find_all("input", type="hidden"):
            name = hidden_input.get("name")
            value = hidden_input.get("value")
            if name and value:
                form_data[name] = value
        
        form_data["username"] = USERNAME
        form_data["password"] = PASSWORD
        
        res = session.post(f"{GRAND_PANEL_URL}/login", data=form_data, allow_redirects=False)
        
        if res.status_code == 302 or 'logout' in session.get(f"{GRAND_PANEL_URL}/").text.lower():
            log("✅ Login Successful!")
            return True
        else:
            log("❌ Login Failed. Check credentials.")
            return False
    except Exception as e:
        log(f"❌ Login Error: {e}")
        return False

def check_cdrs():
    global last_seen_cdr_id
    try:
        res = session.get(f"{GRAND_PANEL_URL}/cdrs")
        
        # Check if session expired
        if "sign in to your account" in res.text.lower():
            log("⚠️ Session expired. Re-logging...")
            if login():
                return check_cdrs()
            return

        soup = BeautifulSoup(res.text, 'html.parser')
        rows = soup.find_all("tr")
        
        cdrs = []
        for row in rows:
            cols = row.find_all("td")
            if len(cols) >= 8:
                cdr_date = cols[0].get_text(strip=True)
                number = cols[4].get_text(strip=True)
                cli = cols[5].get_text(strip=True)
                message_id = cols[6].get_text(strip=True)
                sms_body = cols[7].get_text(strip=True)
                
                if len(message_id) > 5:
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
