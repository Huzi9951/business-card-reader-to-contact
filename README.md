<p align="center">✦ &nbsp; HUZI9951 &nbsp; ✦</p>

# CardScan AI

Photograph a business card. The app reads the text, pulls out a name, company, email, and phone number, and gives you a contact you can save.

The page is a static front end in `public/`. The API is a Flask app in `api/index.py`, set up for Vercel (`vercel.json` routes `/scan` and `/health` to that function).

## How a scan works

1. The browser sends the card image.
2. Google Cloud Vision reads the text.
3. Groq turns that text into contact fields.
4. A small SQLite counter caps the server at 40 scans a day.

Keys stay in the environment. They are not committed.

```env
GROQ_API_KEY=
GOOGLE_VISION_API_KEY=
```

## Run locally

```bash
pip install -r requirements.txt
```

Set the two keys, then start the Flask app in `api/index.py` and open `public/index.html`. `/health` reports whether each key is configured.
