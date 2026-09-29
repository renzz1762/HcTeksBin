// GET /api/limit -> { limit, remaining, resetAt, serverNow }
import { status } from './_limit.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method tidak diizinkan.' });
  }
  try {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(await status(req));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Gagal membaca kuota.' });
  }
}
