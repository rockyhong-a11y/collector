// Naver Search API 래퍼 + 위치 기반 날짜 보간
//
// 컴투스 야구 카페들은 cafearticle.json 응답에서 postdate가 거의 누락되지만,
// 같은 응답 내 일부 항목엔 valid postdate가 있다. sort=date 정렬을 가정하면,
// 응답 내 위치(idx)와 anchor 항목의 (idx, date)를 이용해 선형 보간 가능.
//
// 정책:
//   1) postdate 유효 → 그대로 사용
//   2) postdate 누락 + 같은 응답에 anchor 있음 → 위치 기반 선형 보간
//   3) postdate 누락 + anchor 없음 → today() 추정, _dateUncertain=true
//   4) 최종 dateRange 필터를 모든 항목에 적용 (해석된 날짜 기준)

function dateToTs(d) { return new Date(d + 'T00:00:00Z').getTime(); }
function tsToDate(ts) { return new Date(ts).toISOString().slice(0, 10); }
function pad2(n) { return String(n).padStart(2, '0'); }

function annotateDates(items) {
  const today = new Date().toISOString().slice(0, 10);
  const anchors = []; // [{idx, ts}]

  // 1. anchor 수집: postdate 유효한 항목
  items.forEach((item, idx) => {
    const pd = String(item.postdate || '').replace(/\D/g, '');
    if (pd.length === 8 && pd !== '00000000') {
      const d = `${pd.slice(0, 4)}-${pd.slice(4, 6)}-${pd.slice(6, 8)}`;
      anchors.push({ idx, ts: dateToTs(d) });
    }
  });

  // 2. 누락 항목에 추정 날짜 부여
  items.forEach((item, idx) => {
    const pd = String(item.postdate || '').replace(/\D/g, '');
    if (pd.length === 8 && pd !== '00000000') return; // already has

    if (anchors.length === 0) {
      // anchor 없음 — sort=date 신뢰, today() 추정
      item._date = today;
      item._dateUncertain = true;
      return;
    }

    // 인접 anchor 찾기
    let prev = null, next = null;
    for (const a of anchors) {
      if (a.idx <= idx) prev = a;
      if (a.idx >= idx && next === null) next = a;
    }

    let ts;
    if (prev && next && prev !== next) {
      // 선형 보간
      const span  = next.idx - prev.idx;
      const offset = idx - prev.idx;
      ts = prev.ts + (next.ts - prev.ts) * (offset / span);
    } else if (prev) {
      ts = prev.ts;
    } else if (next) {
      ts = next.ts;
    } else {
      ts = dateToTs(today);
    }
    item._date = tsToDate(ts);
    item._dateInterpolated = true;
  });
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
    let anchorCount = 0, interpolatedCount = 0, uncertainCount = 0;

    if (data.items) {
      annotateDates(data.items);

      // 통계 집계
      data.items.forEach(item => {
        const pd = String(item.postdate || '').replace(/\D/g, '');
        if (pd.length === 8 && pd !== '00000000') anchorCount++;
        else if (item._dateInterpolated) interpolatedCount++;
        else if (item._dateUncertain) uncertainCount++;
      });

      // strict dateRange 필터 — 모든 항목 적용 (해석/보간된 날짜 기준)
      const now = new Date().toISOString().slice(0, 10);
      data.items = data.items.filter(item => {
        const pd = String(item.postdate || '').replace(/\D/g, '');
        let d;
        if (pd.length === 8 && pd !== '00000000') {
          d = `${pd.slice(0, 4)}-${pd.slice(4, 6)}-${pd.slice(6, 8)}`;
        } else if (item._date) {
          d = item._date;
        } else {
          return false;
        }
        if (d < '2010-01-01' || d > now) return false;
        if (dateFrom && d < dateFrom) return false;
        if (dateTo   && d > dateTo)   return false;
        return true;
      });
    }
    data._rawCount = rawCount;
    data._anchors = anchorCount;
    data._interpolated = interpolatedCount;
    data._uncertain = uncertainCount;

    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
