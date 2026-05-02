// Naver Cafe 수집 — cafe.naver.com/ArticleList.nhn 직접 스크래핑
//
// 배경:
//   search.naver.com 카페 탭은 결과를 JavaScript로 동적 렌더링하게 바뀌어서
//   서버 응답 HTML에 cafe.naver.com/slug/articleId 링크가 전혀 없음 (89KB 껍데기만).
//
// 새 방식:
//   cafe.naver.com/ArticleList.nhn?search.clubid=CAFEID 를 직접 호출.
//   - cafeId: 숫자 ID 그대로 사용 (URL slug 불필요)
//   - 날짜 내림차순 정렬 → 기간을 벗어나는 글이 나오면 중단
//   - 상대 href (/slug/id) 와 절대 URL (https://cafe.naver.com/slug/id) 모두 추출
//   - MAX_PAGES × PER_PAGE_CAFE 건까지 수집 (최대 ~300건)

const PER_PAGE_CAFE = 50;
const MAX_PAGES     = 6;  // 최대 300건

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
  return null;
}

// cafe.naver.com 게시물 목록 HTML 파싱
// - 절대 URL: https://cafe.naver.com/SLUG/ID
// - 상대 href: /SLUG/ID  (cafe.naver.com 페이지 기준)
function extractArticles(html, today) {
  const items = [];
  const seen  = new Set();

  // 절대 URL 패턴
  const absRe = /https?:\/\/cafe\.naver\.com\/([A-Za-z0-9_]+)\/(\d+)/g;
  // 상대 href 패턴 — "/slug/number" 형식
  const relRe = /href="\/([A-Za-z0-9_]+)\/(\d+)"/g;

  const datePattern = /(\d+\s*(?:시간|분|일|초)\s*전|어제|그저께|오늘|20\d{2}\.\d{1,2}\.\d{1,2})/;

  function tryAdd(cafe, aid, idx) {
    const key = `${cafe}/${aid}`;
    if (seen.has(key)) return;

    // 링크 주변 ±2000자 내 날짜 텍스트 탐색
    const before = html.slice(Math.max(0, idx - 2000), idx);
    const after  = html.slice(idx, idx + 2000);

    // 후방 탐색 우선 (목록에서 날짜가 뒤에 오는 경우)
    let dm = after.match(datePattern) || before.match(datePattern);
    if (!dm) return;
    const date = parseDateText(dm[1], today);
    if (!date) return;

    // 제목 추출: 링크 이후 첫 텍스트
    const titleWin = html.slice(idx, idx + 1500)
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<[^>]+>/g, '|')
      .replace(/\|+/g, '|');
    const texts = titleWin.split('|').map(s => s.trim()).filter(s => s.length >= 3);
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
  while ((m = absRe.exec(html)) !== null) {
    tryAdd(m[1], m[2], m.index);
  }
  while ((m = relRe.exec(html)) !== null) {
    tryAdd(m[1], m[2], m.index);
  }

  return items;
}

async function fetchCafeArticles(cafeId, dateFrom, dateTo, startParam = 1) {
  const today  = todayKR();
  const all    = [];
  const seen   = new Set();
  const debug  = { firstStatus: null, firstError: null, firstHtmlSize: 0, firstCardCount: null, firstSnippet: '' };

  const startPage = Math.max(1, Math.floor((startParam - 1) / PER_PAGE_CAFE) + 1);

  for (let i = 0; i < MAX_PAGES; i++) {
    const page = startPage + i;
    const url = `https://cafe.naver.com/ArticleList.nhn`
              + `?search.clubid=${encodeURIComponent(cafeId)}`
              + `&search.sortby=date`
              + `&search.page=${page}`
              + `&search.perPage=${PER_PAGE_CAFE}`;

    let html;
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
          'Accept-Language': 'ko-KR,ko;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Referer': `https://cafe.naver.com/`,
        },
      });
      if (i === 0) debug.firstStatus = r.status;
      if (!r.ok) {
        if (i === 0) debug.firstError = `HTTP ${r.status} from cafe.naver.com/ArticleList.nhn`;
        break;
      }
      html = await r.text();
    } catch (e) {
      if (i === 0) debug.firstError = `fetch failed: ${e.name||'Error'}: ${e.message}`;
      break;
    }

    const items = extractArticles(html, today);
    if (i === 0) {
      debug.firstHtmlSize  = html.length;
      debug.firstCardCount = items.length;
      if (items.length === 0) {
        debug.firstSnippet = html
          .replace(/<script[\s\S]*?<\/script>/g, '')
          .replace(/<style[\s\S]*?<\/style>/g, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300);
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
    // 기간 이전 글 발견 or 페이지가 덜 찼으면 → 이후 페이지 없음
    if (hitOldDate || items.length === 0 || items.length < PER_PAGE_CAFE) break;
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

  if (!cafeId) return res.status(400).json({ error: 'cafeId 필요' });

  const startParam = parseInt(start) || 1;

  try {
    const { items, debug } = await fetchCafeArticles(cafeId, dateFrom, dateTo, startParam);
    res.status(200).json({
      items,
      _rawCount: items.length,
      _anchors: items.length,
      _interpolated: 0,
      _noInfo: 0,
      _source: 'cafe.naver.com/ArticleList',
      _version: 'v4-articlelist',
      _debug: debug,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
