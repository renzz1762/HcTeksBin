// POST /api/paste  { title, text }  ->  { key }
// Proxy ke Pastebin. API key ada di environment variable, bukan di frontend.

import { consume, refund } from './_limit.js';

const MAX_LEN = 10000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method tidak diizinkan.' });
  }

  const devKey = process.env.PASTEBIN_KEY;
  if (!devKey) {
    return res.status(500).json({ error: 'Server belum dikonfigurasi (PASTEBIN_KEY kosong).' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const text = typeof body?.text === 'string' ? body.text : '';
  const title = typeof body?.title === 'string'
    ? body.title.replace(/[\r\n]+/g, ' ').trim().slice(0, 80)
    : '';

  if (!text.trim()) return res.status(400).json({ error: 'Teks tidak boleh kosong.' });
  if (text.length > MAX_LEN) {
    return res.status(400).json({ error: `Teks maksimal ${MAX_LEN} karakter.` });
  }

  // Batas paste per perangkat per 24 jam (LIMITED_SETTING di env Vercel).
  let quota;
  try {
    const c = await consume(req);
    quota = c.quota;
    if (!c.allowed) {
      const wait = Math.max(1, Math.ceil(((quota.resetAt || Date.now()) - Date.now()) / 1000));
      res.setHeader('Retry-After', String(wait));
      return res.status(429).json({
        error: `Kuota ${quota.limit} paste per 24 jam sudah habis.`,
        quota
      });
    }
  } catch (e) {
    console.error(e);
  }

  // Baris pertama menyimpan judul supaya bisa ditampilkan lagi saat dibaca.
  const content = `#BT:${title}\n${text}`;

  const params = new URLSearchParams({
    api_dev_key: devKey,
    api_option: 'paste',
    api_paste_code: content,
    api_paste_name: title || 'BagiTeks',
    api_paste_private: process.env.PASTE_PRIVACY || '1', // 0 publik, 1 unlisted
    api_paste_expire_date: process.env.PASTE_EXPIRE || '1W'
  });

  try {
    const r = await fetch('https://pastebin.com/api/api_post.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: params
    });
    const out = (await r.text()).trim();
    const m = /^https:\/\/pastebin\.com\/([A-Za-z0-9]+)$/.exec(out);
    if (!m) {
      console.error('Pastebin error:', out);
      await refund(req).catch(() => {});
      return res.status(502).json({ error: 'Pastebin menolak: ' + out.slice(0, 150) });
    }
    return res.status(200).json({ key: m[1], quota });
  } catch (e) {
    console.error(e);
    await refund(req).catch(() => {});
    return res.status(502).json({ error: 'Tidak bisa menghubungi Pastebin.' });
  }
}
