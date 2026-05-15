// 공유 학습 키워드 API — Vercel KV 기반
// GET  /api/keywords        → 전체 키워드 반환
// POST /api/keywords        → 키워드 추가 (누구나)
// DELETE /api/keywords      → 키워드 삭제 (비밀번호 필요)

export const config = { api: { bodyParser: false } };

const KV_KEY = 'collector:learnedKW';

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function kvGet(url, token) {
  const r = await fetch(`${url}/get/${KV_KEY}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { result } = await r.json();
  try { return JSON.parse(result) || { BUG: [], INQUIRY: [] }; }
  catch { return { BUG: [], INQUIRY: [] }; }
}

async function kvSet(url, token, data) {
  await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['set', KV_KEY, JSON.stringify(data)]]),
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const KV_URL   = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;
  if (!KV_URL || !KV_TOKEN) {
    return res.status(503).json({ error: 'KV not configured' });
  }

  // ── GET ──────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const data = await kvGet(KV_URL, KV_TOKEN);
    return res.status(200).json(data);
  }

  // ── POST (추가) ───────────────────────────────────────────────
  if (req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return res.status(400).json({ error: 'invalid json' }); }
    const { cat, kw } = body || {};
    if (cat !== 'BUG' && cat !== 'INQUIRY') return res.status(400).json({ error: 'invalid cat' });
    const t = String(kw || '').trim().toLowerCase();
    if (!t || t.length < 2) return res.status(400).json({ error: 'too short' });

    const data = await kvGet(KV_URL, KV_TOKEN);
    if (!data[cat].includes(t)) {
      data[cat].push(t);
      await kvSet(KV_URL, KV_TOKEN, data);
    }
    return res.status(200).json(data);
  }

  // ── DELETE (삭제 — 비밀번호 필요) ────────────────────────────
  if (req.method === 'DELETE') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return res.status(400).json({ error: 'invalid json' }); }
    const { cat, kw, clearAll, password } = body || {};

    const DELETE_PW = process.env.KW_DELETE_PASSWORD;
    if (!DELETE_PW || password !== DELETE_PW) {
      return res.status(403).json({ error: 'wrong password' });
    }

    const data = await kvGet(KV_URL, KV_TOKEN);

    if (clearAll) {
      data.BUG = [];
      data.INQUIRY = [];
    } else {
      if (cat !== 'BUG' && cat !== 'INQUIRY') return res.status(400).json({ error: 'invalid cat' });
      const t = String(kw || '').trim().toLowerCase();
      const idx = data[cat].indexOf(t);
      if (idx >= 0) data[cat].splice(idx, 1);
    }

    await kvSet(KV_URL, KV_TOKEN, data);
    return res.status(200).json(data);
  }

  return res.status(405).json({ error: 'method not allowed' });
}
