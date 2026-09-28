// GET /api/raw?key=XXXX  ->  { title, text }
// Proxy baca paste (browser tidak bisa fetch pastebin.com langsung karena CORS).

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method tidak diizinkan.' });
  }

  const key = String(req.query?.key || '');
  if (!/^[A-Za-z0-9]{6,12}$/.test(key)) {
    return res.status(400).json({ error: 'Kode paste tidak valid.' });
  }

  try {
    const r = await fetch(`https://pastebin.com/raw/${key}`);
    if (!r.ok) return res.status(404).json({ error: 'Paste tidak ditemukan.' });
    const raw = await r.text();

    if (!raw.startsWith('#BT:')) {
      // Bukan paste buatan BagiTeks (atau halaman error/limit dari Pastebin).
      return res.status(404).json({ error: 'Paste tidak ditemukan.' });
    }
    const nl = raw.indexOf('\n');
    const title = raw.slice(4, nl === -1 ? undefined : nl).trim();
    const text = nl === -1 ? '' : raw.slice(nl + 1);

    // Cache di edge Vercel supaya tidak kena limit Pastebin.
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
    return res.status(200).json({ title, text });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: 'Tidak bisa menghubungi Pastebin.' });
  }
}
