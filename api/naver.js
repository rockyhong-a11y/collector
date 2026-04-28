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

    // 서버 필터는 명백히 잘못된 날짜만 제거 (2010년 이전 / 미래)
    // postdate 불명(00000000/없음) 항목은 통과시키고 클라이언트에서 strict 스킵
    // — 서버에서 너무 많이 잘라내면 Naver 페이지네이션이 일찍 종료되는 문제 방지
    const rawCount = Array.isArray(data.items) ? data.items.length : 0;
    if (data.items) {
      const now = new Date().toISOString().slice(0, 10);
      data.items = data.items.filter(item => {
        const pd = String(item.postdate || '').replace(/\D/g, '');
        // postdate 불명 → 통과 (클라이언트가 strict로 처리)
        if (pd.length !== 8 || pd === '00000000') return true;
        const d = `${pd.slice(0, 4)}-${pd.slice(4, 6)}-${pd.slice(6, 8)}`;
        // 명백한 비정상 (2010년 이전 / 미래) → 제외
        if (d < '2010-01-01' || d > now) return false;
        // 수집 기간 외 — 강한 필터, 단 hitOldDate 조기 종료를 위해 dateFrom보다
        // 이전 항목은 클라이언트에 그대로 노출 (sort=date 가정)
        if (dateTo && d > dateTo) return false;
        return true;
      });
    }
    data._rawCount = rawCount;

    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
