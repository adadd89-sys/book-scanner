# Book Scanner

Telegram → Gemini image recognition and Google Search grounding → Google Apps Script → Google Sheets.

## Cloudflare Worker secrets
Set these in the existing Worker:
- GEMINI_API_KEY
- TELEGRAM_BOT_TOKEN
- GOOGLE_SCRIPT_URL
- SHEETS_SECRET (same secret as in Google Apps Script)

Optional Worker variable: GEMINI_MODEL (defaults to gemini-2.5-flash).

## Deployment
The GitHub Actions workflow deploys on every push to main. Add repository Actions secrets:
- CLOUDFLARE_API_TOKEN (Workers Scripts: Edit)
- CLOUDFLARE_ACCOUNT_ID

The Worker name is book-scanner (wrangler.toml). Ensure this matches the Worker you created in Cloudflare.

## Telegram webhook
After deployment, visit once:
https://YOUR-WORKER.workers.dev/register/YOUR_SHEETS_SECRET

Use your actual Worker URL and the existing Sheets secret. The endpoint registers the Telegram webhook securely.

## Sheet columns
The Apps Script appends exactly seven values in the existing order:
Наименование, Автор, Цена от (₽), Цена до (₽), Ссылка на мин. цену, Источник / примечание, Дата оценки.

Every photo is a separate row. No deduplication is performed.

## Limitations
Google Search grounding may not find an exact Ozon or Avito offer for every edition. Prices are estimates; unknown prices are left blank. Before routine processing of 500+ photos/day, load-test API limits and add a durable queue with retry handling.
