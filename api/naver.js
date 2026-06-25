// Naver Cafe 수집 v10 — cafe-boardlist-api (쿠키 불필요, 공개 카페)
//
// 수집 흐름:
//   1순위: cafe-boardlist-api REST API (JSON, 쿠키 없이 동작)
//   2순위: f-e SSR HTML 파싱 (fallback)
//
// 파라미터:
//   cafeId   — 카페 숫자 ID
//   menuId   — 메뉴 ID (0=전체)
//   display  — 한 번에 반환할 최대 건수 (기본 100)
//   start    — 시작 인덱스 (1, 101, 201 … 클라이언트 페이지네이션)
//   dateFrom, dateTo — YYYY-MM-DD (빈 값이면 날짜 필터 없음)
//   cookie   — 네이버 세션 쿠키 (선택, 현재 미사용)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const EXCLUDE_KEYWORDS = ['[안내]', '[이벤트]', '필독', '[공지]', 'CM', 'GM'];

const CAFE_SLUGS = {
  '27851354': 'com2usbaseball2015',
  '28683505': 'mlb9innings',
};

const BOARDLIST_API = 'https://apis.naver.com/cafe-web/cafe-boardlist-api';
const NAVER_PAGE_SIZE = 50;

function todayKST() {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 - now.getTimezoneOffset()) * 60000);
  return kst.toISOString().slice(0, 10);
}

function tsToKSTDate(ts) {
  if (!ts) return null;
  const num = typeof ts === 'string' ? parseInt(ts) : ts;
  if (isNaN(num)) return null;
  const ms = num > 1e12 ? num : num * 1000;
  const kst = new Date(ms + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10);
}

function parseDateText(text, today) {
  if (!text) return null;
  text = String(text).trim();
  if (/^\d{1,2}:\d{2}$/.test(text)) return today;
  let m = text.match(/^(20\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})$/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = text.match(/^(\d{2})[.\-/](\d{2})[.\-/](\d{2})$/);
  if (m) return `20${m[1]}-${m[2]}-${m[3]}`;
  const ts = parseInt(text);
  if (!isNaN(ts) && ts > 1e12) return tsToKSTDate(ts);
  if (!isNaN(ts) && ts > 1e9)  return tsToKSTDate(ts * 1000);
  return null;
}

function shouldExclude(title) {
  return EXCLUDE_KEYWORDS.some(k => title.includes(k));
}

function extractNextData(html) {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

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

// ── 1순위: cafe-boardlist-api (쿠키 불필요) ──────────────────────
async function fetchBoardlistPage(cafeId, menuId, page, perPage = 20) {
  const mid = parseInt(menuId) || 0;
  const url = `${BOARDLIST_API}/v1/cafes/${cafeId}/menus/${mid}/articles?page=${page}&perPage=${perPage}`;
  const headers = {
    'User-Agent': UA,
    'Accept': 'application/json',
    'Accept-Language': 'ko-KR,ko;q=0.9',
    'Referer': 'https://cafe.naver.com/',
  };
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  if (!json) return null;
  const list = json?.result?.articleList || null;
  const pageInfo = json?.result?.pageInfo || null;
  return { list, pageInfo };
}

// ── 2순위: f-e SSR HTML 파싱 ────────────────────────────────────
async function fetchNaverPage(cafeId, menuId, page, sessionCookie) {
  const mid = parseInt(menuId) || 0;
  const url = `https://cafe.naver.com/f-e/cafes/${cafeId}/menus/${mid}?page=${page}`;
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9',
    'Cache-Control': 'no-cache',
    'Referer': 'https://cafe.naver.com/',
  };
  if (sessionCookie) headers['Cookie'] = sessionCookie;
  const res = await fetch(url, { headers });
  const html = await res.text();
  return { ok: res.ok, status: res.status, html };
}

function parseArticlesFromPage(html, slug, today) {
  const items = [];

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

  const artRe = new RegExp(`href="(?:https://cafe\\.naver\\.com)?/${slug}/(\\d{5,})"`, 'g');
  const seen = new Set();
  let m;
  while ((m = artRe.exec(html)) !== null) {
    const artId = m[1];
    if (seen.has(artId)) continue;
    seen.add(artId);
    const idx = m.index;
    const ctx = html.slice(Math.max(0, idx - 600), idx + 600);
    const dateM = ctx.match(/(\d{1,2}:\d{2}|20\d{2}\.\d{2}\.\d{2}|\d{2}\.\d{2}\.\d{2})/);
    const date = dateM ? parseDateText(dateM[1], today) : null;
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

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

  if (keyword === 'ping') return res.status(200).json({ pong: true, _version: 'v10-boardlist-api' });
  if (!cafeId) return res.status(400).json({ error: 'cafeId 필요' });

  const today     = todayKST();
  const slug      = CAFE_SLUGS[String(cafeId)] || String(cafeId);
  const maxItems  = Math.min(200, parseInt(display) || 100);
  const startIdx  = Math.max(1, parseInt(start) || 1);

  const batch          = Math.floor((startIdx - 1) / maxItems);
  // 페이지당 실제 반환 건수가 NAVER_PAGE_SIZE보다 적을 수 있으므로 여유 있게 설정
  const pagesPerBatch  = Math.ceil(maxItems / 10);
  const startNaverPage = batch * pagesPerBatch + 1;

  const debug = {
    firstStatus: null, firstError: null,
    firstCardCount: null, firstSnippet: '', method: null, pages: 0,
  };

  const allItems = [];
  const seen     = new Set();
  let methodUsed = 'none';

  // ── 1순위: boardlist-api ─────────────────────────────────────
  for (let p = startNaverPage; p < startNaverPage + pagesPerBatch; p++) {
    let result = null;
    try {
      result = await fetchBoardlistPage(cafeId, menuId, p, NAVER_PAGE_SIZE);
    } catch (e) {
      if (p === startNaverPage) debug.firstError = `boardlist-api: ${e.message}`;
      break;
    }

    debug.pages++;
    if (p === startNaverPage) debug.method = 'boardlist-api';

    if (!result || !result.list) {
      if (p === startNaverPage) debug.firstError = debug.firstError || 'boardlist-api: null 응답';
      break;
    }

    const { list, pageInfo } = result;
    if (p === startNaverPage) debug.firstCardCount = list.length;
    if (!list.length) break;

    let hitOld = false;
    for (const entry of list) {
      const item = entry.item || entry;
      const artId = item.articleId || item.id;
      if (!artId) continue;

      const link = `https://cafe.naver.com/${slug}/${artId}`;
      if (seen.has(link)) continue;
      seen.add(link);

      const title = String(item.subject || item.title || '').trim();
      if (!title || shouldExclude(title)) continue;

      const tsRaw = item.writeDateTimestamp || item.writeDate || item.addDate || '';
      const _date = tsRaw ? (tsToKSTDate(tsRaw) || parseDateText(String(tsRaw), today) || today) : today;

      if (dateFrom && _date < dateFrom) { hitOld = true; continue; }
      if (dateTo   && _date > dateTo)   continue;
      if (allItems.length >= maxItems) break;

      allItems.push({
        title,
        link,
        description: String(item.summary || item.contentSummary || '').replace(/<[^>]+>/g, ' ').trim(),
        _date,
        postdate: _date.replace(/-/g, ''),
      });
    }

    const hasMore = pageInfo?.visibleNextButton !== false;
    if (hitOld || allItems.length >= maxItems || !hasMore) break;
  }

  if (allItems.length > 0 || debug.method === 'boardlist-api') {
    methodUsed = 'boardlist-api';
  }

  // ── 2순위: f-e SSR HTML (boardlist 실패 시) ─────────────────
  if (allItems.length === 0 && debug.firstError) {
    const seenFe = new Set();
    for (let p = startNaverPage; p < startNaverPage + pagesPerBatch; p++) {
      let result;
      try {
        result = await fetchNaverPage(cafeId, menuId, p, cookie || null);
      } catch (e) {
        if (p === startNaverPage) debug.firstError += ` / fetch: ${e.message}`;
        break;
      }

      debug.pages++;
      if (p === startNaverPage) {
        debug.firstStatus = result.status;
      }

      if (!result.ok) {
        if (p === startNaverPage) debug.firstError += ` / HTTP ${result.status}`;
        break;
      }

      const pageItems = parseArticlesFromPage(result.html, slug, today);

      if (p === startNaverPage) {
        debug.firstCardCount = debug.firstCardCount ?? pageItems.length;
        debug.method = debug.method || (pageItems[0]?._method || 'f-e-ssr');
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
        if (seenFe.has(item.link)) continue;
        seenFe.add(item.link);
        if (dateFrom && item._date < dateFrom) { hitOld = true; continue; }
        if (dateTo   && item._date > dateTo)   continue;
        if (allItems.length >= maxItems) break;
        const { _method, ...rest } = item;
        allItems.push(rest);
      }

      if (hitOld || allItems.length >= maxItems) break;
    }

    if (allItems.length > 0) methodUsed = debug.method || 'f-e-ssr';
  }

  return res.status(200).json({
    items:          allItems,
    _rawCount:      allItems.length,
    _anchors:       allItems.length,
    _interpolated:  0,
    _noInfo:        0,
    _source:        'cafe.naver.com',
    _version:       'v10-boardlist-api',
    _method:        methodUsed,
    _debug:         debug,
  });
}
