"""
CardScan AI — Backend Server
EasyOCR for text extraction + Groq API for entity extraction.
API key loaded from .env file.
"""

import io
import os
import json
import base64
import sqlite3
import requests
from datetime import date
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from PIL import Image
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

app = Flask(__name__, static_folder='.', static_url_path='')
CORS(app)

# Initialize Database for Rate Limiting
def init_db():
    conn = sqlite3.connect('/tmp/scans.db')
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS scan_limits
                 (scan_date TEXT PRIMARY KEY, count INTEGER)''')
    conn.commit()
    conn.close()

init_db()

def check_and_increment_limit():
    """Check if the global daily limit is reached (40 scans/day)."""
    # Auto-recreate DB if deleted while server is running
    init_db()
    
    today = str(date.today())
    conn = sqlite3.connect('/tmp/scans.db')
    c = conn.cursor()
    c.execute("SELECT count FROM scan_limits WHERE scan_date = ?", (today,))
    row = c.fetchone()
    
    if row is None:
        c.execute("INSERT INTO scan_limits (scan_date, count) VALUES (?, 1)", (today,))
        count = 1
    else:
        count = row[0]
        if count >= 40:
            conn.close()
            return False
        c.execute("UPDATE scan_limits SET count = count + 1 WHERE scan_date = ?", (today,))
        count += 1
        
    conn.commit()
    conn.close()
    print(f"[{today}] Server-wide Scans Today: {count}/40")
    return True

print("✅ Server initialized with SQLite rate limiting.")

# Groq config
GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")

# Google Vision config
GOOGLE_VISION_API_KEY = os.getenv("GOOGLE_VISION_API_KEY", "")

def get_base64_image(data):
    """Extract standard base64 string from data URL or standard base64."""
    if hasattr(data, 'read'):
        # Just convert file bytes to base64
        return base64.b64encode(data.read()).decode('utf-8')
    else:
        if ',' in data:
            data = data.split(',', 1)[1]
        return data

def run_vision_ocr(base64_img):
    """Run Google Cloud Vision API REST call."""
    if not GOOGLE_VISION_API_KEY or GOOGLE_VISION_API_KEY == "your_google_vision_api_key_here":
        raise ValueError("Google Vision API key not set. Add it to .env: GOOGLE_VISION_API_KEY=AIzaSy...")

    url = f"https://vision.googleapis.com/v1/images:annotate?key={GOOGLE_VISION_API_KEY}"
    payload = {
        "requests": [
            {
                "image": {"content": base64_img},
                "features": [{"type": "TEXT_DETECTION"}]
            }
        ]
    }
    
    resp = requests.post(url, json=payload, timeout=30)
    
    if resp.status_code != 200:
        error_msg = f"Google Vision API error ({resp.status_code}): {resp.text}"
        print(f"❌ {error_msg}")
        raise ValueError(error_msg)
        
    data = resp.json()
    
    # Handle case where no text is found
    if not data.get('responses') or not data['responses'][0].get('textAnnotations'):
        return ""
        
    text = data['responses'][0]['textAnnotations'][0]['description']
        
    return text


def extract_entities_groq(text):
    """Call Groq API to extract entities from OCR text."""
    if not GROQ_API_KEY or GROQ_API_KEY == "your_groq_api_key_here":
        raise ValueError("Groq API key not set. Add it to .env file: GROQ_API_KEY=gsk_xxx")

    system_prompt = """You are a business card entity extractor. Given raw OCR text from a business card, extract the following entities. Return ONLY a valid JSON object with these exact keys:

{
  "NAME": "full name of the person",
  "ORG": "organization or company name",
  "DES": "designation or job title",
  "PHONE": "phone number(s), comma-separated if multiple",
  "EMAIL": "email address(es), comma-separated if multiple",
  "WEB": "website URL(s), comma-separated if multiple"
}

Rules:
- If an entity is not found, use an empty string ""
- Clean up OCR artifacts (extra spaces, broken characters)
- For phone numbers, preserve the original format including country codes
- For emails and websites, reconstruct properly if OCR split them across lines
- Return ONLY the JSON, no explanation or markdown"""

    headers = {
        'Authorization': f'Bearer {GROQ_API_KEY}',
        'Content-Type': 'application/json'
    }

    payload = {
        'model': 'llama-3.3-70b-versatile',
        'messages': [
            {'role': 'system', 'content': system_prompt},
            {'role': 'user', 'content': f'Extract entities from this business card text:\n\n{text}'}
        ],
        'temperature': 0.1,
        'max_tokens': 500,
        'response_format': {'type': 'json_object'}
    }

    resp = requests.post(GROQ_API_URL, headers=headers, json=payload, timeout=30)

    if resp.status_code == 401:
        raise ValueError("Invalid Groq API key. Check your .env file.")
    if resp.status_code != 200:
        raise ValueError(f"Groq API error ({resp.status_code}): {resp.text}")

    data = resp.json()
    content = data['choices'][0]['message']['content']
    parsed = json.loads(content)

    return {
        'NAME':  parsed.get('NAME', parsed.get('name', '')),
        'ORG':   parsed.get('ORG', parsed.get('org', parsed.get('ORGANIZATION', ''))),
        'DES':   parsed.get('DES', parsed.get('des', parsed.get('DESIGNATION', parsed.get('TITLE', parsed.get('title', ''))))),
        'PHONE': parsed.get('PHONE', parsed.get('phone', '')),
        'EMAIL': parsed.get('EMAIL', parsed.get('email', '')),
        'WEB':   parsed.get('WEB', parsed.get('web', parsed.get('WEBSITE', parsed.get('website', '')))),
    }


@app.route('/scan', methods=['POST'])
def scan():
    """Full pipeline: image → Vision OCR → Groq entity extraction."""
    try:
        if not check_and_increment_limit():
            return jsonify({
                'error': 'Global scan limit reached (40 cards/day). To ensure we stay within the free tier, please try again tomorrow!',
                'limit_reached': True
            }), 429

        base64_img = None

        if 'image' in request.files:
            base64_img = get_base64_image(request.files['image'].stream)
        elif request.is_json and 'image' in request.json:
            base64_img = get_base64_image(request.json['image'])
        else:
            return jsonify({'error': 'No image provided'}), 400

        # Step 1: Vision OCR
        print("📑 Running Google Vision OCR...")
        ocr_text = run_vision_ocr(base64_img)
        print(f"📝 OCR result: {ocr_text[:200]}...")

        if not ocr_text or len(ocr_text.strip()) < 3:
            return jsonify({
                'error': 'Could not extract text from the image. Try a clearer photo.',
                'ocr_text': ocr_text
            }), 422

        # Step 2: Entity extraction via Groq
        print("🤖 Extracting entities with Groq...")
        entities = extract_entities_groq(ocr_text)
        print(f"✅ Entities: {entities}")

        return jsonify({
            'success': True,
            'ocr_text': ocr_text,
            'entities': entities
        })

    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        print(f"❌ Error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/health', methods=['GET'])
def health():
    has_groq = bool(GROQ_API_KEY and GROQ_API_KEY != "your_groq_api_key_here")
    has_vision = bool(GOOGLE_VISION_API_KEY and GOOGLE_VISION_API_KEY != "your_google_vision_api_key_here")
    return jsonify({
        'status': 'ok', 
        'engine': 'google_vision', 
        'groq_api_configured': has_groq,
        'vision_api_configured': has_vision
    })


if __name__ == '__main__':
    print("\n🚀 CardScan AI Server running at http://localhost:5000")
    print(f"   Groq API Key: {'✅ Configured' if GROQ_API_KEY else '❌ Not set'}")
    print(f"   Vision API Key: {'✅ Configured' if GOOGLE_VISION_API_KEY else '❌ Not set'}")
    print("   Endpoints: POST /scan, GET /health\n")
    app.run(host='0.0.0.0', port=5000, debug=False)
