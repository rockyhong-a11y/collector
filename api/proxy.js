// Vercel 서버리스 프록시 — 공식 커뮤니티/DC 게시판의 CORS 회피용
// 공개 프록시(corsproxy.io, allorigins.win) 장애 시 1순위로 사용

export const config = {
  api: { bodyParser: false },
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url, referer } = req.query;
  if (!url) return res.status(400).json({ error: 'url query required' });

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/html, */*;q=0.9',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
    };
    if (referer) headers['Referer'] = referer;

    const opts = { method: req.method, headers };

    if (req.method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      headers['X-Requested-With'] = 'XMLHttpRequest';
      opts.body = await readBody(req);
    }

    const upstream = await fetch(url, opts);
    const text = await upstream.text();
    const ct = upstream.headers.get('content-type') || 'text/plain; charset=utf-8';
    res.setHeader('Content-Type', ct);
    res.status(upstream.status).send(text);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
