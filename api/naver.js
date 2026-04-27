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

    // 서버 단 날짜 필터 — postdate가 확인되는 항목만 적용
    if (data.items) {
      const now = new Date().toISOString().slice(0, 10);
      data.items = data.items.filter(item => {
        const pd = String(item.postdate || '').replace(/\D/g, '');
        if (pd.length !== 8 || pd === '00000000') return true; // 날짜 불명 → 통과
        const d = `${pd.slice(0, 4)}-${pd.slice(4, 6)}-${pd.slice(6, 8)}`;
        // 합리성 검사: 2010년 이전이거나 미래 날짜 제거
        if (d < '2010-01-01' || d > now) return false;
        // 수집 기간 범위 필터
        if (dateFrom && d < dateFrom) return false;
        if (dateTo   && d > dateTo)   return false;
        return true;
      });
    }

    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
