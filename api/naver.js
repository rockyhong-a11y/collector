// Naver Cafe 수집 — ca-fe 내부 JSON API
//
// 배경:
//   - search.naver.com 카페 탭: JS 동적 렌더링 → HTML에 링크 없음
//   - cafe.naver.com/ArticleList.nhn: 동일하게 JS 렌더링 ("로딩중...")
//   → Naver 프론트엔드가 사용하는 내부 JSON API 직접 호출로 전환
//
// 엔드포인트:
//   GET https://cafe.naver.com/ca-fe/cafes/{cafeId}/articles
//     ?page={n}&perPage=50&orderBy=date
//
// 날짜 필터링:
//   API 응답의 writeDateTimestamp or writeDate로 날짜 확인
//   기간 밖 글 발견 즉시 중단 (날짜 내림차순 정렬 가정)

const PER_PAGE = 50;
const MAX_PAGES = 6;   // 최대 300건

// slug 맵 — URL 추출 시 확인된 실제 카페 슬러그
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
  text = text.trim();
  if (text === '오늘') return today;
  if (text === '어제') return shiftDate(today, -1);
  if (text === '그저께') return shiftDate(today, -2);
  let m = text.match(/(\d+)\s*시간\s*전/);
  if (m) {
    const hrs = parseInt(m[1]);
    const now = new Date();
    now.setHours(now.getHours() - hrs);
    return now.toISOString().slice(0, 10);
  }
  m = text.match(/(\d+)\s*분\s*전/);
  if (m) return today;
  m = text.match(/(\d+)\s*초\s*전/);
  if (m) return today;
  m = text.match(/(\d+)\s*일\s*전/);
  if (m) return shiftDate(today, -parseInt(m[1]));
  m = text.match(/(20\d{2})\.(\d{1,2})\.(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  // YYYY-MM-DD 형식
  m = text.match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // timestamp (ms)
  const ts = parseInt(text);
  if (!isNaN(ts) && ts > 1000000000000) {
    return new Date(ts).toISOString().slice(0, 10);
  }
  return null;
}

// JSON 응답에서 날짜 추출
function extractDateFromArticle(art, today) {
  const candidates = [
    art.writeDate,
    art.writeDateTimestamp && String(art.writeDateTimestamp),
    art.regDate,
    art.createdAt,
    art.publishedAt,
  ];
  for (const c of candidates) {
    const d = parseDateText(String(c || ''), today);
    if (d) return d;
  }
  return null;
}

// HTML fallback: ArticleList.nhn 스크래핑 (만약 ca-fe API가 막히는 경우)
function extractFromHtml(html, today, cafeId) {
  const items = [];
  const seen  = new Set();
  const slug  = CAFE_SLUGS[String(cafeId)] || '';

  const datePattern = /(\d+\s*(?:시간|분|일|초)\s*전|어제|그저께|오늘|20\d{2}[.\-]\d{1,2}[.\-]\d{1,2})/;

  // 절대 URL 매칭
  const absRe = /https?:\/\/cafe\.naver\.com\/([A-Za-z0-9_]+)\/(\d{5,})/g;
  // 상대 href 매칭
  const relRe = /href="\/([A-Za-z0-9_]+)\/(\d{5,})"/g;

  function tryAdd(cafe, aid, idx) {
    if (slug && cafe !== slug) return;   // 다른 카페 링크 무시
    const key = `${cafe}/${aid}`;
    if (seen.has(key)) return;
    const before = html.slice(Math.max(0, idx - 1500), idx);
    const after  = html.slice(idx, idx + 1500);
    const dm = after.match(datePattern) || before.match(datePattern);
    if (!dm) return;
    const date = parseDateText(dm[1], today);
    if (!date) return;

    const win = html.slice(idx, idx + 800)
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
    const texts = win.split('|').map(s => s.trim()).filter(s => s.length >= 4);
    const title = texts.find(t => !/^(?:추천|댓글|조회|신고|더보기|\d+)$/.test(t)) || '';

    seen.add(key);
    items.push({
      title,
      link: `https://cafe.naver.com/${cafe}/${aid}`,
      description: title,
      cafename: cafe,
      _date: date,
      postdate: date.replace(/-/g, ''),
    });
  }

  let m;
  while ((m = absRe.exec(html)) !== null) tryAdd(m[1], m[2], m.index);
  while ((m = relRe.exec(html)) !== null) tryAdd(m[1], m[2], m.index);
  return items;
}

async function fetchCafeArticles(cafeId, dateFrom, dateTo, startParam = 1) {
  const today  = todayKR();
  const all    = [];
  const seen   = new Set();
  const debug  = {
    firstStatus: null, firstError: null, firstHtmlSize: 0,
    firstCardCount: null, firstSnippet: '', method: null,
  };

  const startPage = Math.max(1, Math.floor((startParam - 1) / PER_PAGE) + 1);
  const slug = CAFE_SLUGS[String(cafeId)] || '';

  // ── 방법 1: ca-fe 내부 JSON API ─────────────────────────────
  debug.method = 'ca-fe-json';
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = startPage + i;
    const url  = `https://cafe.naver.com/ca-fe/cafes/${encodeURIComponent(cafeId)}/articles`
               + `?page=${page}&perPage=${PER_PAGE}&orderBy=date`;

    let data;
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'ko-KR,ko;q=0.9',
          'Referer': `https://cafe.naver.com/${slug || cafeId}`,
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin',
        },
      });
      if (i === 0) debug.firstStatus = r.status;
      if (!r.ok) {
        if (i === 0) debug.firstError = `ca-fe API HTTP ${r.status}`;
        break;
      }
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('json')) {
        const html = await r.text();
        if (i === 0) {
          debug.firstHtmlSize  = html.length;
          debug.firstCardCount = 0;
          debug.firstError = `ca-fe API returned HTML not JSON (${html.length}B)`;
          debug.firstSnippet = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
        }
        break;
      }
      data = await r.json();
    } catch (e) {
      if (i === 0) debug.firstError = `ca-fe API fetch failed: ${e.name}: ${e.message}`;
      break;
    }

    // JSON 구조: { result: { articleList: [...], totalCount: N } }
    // 또는 { articles: [...] } 등 여러 패턴 시도
    const arts = (data?.result?.articleList)
              || (data?.articles)
              || (data?.data?.articles)
              || (Array.isArray(data) ? data : []);

    if (i === 0) {
      debug.firstCardCount = arts.length;
      if (arts.length === 0) {
        debug.firstSnippet = JSON.stringify(data).slice(0, 300);
      }
    }

    if (!arts.length) break;

    let added = 0, hitOldDate = false;
    for (const art of arts) {
      const date = extractDateFromArticle(art, today);
      if (!date) continue;
      if (dateFrom && date < dateFrom) { hitOldDate = true; continue; }
      if (dateTo   && date > dateTo)   continue;

      const artId  = art.articleId || art.id || '';
      const artSlug = art.cafeUrl || slug || cafeId;
      const link   = artId ? `https://cafe.naver.com/${artSlug}/${artId}` : '';
      if (!link || seen.has(link)) continue;
      seen.add(link);

      all.push({
        title:       art.subject || art.title || '',
        link,
        description: art.contentSummary || art.summary || '',
        cafename:    artSlug,
        _date:       date,
        postdate:    date.replace(/-/g, ''),
      });
      added++;
    }

    if (hitOldDate || arts.length < PER_PAGE) break;
    if (added === 0 && arts.length > 0) break;  // 날짜 범위 밖 전체
  }

  // ── 방법 2: HTML fallback (ca-fe 실패 시) ───────────────────
  if (all.length === 0 && debug.firstError) {
    const savedErr = debug.firstError;
    debug.method = 'html-fallback';
    debug.firstError = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = startPage + i;
      const url  = `https://cafe.naver.com/ArticleList.nhn`
                 + `?search.clubid=${encodeURIComponent(cafeId)}`
                 + `&search.sortby=date&search.page=${page}&search.perPage=${PER_PAGE}`;
      let html;
      try {
        const r = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
            'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
            'Accept-Language': 'ko-KR,ko;q=0.9',
            'Referer': `https://cafe.naver.com/${slug || cafeId}`,
          },
        });
        if (i === 0) debug.firstStatus = r.status;
        if (!r.ok) {
          if (i === 0) debug.firstError = `HTML fallback HTTP ${r.status} — ca-fe 원래오류: ${savedErr}`;
          break;
        }
        html = await r.text();
      } catch (e) {
        if (i === 0) debug.firstError = `HTML fallback fetch: ${e.message}`;
        break;
      }

      const items = extractFromHtml(html, today, cafeId);
      if (i === 0) {
        debug.firstHtmlSize  = html.length;
        debug.firstCardCount = items.length;
        if (items.length === 0) {
          debug.firstSnippet = html.replace(/<script[\s\S]*?<\/script>/g, '')
            .replace(/<style[\s\S]*?<\/style>/g, '')
            .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
        }
      }

      let added = 0, hitOldDate = false;
      for (const it of items) {
        if (seen.has(it.link)) continue;
        seen.add(it.link);
        if (dateFrom && it._date < dateFrom) { hitOldDate = true; continue; }
        if (dateTo   && it._date > dateTo)   continue;
        all.push(it);
        added++;
      }
      if (hitOldDate || items.length === 0 || items.length < PER_PAGE) break;
    }
  }

  return { items: all, debug };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const {
    keyword  = '',
    cafeId   = '',
    dateFrom = '',
    dateTo   = '',
    start    = '1',
  } = req.query;

  // ping 요청 처리 (keyword=ping, cafeId 없음)
  if (keyword === 'ping') {
    return res.status(200).json({ pong: true, _version: 'v5-cafe-json' });
  }

  if (!cafeId) return res.status(400).json({ error: 'cafeId 필요' });

  const startParam = parseInt(start) || 1;

  try {
    const { items, debug } = await fetchCafeArticles(cafeId, dateFrom, dateTo, startParam);
    res.status(200).json({
      items,
      _rawCount: items.length,
      _anchors:  items.length,
      _interpolated: 0,
      _noInfo: 0,
      _source:  `cafe.naver.com(${debug.method})`,
      _version: 'v5-cafe-json',
      _debug:   debug,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
