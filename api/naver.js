// Naver Cafe 수집 v8 — f-e Next.js SSR 파싱
//
// 수집 흐름:
//   1순위: f-e URL __NEXT_DATA__ JSON 파싱
//   2순위: f-e URL HTML article 링크 파싱
//
// 파라미터:
//   cafeId   — 카페 숫자 ID
//   menuId   — 메뉴 ID (0=전체)
//   display  — 한 번에 반환할 최대 건수 (기본 100)
//   start    — 시작 인덱스 (1, 101, 201 … 클라이언트 페이지네이션)
//   dateFrom, dateTo — YYYY-MM-DD (빈 값이면 날짜 필터 없음)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const EXCLUDE_KEYWORDS = ['[안내]', '[이벤트]', '필독', '[공지]', 'CM', 'GM'];

const CAFE_SLUGS = {
  '27851354': 'com2usbaseball2015',
  '28683505': 'mlb9innings',
};

// Naver f-e 페이지당 기본 20건 → display=100 이면 5페이지 fetch
const NAVER_FE_PAGE_SIZE = 20;

function todayKST() {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 - now.getTimezoneOffset()) * 60000);
  return kst.toISOString().slice(0, 10);
}

// HH:MM → today / YY.MM.DD → 20YY-MM-DD / YYYY.MM.DD → YYYY-MM-DD / 타임스탬프
function parseDateText(text, today) {
  if (!text) return null;
  text = String(text).trim();
  if (/^\d{1,2}:\d{2}$/.test(text)) return today;
  let m = text.match(/^(20\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})$/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = text.match(/^(\d{2})[.\-/](\d{2})[.\-/](\d{2})$/);
  if (m) return `20${m[1]}-${m[2]}-${m[3]}`;
  const ts = parseInt(text);
  if (!isNaN(ts) && ts > 1e12) return new Date(ts).toISOString().slice(0, 10);
  if (!isNaN(ts) && ts > 1e9)  return new Date(ts * 1000).toISOString().slice(0, 10);
  return null;
}

function shouldExclude(title) {
  return EXCLUDE_KEYWORDS.some(k => title.includes(k));
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Next.js SSR __NEXT_DATA__ 추출
function extractNextData(html) {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// __NEXT_DATA__ 내 게시글 배열 재귀 탐색
function findArticleList(obj, depth = 0) {
  if (depth > 10 || !obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    if (obj.length > 0 && obj[0] && (obj[0].articleId || obj[0].id) &&
        (obj[0].subject || obj[0].title)) return obj;
    for (const item of obj) {
      const found = findArticleList(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const key of ['articleList', 'articles', 'list', 'items', 'data', 'result', 'pageProps']) {
    if (obj[key]) {
      const found = findArticleList(obj[key], depth + 1);
      if (found) return found;
    }
  }
  for (const val of Object.values(obj)) {
    if (typeof val === 'object') {
      const found = findArticleList(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function fetchNaverPage(cafeId, menuId, page, sessionCookie) {
  const mid = parseInt(menuId) || 0;
  const url = `https://cafe.naver.com/f-e/cafes/${cafeId}/menus/${mid}?page=${page}`;
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
    'Cache-Control': 'no-cache',
    'Referer': 'https://cafe.naver.com/',
  };
  if (sessionCookie) headers['Cookie'] = sessionCookie;
  const res = await fetch(url, { headers });
  const html = await res.text();
  return { ok: res.ok, status: res.status, html, url };
}

// 한 Naver 페이지 HTML에서 게시글 추출
function parseArticlesFromPage(html, slug, today) {
  const items = [];

  // 방법 1: __NEXT_DATA__ JSON
  const nextData = extractNextData(html);
  if (nextData) {
    const arts = findArticleList(nextData?.props?.pageProps) || findArticleList(nextData);
    if (arts && arts.length > 0) {
      for (const art of arts) {
        const artId = String(art.articleId || art.id || '').trim();
        const title = String(art.subject || art.title || '').trim();
        if (!artId || !title || shouldExclude(title)) continue;
        const dateRaw = art.writeDateTimestamp || art.writeDate || art.lastUpdateDate || art.regDate || art.createdAt || '';
        const date = parseDateText(String(dateRaw), today);
        items.push({
          title,
          link: `https://cafe.naver.com/${slug}/${artId}`,
          description: String(art.contentSummary || art.summary || '').replace(/<[^>]+>/g, ' ').trim(),
          _date: date || today,
          postdate: (date || today).replace(/-/g, ''),
          _method: 'next-data',
        });
      }
      return items;
    }
  }

  // 방법 2: HTML article 링크 파싱
  const artRe = new RegExp(`href="(?:https://cafe\\.naver\\.com)?/${slug}/(\\d{5,})"`, 'g');
  const seen = new Set();
  let m;
  while ((m = artRe.exec(html)) !== null) {
    const artId = m[1];
    if (seen.has(artId)) continue;
    seen.add(artId);

    const idx = m.index;
    const before = html.slice(Math.max(0, idx - 600), idx);
    const after  = html.slice(idx, idx + 600);
    const ctx    = before + after;

    // 날짜 추출: HH:MM / YY.MM.DD / YYYY.MM.DD
    const dateM = ctx.match(/(\d{1,2}:\d{2}|20\d{2}\.\d{2}\.\d{2}|\d{2}\.\d{2}\.\d{2})/);
    const date = dateM ? parseDateText(dateM[1], today) : null;

    // 제목 추출: article/tit/title 클래스명 근처 텍스트
    const titleM = ctx.match(/class="[^"]*(?:article|tit|title|subject)[^"]*"[^>]*>(?:<[^>]+>)*([^<]{4,120})/);
    const title = titleM ? titleM[1].trim() : '';
    if (!title || shouldExclude(title)) continue;

    items.push({
      title,
      link: `https://cafe.naver.com/${slug}/${artId}`,
      description: '',
      _date: date || today,
      postdate: (date || today).replace(/-/g, ''),
      _method: 'html-parse',
    });
  }
  return items;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const {
    keyword  = '',
    cafeId   = '',
    menuId   = '0',
    display  = '100',
    start    = '1',
    dateFrom = '',
    dateTo   = '',
    cookie   = '',
  } = req.query;

  if (keyword === 'ping') return res.status(200).json({ pong: true, _version: 'v8-fe-ssr' });
  if (!cafeId) return res.status(400).json({ error: 'cafeId 필요' });

  const today      = todayKST();
  const slug       = CAFE_SLUGS[String(cafeId)] || String(cafeId);
  const maxItems   = Math.min(200, parseInt(display) || 100);
  const startIdx   = Math.max(1, parseInt(start) || 1);

  // start 인덱스 → Naver 시작 페이지
  // start=1   → page=1, start=101 → page=6 (NAVER_FE_PAGE_SIZE=20 기준)
  const batch          = Math.floor((startIdx - 1) / maxItems);
  const pagesPerBatch  = Math.ceil(maxItems / NAVER_FE_PAGE_SIZE);
  const startNaverPage = batch * pagesPerBatch + 1;

  const debug = {
    firstStatus: null, firstError: null, htmlSize: 0,
    firstCardCount: null, firstSnippet: '', method: null, pages: 0,
  };

  const allItems = [];
  const seen     = new Set();

  for (let p = startNaverPage; p < startNaverPage + pagesPerBatch; p++) {
    let result;
    try {
      result = await fetchNaverPage(cafeId, menuId, p, cookie || null);
    } catch (e) {
      if (p === startNaverPage) debug.firstError = `fetch: ${e.message}`;
      break;
    }

    debug.pages++;
    if (p === startNaverPage) {
      debug.firstStatus = result.status;
      debug.htmlSize    = result.html.length;
    }

    if (!result.ok) {
      if (p === startNaverPage) debug.firstError = `HTTP ${result.status}`;
      break;
    }

    const pageItems = parseArticlesFromPage(result.html, slug, today);

    if (p === startNaverPage) {
      debug.firstCardCount = pageItems.length;
      debug.method         = pageItems[0]?._method || 'none';
      if (!pageItems.length) {
        debug.firstSnippet = result.html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300);
      }
    }

    if (!pageItems.length) break;

    let hitOld = false;
    for (const item of pageItems) {
      if (seen.has(item.link)) continue;
      seen.add(item.link);

      if (dateFrom && item._date < dateFrom) { hitOld = true; continue; }
      if (dateTo   && item._date > dateTo)   continue;
      if (allItems.length >= maxItems) break;

      const { _method, ...rest } = item;
      allItems.push(rest);
    }

    if (hitOld || allItems.length >= maxItems) break;
  }

  return res.status(200).json({
    items:          allItems,
    _rawCount:      allItems.length,
    _anchors:       allItems.length,
    _interpolated:  0,
    _noInfo:        0,
    _source:        'cafe.naver.com(f-e-ssr)',
    _version:       'v8-fe-ssr',
    _debug:         debug,
  });
}
