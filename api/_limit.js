// Rate limit per perangkat + plafon per IP. Jendela tetap 24 jam sejak paste pertama.
// LIMITED_SETTING (env Vercel) = batas paste per perangkat per 24 jam. Default 10.
//
// Supaya limit TIDAK ke-reset sebelum 24 jam, hitungan dijaga di dua tempat sekaligus:
//   1. Penyimpanan server: Upstash Redis kalau env-nya ada (disarankan), kalau tidak memori.
//   2. Token bertanda tangan (HMAC) yang disimpan browser dan dikirim lewat header x-quota-token.
// Server memakai angka yang LEBIH BESAR dari keduanya, jadi cold start / ganti instance Vercel /
// Redis error sesaat tidak bisa lagi mengembalikan jatah ke penuh.

import crypto from 'node:crypto';

const WINDOW_MS = 24 * 60 * 60 * 1000;
const IP_MULTIPLIER = 10; // plafon per IP = LIMITED_SETTING x 10 (wifi/kuota bersama)

const R_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const R_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const HAS_REDIS = Boolean(R_URL && R_TOKEN);

// Kunci tanda tangan token. Isi LIMIT_SECRET di Vercel (string acak panjang) dan jangan diganti-ganti.
const SECRET = process.env.LIMIT_SECRET || process.env.PASTEBIN_KEY || 'hc-paste-limit';

export function getLimit() {
  const n = parseInt(process.env.LIMITED_SETTING, 10);
  return Number.isFinite(n) && n >= 1 ? n : 10;
}

function who(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = xff || String(req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown');
  const dev = String(req.headers['x-device-id'] || '');
  const device = /^[A-Za-z0-9-]{16,64}$/.test(dev) ? dev : 'none-' + ip;
  return { dKey: 'hcp:d:' + device, iKey: 'hcp:i:' + ip, tok: String(req.headers['x-quota-token'] || '') };
}

/* ---------- token bertanda tangan ---------- */
function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
function makeToken(count, resetAt) {
  if (!resetAt) return '';
  const p = Buffer.from(JSON.stringify({ c: count, r: resetAt })).toString('base64url');
  return p + '.' + sign(p);
}
function readToken(tok, now) {
  if (!tok || tok.length > 300) return null;
  const [p, s] = tok.split('.');
  if (!p || !s) return null;
  const a = Buffer.from(s), b = Buffer.from(sign(p));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const o = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (Number.isFinite(o.c) && Number.isFinite(o.r) && o.r > now && o.r <= now + WINDOW_MS + 60000) {
      return { count: Math.max(0, Math.floor(o.c)), resetAt: o.r };
    }
  } catch { /* token rusak, abaikan */ }
  return null;
}

// Gabungkan hitungan server dengan token: hitungan terbesar, jendela yang paling awal mulai.
function merge(store, tok) {
  if (!tok) return store;
  return {
    count: Math.max(store.count, tok.count),
    resetAt: store.resetAt ? Math.min(store.resetAt, tok.resetAt) : tok.resetAt
  };
}

/* ---------- memori (cadangan) ---------- */
const mem = (globalThis.__hcpMem ||= new Map());
function memGet(key, now) {
  const e = mem.get(key);
  if (!e || e.resetAt <= now) { mem.delete(key); return null; }
  return e;
}
function memHit(key, consume, now) {
  let e = memGet(key, now);
  if (!consume) return { count: e ? e.count : 0, resetAt: e ? e.resetAt : null };
  if (!e) { e = { count: 0, resetAt: now + WINDOW_MS }; mem.set(key, e); }
  e.count++;
  return { count: e.count, resetAt: e.resetAt };
}

/* ---------- redis ---------- */
async function redis(cmds) {
  const r = await fetch(R_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + R_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  const j = await r.json();
  return j.map(x => x.result);
}
async function redisHit(key, consume, now) {
  if (!consume) {
    const [v, ttl] = await redis([['GET', key], ['PTTL', key]]);
    if (v && !(ttl > 0)) { // kunci tanpa masa berlaku: pasang supaya tidak abadi
      await redis([['PEXPIRE', key, String(WINDOW_MS)]]);
      return { count: parseInt(v, 10), resetAt: now + WINDOW_MS };
    }
    return { count: v ? parseInt(v, 10) : 0, resetAt: ttl > 0 ? now + ttl : null };
  }
  // SET NX + INCR dalam satu pipeline: jendela 24 jam dibuat bersamaan dengan hitungan pertama.
  const res = await redis([['SET', key, '0', 'NX', 'PX', String(WINDOW_MS)], ['INCR', key], ['PTTL', key]]);
  const n = res[1];
  let t = res[2];
  if (!(t > 0)) { await redis([['PEXPIRE', key, String(WINDOW_MS)]]); t = WINDOW_MS; }
  return { count: n, resetAt: now + t };
}

async function hit(key, consume) {
  const now = Date.now();
  if (HAS_REDIS) {
    try { return await redisHit(key, consume, now); } catch (e) { console.error(e); }
  }
  return memHit(key, consume, now);
}

// Tulis balik hitungan yang sudah digabung supaya server ikut "ingat" lagi.
async function syncKey(key, count, resetAt) {
  mem.set(key, { count, resetAt });
  if (HAS_REDIS) {
    const ttl = Math.max(1000, Math.floor(resetAt - Date.now()));
    try { await redis([['SET', key, String(count), 'PX', String(ttl)]]); } catch (e) { console.error(e); }
  }
}
async function heal(key, from, to) {
  if (!to.resetAt) return;
  if (to.count > from.count || !from.resetAt || Math.abs(to.resetAt - from.resetAt) > 2000) {
    await syncKey(key, to.count, to.resetAt);
  }
}

async function refundKey(key) {
  if (HAS_REDIS) {
    try { await redis([['DECR', key]]); return; } catch (e) { console.error(e); }
  }
  const e = mem.get(key);
  if (e && e.count > 0) e.count--;
}

function pack(limit, count, dReset, iReset, ipBlocked) {
  const remaining = ipBlocked ? 0 : Math.max(0, limit - count);
  const resetAt = dReset || (ipBlocked ? iReset : null);
  return {
    limit,
    remaining,
    resetAt,
    serverNow: Date.now(),
    token: makeToken(count, dReset)
  };
}

// Dipanggil sebelum membuat paste. Menambah hitungan.
export async function consume(req) {
  const limit = getLimit();
  const { dKey, iKey, tok } = who(req);
  const t = readToken(tok, Date.now());

  // Cek dulu tanpa menambah: kalau jatah sudah habis, jangan hitung lagi.
  const d0 = await hit(dKey, false);
  const pre = merge(d0, t);
  if (pre.count >= limit) {
    await heal(dKey, d0, pre);
    const i0 = await hit(iKey, false);
    return { allowed: false, quota: pack(limit, pre.count, pre.resetAt, i0.resetAt, true) };
  }

  const d = await hit(dKey, true);
  const i = await hit(iKey, true);
  const m = merge(d, t ? { count: t.count + 1, resetAt: t.resetAt } : null);
  await heal(dKey, d, m);

  const ipBlocked = i.count > limit * IP_MULTIPLIER;
  const allowed = m.count <= limit && !ipBlocked;
  if (!allowed && m.count <= limit) {
    // Ditolak karena plafon IP, bukan karena jatah perangkat: kembalikan hitungan.
    await refundKey(dKey); await refundKey(iKey);
    return { allowed, quota: pack(limit, m.count - 1, m.resetAt, i.resetAt, true) };
  }
  return { allowed, quota: pack(limit, m.count, m.resetAt, i.resetAt, ipBlocked || m.count > limit) };
}

// Dipanggil kalau Pastebin gagal, supaya kuota tidak terpotong sia-sia.
export async function refund(req) {
  const { dKey, iKey } = who(req);
  await refundKey(dKey);
  await refundKey(iKey);
}

// Hanya membaca, tidak menambah hitungan.
export async function status(req) {
  const limit = getLimit();
  const { dKey, iKey, tok } = who(req);
  const t = readToken(tok, Date.now());
  const d0 = await hit(dKey, false);
  const d = merge(d0, t);
  await heal(dKey, d0, d);
  const i = await hit(iKey, false);
  const ipBlocked = i.count >= limit * IP_MULTIPLIER;
  return pack(limit, d.count, d.resetAt, i.resetAt, ipBlocked);
}
