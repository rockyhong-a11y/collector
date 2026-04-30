// Naver Search API 래퍼 + 날짜 보강 (date enrichment)
// 컴투스 야구 카페들은 cafearticle.json 응답에서 postdate가 비거나 00000000인 경우가
// 매우 많아 (사용자 로그상 90%+) 클라이언트 strict 필터로 0건 결과 발생.
// 보강 절차:
//   1) postdate 유효 → 그대로 사용
//   2) description에서 YYYY-MM-DD/YYYY.MM.DD/YYYY년 M월 D일 정규식 추출
//   3) 카페 링크를 직접 fetch하여 메타 태그(article:published_time) 또는 본문 날짜 추출

const MAX_ENRICH        = 30;    // request당 최대 보강 시도 항목 수 (Vercel 실행시간 제약)
const ENRICH_PARALLEL   = 10;    // 동시 fetch
const ENRICH_TIMEOUT_MS = 3500;  // 개별 fetch 제한
const DATE_PAT_NUMERIC  = /(20\d{2})[\.\-\/]\s*(\d{1,2})[\.\-\/]\s*(\d{1,2})/;
const DATE_PAT_KOREAN   = /(20\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/;
const DATE_PAT_META     = /property=["']article:published_time["'][^>]*content=["']([^"']+)["']/;

function pad2(n) { return String(n).padStart(2,'0'); }
function fmt(y,m,d) { return `${y}-${pad2(m)}-${pad2(d)}`; }

function extractDate(text) {
  if (!text) return null;
  let m = text.match(DATE_PAT_NUMERIC);
  if (m) return fmt(m[1], m[2], m[3]);
  m = text.match(DATE_PAT_KOREAN);
  if (m) return fmt(m[1], m[2], m[3]);
  return null;
}

async function enrichItem(item) {
  // 1) description
  const fromDesc = extractDate(item.description || '');
  if (fromDesc) { item._date = fromDesc; return; }
  // 2) link fetch
  if (!item.link) return;
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), ENRICH_TIMEOUT_MS);
    const r = await fetch(item.link, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    if (!r.ok) return;
    const html = await r.text();
    // article:published_time 메타 (최우선)
    const meta = html.match(DATE_PAT_META);
    if (meta && meta[1]) {
      const d = meta[1].slice(0, 10);
      if (/^20\d{2}-\d{2}-\d{2}$/.test(d)) { item._date = d; return; }
    }
    // 본문 날짜 (한글/숫자 형식)
    const fromHtml = extractDate(html);
    if (fromHtml) item._date = fromHtml;
  } catch {}
}

async function enrichBatch(items) {
  const candidates = items.filter(it => {
    const pd = String(it.postdate || '').replace(/\D/g, '');
    return pd.length !== 8 || pd === '00000000';
  });
  const toEnrich = candidates.slice(0, MAX_ENRICH);
  for (let i = 0; i < toEnrich.length; i += ENRICH_PARALLEL) {
    const batch = toEnrich.slice(i, i + ENRICH_PARALLEL);
    await Promise.all(batch.map(enrichItem));
  }
  return { candidatesCount: candidates.length, attempted: toEnrich.length };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const {
    keyword  = '',
    cafeId   = '',
    display  = '100',
    start    = '1',
    dateFrom = '',
    dateTo   = '',
  } = req.query;

  if (!keyword) return res.status(400).json({ error: '키워드 없음' });

  const query = cafeId ? `${keyword} cafe:${cafeId}` : keyword;
  const url = `https://openapi.naver.com/v1/search/cafearticle.json`
    + `?query=${encodeURIComponent(query)}&display=${display}&start=${start}&sort=date`;

  try {
    const r = await fetch(url, {
      headers: {
        'X-Naver-Client-Id':     process.env.NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET,
      },
    });
    const data = await r.json();

    const rawCount = Array.isArray(data.items) ? data.items.length : 0;
    let enrichInfo = { candidatesCount: 0, attempted: 0 };

    if (data.items) {
      // 보강: postdate 누락 항목에 _date 설정
      enrichInfo = await enrichBatch(data.items);

      const now = new Date().toISOString().slice(0, 10);
      data.items = data.items.filter(item => {
        const pd = String(item.postdate || '').replace(/\D/g, '');
        let d;
        if (pd.length === 8 && pd !== '00000000') {
          d = `${pd.slice(0, 4)}-${pd.slice(4, 6)}-${pd.slice(6, 8)}`;
        } else if (item._date) {
          d = item._date;
        } else {
          return false; // 보강 실패 항목 제외 (strict)
        }
        if (d < '2010-01-01' || d > now) return false;
        if (dateFrom && d < dateFrom) return false;
        if (dateTo   && d > dateTo)   return false;
        return true;
      });
    }
    data._rawCount = rawCount;
    data._enrich = enrichInfo;

    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
