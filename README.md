# BagiTeks

Website berbagi teks ala Pastebin. Frontend statis + 2 serverless function (Vercel) yang jadi proxy ke Pastebin API.

## Struktur
- `index.html` : seluruh tampilan
- `api/paste.js` : buat paste (pegang API key)
- `api/raw.js` : baca paste
- `vercel.json` : rewrite `/p/KODE` ke `index.html`

## Deploy
1. Push folder ini ke repository GitHub (jangan commit `.env`).
2. Di Vercel: Add New Project, pilih repo, langsung Deploy.
3. Project Settings, Environment Variables, tambahkan:
   - `PASTEBIN_KEY` = API Dev Key dari https://pastebin.com/doc_api
   - `PASTE_PRIVACY` (opsional) = `0` publik / `1` unlisted (default 1)
   - `PASTE_EXPIRE` (opsional) = `N`, `10M`, `1H`, `1D`, `1W`, `2W`, `1M`, `6M`, `1Y` (default `1W`)
   - `LIMITED_SETTING` = batas paste per perangkat per 24 jam (default 10, ubah sesukamu)
   - Disarankan: di Vercel, Storage/Marketplace, tambahkan **Upstash Redis** (gratis). Env `KV_REST_API_URL` dan `KV_REST_API_TOKEN` otomatis terisi. Tanpa ini limit pakai memori dan bisa reset sendiri.
4. Redeploy supaya env var terbaca.

## Tes lokal
```
npm i -g vercel
cp .env.example .env   # isi PASTEBIN_KEY
vercel dev
```
