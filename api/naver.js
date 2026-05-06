// Naver Cafe 수집 — apis.naver.com 내부 JSON API (v6)
//
// 수집 흐름:
//   1순위: apis.naver.com/cafe-web/cafe2/ArticleListV2.json  (JSON, 로그인 불필요)
//   2순위: cafe.naver.com/ca-fe/cafes/{id}/menus/{menuId}/articles (JSON)
//   3순위: cafe.naver.com/ArticleList.nhn HTML 파싱
//
// 파라미터:
//   cafeId  — 카페 숫자 ID (27851354 / 28683505)
//   menuId  — 메뉴 ID (0=전체, 31=버그신고, 33=제보, 15=건의 등)
//   dateFrom, dateTo — YYYY-MM-DD
//   start   — 시작 인덱스 (페이지네이션)

const PER_PAGE = 50;
const MAX_PAGES = 20; // 최대 1000건

const CAFE_SLUGS = {
  '27851354': 'com2usbaseball2015',
  '28683505': 'mlb9innings',
};

function pad2(n) { return String(n).padStart(2, '0'); }

function todayKR() {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 - now.getTimezoneOffset()) * 60000);
  return kst.toISOString().slice(0, 10);
}

function shiftDate(baseISO, days) {
  const d = new Date(baseISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseDateText(text, today) {
  if (!text) return null;
  text = String(text).trim();
  if (text === '오늘') return today;
  if (text === '어제') return shiftDate(today, -1);
  if (text === '그저께') return shiftDate(today, -2);
  let m = text.match(/(\d+)\s*시간\s*전/);
  if (m) return new Date(Date.now() - parseInt(m[1]) * 3600000).toISOString().slice(0, 10);
  m = text.match(/(\d+)\s*[분초]\s*전/);
  if (m) return today;
  m = text.match(/(\d+)\s*일\s*전/);
  if (m) return shiftDate(today, -parseInt(m[1]));
  m = text.match(/(20\d{2})[.\-](\d{1,2})[.\-](\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = text.match(/(20\d{2})(\d{2})(\d{2})/);
  if (m && m[2] <= '12' && m[3] <= '31') return `${m[1]}-${m[2]}-${m[3]}`;
  const ts = parseInt(text);
  if (!isNaN(ts) && ts > 1_000_000_000_000) return new Date(ts).toISOString().slice(0, 10);
  if (!isNaN(ts) && ts > 1_000_000_000)     return new Date(ts * 1000).toISOString().slice(0, 10);
  return null;
}

function extractDate(art, today) {
  for (const c of [art.writeDateTimestamp, art.writeDate, art.regDate, art.createdAt, art.publishedAt, art.lastUpdateDate]) {
    const d = parseDateText(c, today);
    if (d) return d;
  }
  return null;
}

// ArticleList.nhn HTML 파싱
function extractFromHtml(html, today, cafeId) {
  const items = [];
  const seen = new Set();
  const slug = CAFE_SLUGS[String(cafeId)] || '';
  const datePat = /(\d+\s*(?:시간|분|일|초)\s*전|어제|그저께|오늘|20\d{2}[.\-]\d{1,2}[.\-]\d{1,2})/;
  const absRe = /https?:\/\/cafe\.naver\.com\/([A-Za-z0-9_]+)\/(\d{5,})/g;
  const relRe = /href="\/([A-Za-z0-9_]+)\/(\d{5,})"/g;

  function tryAdd(cafe, aid, idx) {
    if (slug && cafe !== slug) return;
    const key = `${cafe}/${aid}`;
    if (seen.has(key)) return;
    const before = html.slice(Math.max(0, idx - 1500), idx);
    const after  = html.slice(idx, idx + 1500);
    const dm = after.match(datePat) || before.match(datePat);
    if (!dm) return;
    const date = parseDateText(dm[1], today);
    if (!date) return;
    const win = html.slice(idx, idx + 800)
      .replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
    const texts = win.split('|').map(s => s.trim()).filter(s => s.length >= 4);
    const title = texts.find(t => !/^(?:추천|댓글|조회|신고|더보기|\d+)$/.test(t)) || '';
    seen.add(key);
    items.push({ title, link: `https://cafe.naver.com/${cafe}/${aid}`, description: title, _date: date, postdate: date.replace(/-/g, '') });
  }

  let m;
  while ((m = absRe.exec(html)) !== null) tryAdd(m[1], m[2], m.index);
  while ((m = relRe.exec(html)) !== null) tryAdd(m[1], m[2], m.index);
  return items;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

async function fetchCafeArticles(cafeId, menuId, dateFrom, dateTo, startPage) {
  const today = todayKR();
  const all   = [];
  const seen  = new Set();
  const debug = { firstStatus: null, firstError: null, firstHtmlSize: 0, firstCardCount: null, firstSnippet: '', method: null };
  const slug  = CAFE_SLUGS[String(cafeId)] || String(cafeId);

  function consume(arts, slugFn) {
    let hitOld = false;
    for (const art of arts) {
      const date = extractDate(art, today);
      if (!date) continue;
      if (dateFrom && date < dateFrom) { hitOld = true; continue; }
      if (dateTo   && date > dateTo)   continue;
      const artId   = art.articleId || art.id || '';
      const artSlug = slugFn(art);
      const link    = artId ? `https://cafe.naver.com/${artSlug}/${artId}` : '';
      if (!link || seen.has(link)) continue;
      seen.add(link);
      all.push({ title: art.subject || art.title || '', link, description: art.contentSummary || art.summary || '', _date: date, postdate: date.replace(/-/g, '') });
    }
    return hitOld;
  }

  // ── 방법 1: apis.naver.com ArticleListV2 ─────────────────────
  debug.method = 'apis-articlelistv2';
  let failed1 = false;

  for (let i = 0; i < MAX_PAGES; i++) {
    const p = new URLSearchParams({ cafeId, menuId: menuId || 0, currentPage: startPage + i, pageSize: PER_PAGE, orderBy: 'CreateDate' });
    const url = `https://apis.naver.com/cafe-web/cafe2/ArticleListV2.json?${p}`;
    let data;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json,*/*', 'Accept-Language': 'ko-KR,ko;q=0.9', 'Referer': `https://cafe.naver.com/${slug}`, 'Origin': 'https://cafe.naver.com' } });
      if (i === 0) debug.firstStatus = r.status;
      if (!r.ok) { if (i === 0) debug.firstError = `apis HTTP ${r.status}`; failed1 = true; break; }
      if (!(r.headers.get('content-type') || '').includes('json')) {
        const html = await r.text();
        if (i === 0) { debug.firstHtmlSize = html.length; debug.firstError = `apis non-JSON (${html.length}B)`; debug.firstSnippet = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200); }
        failed1 = true; break;
      }
      data = await r.json();
    } catch (e) { if (i === 0) debug.firstError = `apis: ${e.message}`; failed1 = true; break; }

    const arts = data?.message?.result?.articleList || data?.result?.articleList || data?.articleList || data?.articles || (Array.isArray(data) ? data : []);
    if (i === 0) { debug.firstCardCount = arts.length; if (!arts.length) debug.firstSnippet = JSON.stringify(data).slice(0, 300); }
    if (!arts.length) break;
    if (consume(arts, a => a.cafeUrl || slug) || arts.length < PER_PAGE) break;
  }

  if (all.length > 0 || !failed1) return { items: all, debug };

  // ── 방법 2: ca-fe JSON API ────────────────────────────────────
  debug.method = 'ca-fe-json';
  const err1 = debug.firstError;
  debug.firstError = null;
  let failed2 = false;

  for (let i = 0; i < MAX_PAGES; i++) {
    const mp  = menuId ? `/menus/${menuId}` : '';
    const url = `https://cafe.naver.com/ca-fe/cafes/${encodeURIComponent(cafeId)}${mp}/articles?page=${startPage + i}&perPage=${PER_PAGE}&orderBy=date`;
    let data;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json,*/*', 'Accept-Language': 'ko-KR,ko;q=0.9', 'Referer': `https://cafe.naver.com/${slug}` } });
      if (i === 0) debug.firstStatus = r.status;
      if (!r.ok) { if (i === 0) debug.firstError = `ca-fe HTTP ${r.status} (apis: ${err1})`; failed2 = true; break; }
      if (!(r.headers.get('content-type') || '').includes('json')) {
        const html = await r.text();
        if (i === 0) { debug.firstError = `ca-fe non-JSON ${html.length}B`; debug.firstSnippet = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200); }
        failed2 = true; break;
      }
      data = await r.json();
    } catch (e) { if (i === 0) debug.firstError = `ca-fe: ${e.message}`; failed2 = true; break; }

    const arts = data?.result?.articleList || data?.articles || (Array.isArray(data) ? data : []);
    if (i === 0) { debug.firstCardCount = arts.length; if (!arts.length) debug.firstSnippet = JSON.stringify(data).slice(0, 300); }
    if (!arts.length) break;
    if (consume(arts, a => a.cafeUrl || slug) || arts.length < PER_PAGE) break;
  }

  if (all.length > 0 || !failed2) return { items: all, debug };

  // ── 방법 3: ArticleList.nhn HTML ─────────────────────────────
  debug.method = 'html-articlelist';
  const err2 = debug.firstError;
  debug.firstError = null;

  for (let i = 0; i < MAX_PAGES; i++) {
    const p = new URLSearchParams({ 'search.clubid': cafeId, 'search.sortby': 'date', 'search.page': startPage + i, 'search.perPage': PER_PAGE });
    if (menuId) p.set('search.menuid', menuId);
    const url = `https://cafe.naver.com/ArticleList.nhn?${p}`;
    let html;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'ko-KR,ko;q=0.9', 'Referer': `https://cafe.naver.com/${slug}` } });
      if (i === 0) debug.firstStatus = r.status;
      if (!r.ok) { if (i === 0) debug.firstError = `HTML HTTP ${r.status} (ca-fe: ${err2})`; break; }
      html = await r.text();
    } catch (e) { if (i === 0) debug.firstError = `HTML: ${e.message}`; break; }

    const items = extractFromHtml(html, today, cafeId);
    if (i === 0) {
      debug.firstHtmlSize  = html.length;
      debug.firstCardCount = items.length;
      if (!items.length) debug.firstSnippet = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    }
    let hitOld = false;
    for (const it of items) {
      if (seen.has(it.link)) continue;
      seen.add(it.link);
      if (dateFrom && it._date < dateFrom) { hitOld = true; continue; }
      if (dateTo   && it._date > dateTo)   continue;
      all.push(it);
    }
    if (hitOld || !items.length || items.length < PER_PAGE) break;
  }

  return { items: all, debug };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { keyword = '', cafeId = '', menuId = '0', dateFrom = '', dateTo = '', start = '1' } = req.query;

  if (keyword === 'ping') return res.status(200).json({ pong: true, _version: 'v6-apis-json' });
  if (!cafeId) return res.status(400).json({ error: 'cafeId 필요' });

  const startPage  = Math.max(1, Math.ceil((parseInt(start) || 1) / PER_PAGE));
  const menuIdNum  = parseInt(menuId) || 0;

  try {
    const { items, debug } = await fetchCafeArticles(cafeId, menuIdNum, dateFrom, dateTo, startPage);
    res.status(200).json({ items, _rawCount: items.length, _anchors: items.length, _interpolated: 0, _noInfo: 0, _source: `cafe.naver.com(${debug.method})`, _version: 'v6-apis-json', _debug: debug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
