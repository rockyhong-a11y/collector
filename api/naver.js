// Naver Cafe 검색 — search.naver.com (tab.cafe.all) 스크래핑 방식
//
// 사연: openapi.naver.com/cafearticle.json은 컴투스 카페들의 postdate를 거의
//       반환하지 않아 정확한 기간 필터링 불가. 반면 search.naver.com의
//       카페 검색 페이지는 사용자용으로 HTML에 게시일자를 직접 렌더링하고
//       nso=p:fromYYYYMMDDtoYYYYMMDD 파라미터로 기간 필터까지 지원함.
//
// 동작: keyword + cafe:CAFEID + 기간 nso → search.naver.com 카페 탭 스크래핑
//       각 게시물의 link, 제목, 날짜(절대 또는 상대) 추출 → 절대 날짜로 변환
//       모든 항목에 verified date가 부여되므로 사용자 기간과 1:1 동기화

const SEARCH_URL = 'https://search.naver.com/search.naver';
const PER_PAGE   = 10;
const MAX_PAGES  = 5; // request당 최대 페이지 (50개 결과까지)

function pad2(n) { return String(n).padStart(2, '0'); }

function todayKR() {
  // KST 기준 오늘 (UTC+9)
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 - now.getTimezoneOffset()) * 60000);
  return kst.toISOString().slice(0, 10);
}

function shiftDate(baseISO, days) {
  const d = new Date(baseISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 상대시간/절대날짜 텍스트를 YYYY-MM-DD로 변환
function parseDateText(text, today) {
  if (!text) return null;
  text = text.trim();
  if (text === '오늘') return today;
  if (text === '어제') return shiftDate(today, -1);
  if (text === '그저께') return shiftDate(today, -2);
  let m = text.match(/(\d+)\s*시간\s*전/);
  if (m) {
    // N시간 전 — 시각 기준 today 또는 어제일 수 있으나 보통 today로 충분
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

// HTML에서 카페 게시물 카드 추출 — link, title, date
function extractCards(html, today) {
  const items = [];
  // 카드 단위 분할: 각 카페 article 링크부터 다음 article 링크 직전까지
  const linkRe = /cafe\.naver\.com\/(\w+)\/(\d+)/g;
  const positions = [];
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    positions.push({ idx: m.index, cafe: m[1], aid: m[2] });
  }

  // 각 link 위치에서 forward 3000자 안의 날짜 텍스트 찾기
  const datePatterns = /(\d+\s*(?:시간|분|일|초)\s*전|어제|그저께|오늘|20\d{2}\.\d{1,2}\.\d{1,2})/;
  const seen = new Set();

  for (const pos of positions) {
    const key = `${pos.cafe}/${pos.aid}`;
    if (seen.has(key)) continue;

    // forward window
    const window = html.slice(pos.idx, pos.idx + 3000);
    const dm = window.match(datePatterns);
    if (!dm) continue;
    const date = parseDateText(dm[1], today);
    if (!date) continue;

    // backward 800자에서 a 태그 텍스트 추출 시도 → 제목
    const back = html.slice(Math.max(0, pos.idx - 800), pos.idx);
    let title = '';
    const tm = back.match(/<a\s[^>]*>([^<]{3,200})<\/a>(?![\s\S]*?<a)/);
    if (tm) title = tm[1].replace(/<[^>]+>/g, '').trim();

    // description / snippet — 카드 내 본문 텍스트
    const winText = window.replace(/<script[\s\S]*?<\/script>/g, '')
                          .replace(/<[^>]+>/g, ' ')
                          .replace(/\s+/g, ' ').trim();
    const description = winText.slice(0, 200);

    seen.add(key);
    items.push({
      title: title || winText.slice(0, 80),
      link: `https://cafe.naver.com/${pos.cafe}/${pos.aid}`,
      description,
      cafename: pos.cafe,
      _date: date,        // YYYY-MM-DD 검증된 날짜
      postdate: date.replace(/-/g, ''), // 호환성을 위한 YYYYMMDD 형식
    });
  }
  return items;
}

async function searchCafeViaWeb(keyword, cafeId, dateFrom, dateTo, log = () => {}) {
  const today = todayKR();
  const all = [];
  const seen = new Set();

  const query = cafeId ? `cafe:${cafeId} ${keyword}` : keyword;
  const fromYMD = (dateFrom || '').replace(/-/g, '');
  const toYMD   = (dateTo   || '').replace(/-/g, '');
  const nso = (fromYMD && toYMD)
    ? `p:from${fromYMD}to${toYMD},so:dd`
    : `so:dd`;

  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * PER_PAGE + 1;
    const url = `${SEARCH_URL}?ssc=tab.cafe.all&sm=tab_jum`
              + `&start=${start}`
              + `&query=${encodeURIComponent(query)}`
              + `&nso=${encodeURIComponent(nso)}`;

    let html;
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
          'Accept-Language': 'ko-KR,ko;q=0.9',
        },
      });
      if (!r.ok) break;
      html = await r.text();
    } catch { break; }

    const items = extractCards(html, today);
    let added = 0;
    for (const it of items) {
      if (seen.has(it.link)) continue;
      seen.add(it.link);
      // 안전장치: 추출 날짜가 사용자 기간 내인지 재확인
      if (dateFrom && it._date < dateFrom) continue;
      if (dateTo   && it._date > dateTo)   continue;
      all.push(it);
      added++;
    }
    if (added === 0) break;
  }

  return all;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const {
    keyword  = '',
    cafeId   = '',
    dateFrom = '',
    dateTo   = '',
  } = req.query;

  if (!keyword) return res.status(400).json({ error: '키워드 없음' });

  try {
    const items = await searchCafeViaWeb(keyword, cafeId, dateFrom, dateTo);
    res.status(200).json({
      items,
      _rawCount: items.length,
      _anchors: items.length,        // 모든 항목 검증됨
      _interpolated: 0,
      _noInfo: 0,
      _source: 'search.naver.com',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
