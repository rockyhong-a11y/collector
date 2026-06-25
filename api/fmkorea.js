// FM코리아 수집 서버리스 함수 v1
// 입력: category (카테고리ID), page (페이지번호), dateFrom, dateTo (YYYY-MM-DD, 빈 값이면 필터 없음)
// 출력: { items: [{title, url, date}], page, hasMore, _htmlLen, _error? }

const UA_LIST = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
];

function todayKST() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10);
}

function parseFmDate(raw, today) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) return today;
  let m = s.match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
  if (m) return `20${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(20\d{2})\.(\d{2})\.(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseArticles(html, today, dateFrom, dateTo) {
  const items = [];
  const seen = new Set();

  const tbodyM = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyM) return { items, hitOld: false };

  const tbody = tbodyM[1];
  const rowRe = /<tr([^>]*)>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  let hitOld = false;

  while ((rowMatch = rowRe.exec(tbody)) !== null) {
    const trAttrs = rowMatch[1];
    const row = rowMatch[2];

    // 공지 행 스킵
    if (/class="[^"]*notice/.test(trAttrs)) continue;

    // 링크: document_srl 포함, # 앵커 없음
    const linkM = row.match(/href="(\/index\.php\?[^"#]*document_srl=(\d+)[^"#]*)"/);
    if (!linkM) continue;
    const href = linkM[1];
    const postUrl = 'https://www.fmkorea.com' + href;
    if (seen.has(postUrl)) continue;
    seen.add(postUrl);

    // 제목: td.title 안의 a 첫 텍스트
    const titleM = row.match(
      /<td[^>]*class="[^"]*title[^"]*"[^>]*>[\s\S]*?<a[^>]*href="[^"#]*document_srl=\d+[^"#]*"[^>]*>([\s\S]*?)<\/a>/i
    );
    const title = titleM ? decodeHtmlEntities(stripTags(titleM[1])) : '';
    if (!title || title.length < 2) continue;

    // 날짜: td.time
    const dateM = row.match(/<td[^>]*class="[^"]*time[^"]*"[^>]*>([^<]+)<\/td>/i);
    const date = parseFmDate(dateM ? dateM[1] : '', today);
    if (!date) continue;

    if (dateFrom && date < dateFrom) { hitOld = true; continue; }
    if (dateTo   && date > dateTo)   continue;

    items.push({ title, url: postUrl, date });
  }

  return { items, hitOld };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { category, page = '1', dateFrom = '', dateTo = '' } = req.query;

  if (category === 'ping') return res.status(200).json({ pong: true, _version: 'v1-fmkorea' });
  if (!category) return res.status(400).json({ error: 'category required' });

  const pageNum = Math.max(1, parseInt(page) || 1);
  const url = `https://www.fmkorea.com/index.php?mid=baseball_game&category=${category}&page=${pageNum}`;
  const today = todayKST();

  // ── 1순위: 직접 fetch (UA별, 각 3s 타임아웃) ──────────────────
  let lastError = '';
  for (const ua of UA_LIST) {
    let html = '';
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(url, {
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9',
          'Referer': 'https://www.fmkorea.com/',
          'Upgrade-Insecure-Requests': '1',
        },
        signal: ctrl.signal,
      });
      clearTimeout(tid);
      html = await r.text();
    } catch (e) {
      lastError = `직접fetch(${ua.slice(11,17)}): ${e.message}`;
      continue;
    }

    if (html.length < 2000 || !html.includes('fmkorea')) {
      lastError = `HTML 짧음 (${html.length}자)`;
      continue;
    }

    const { items, hitOld } = parseArticles(html, today, dateFrom, dateTo);
    return res.status(200).json({ items, page: pageNum, hitOld, _htmlLen: html.length, _via: 'direct' });
  }

  // ── 2순위: allorigins.win 경유 ──────────────────────────────
  const proxies = [
    `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  ];
  for (const px of proxies) {
    let html = '';
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 4000);
      const r    = await fetch(px, { signal: ctrl.signal });
      clearTimeout(tid);
      const text = await r.text();
      try { const j = JSON.parse(text); html = j.contents || ''; } catch { html = text; }
    } catch (e) {
      lastError = `proxy(${px.slice(8, 28)}): ${e.message}`;
      continue;
    }

    if (html.length < 2000 || !html.includes('fmkorea')) {
      lastError = `proxy HTML 짧음 (${html.length}자)`;
      continue;
    }

    const { items, hitOld } = parseArticles(html, today, dateFrom, dateTo);
    return res.status(200).json({ items, page: pageNum, hitOld, _htmlLen: html.length, _via: 'proxy' });
  }

  return res.status(200).json({
    items: [],
    page: pageNum,
    hitOld: false,
    _error: lastError || '직접접근/프록시 모두 실패',
  });
}
