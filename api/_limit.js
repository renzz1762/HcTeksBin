// Rate limit per perangkat + plafon per IP. Jendela tetap 24 jam sejak paste pertama.
// LIMITED_SETTING (env Vercel) = batas paste per perangkat per 24 jam. Default 10.
// Penyimpanan: Upstash Redis kalau env-nya ada (disarankan), kalau tidak pakai memori (kurang andal).

const WINDOW_MS = 24 * 60 * 60 * 1000;
const IP_MULTIPLIER = 10; // plafon per IP = LIMITED_SETTING x 10 (wifi/kuota bersama)

const R_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const R_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const HAS_REDIS = Boolean(R_URL && R_TOKEN);

export function getLimit() {
  const n = parseInt(process.env.LIMITED_SETTING, 10);
  return Number.isFinite(n) && n >= 1 ? n : 10;
}

function who(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = xff || String(req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown');
  const dev = String(req.headers['x-device-id'] || '');
  const device = /^[A-Za-z0-9-]{16,64}$/.test(dev) ? dev : 'none-' + ip;
  return { dKey: 'hcp:d:' + device, iKey: 'hcp:i:' + ip };
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
    return { count: v ? parseInt(v, 10) : 0, resetAt: ttl > 0 ? now + ttl : null };
  }
  const [n, ttl] = await redis([['INCR', key], ['PTTL', key]]);
  let t = ttl;
  if (n === 1 || t < 0) { await redis([['PEXPIRE', key, WINDOW_MS]]); t = WINDOW_MS; }
  return { count: n, resetAt: now + t };
}

async function hit(key, consume) {
  const now = Date.now();
  if (HAS_REDIS) {
    try { return await redisHit(key, consume, now); } catch (e) { console.error(e); }
  }
  return memHit(key, consume, now);
}

async function refundKey(key) {
  if (HAS_REDIS) {
    try { await redis([['DECR', key]]); return; } catch (e) { console.error(e); }
  }
  const e = mem.get(key);
  if (e && e.count > 0) e.count--;
}

function pack(limit, dCount, dReset, iReset, ipBlocked) {
  const remaining = ipBlocked ? 0 : Math.max(0, limit - dCount);
  return {
    limit,
    remaining,
    resetAt: dReset || (ipBlocked ? iReset : null),
    serverNow: Date.now()
  };
}

// Dipanggil sebelum membuat paste. Menambah hitungan.
export async function consume(req) {
  const limit = getLimit();
  const { dKey, iKey } = who(req);
  const d = await hit(dKey, true);
  const i = await hit(iKey, true);
  const ipBlocked = i.count > limit * IP_MULTIPLIER;
  const allowed = d.count <= limit && !ipBlocked;
  return { allowed, quota: pack(limit, d.count, d.resetAt, i.resetAt, ipBlocked || d.count > limit) };
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
  const { dKey, iKey } = who(req);
  const d = await hit(dKey, false);
  const i = await hit(iKey, false);
  const ipBlocked = i.count >= limit * IP_MULTIPLIER;
  return pack(limit, d.count, d.resetAt, i.resetAt, ipBlocked);
}
