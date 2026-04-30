// Naver Search API 래퍼
// 컴투스 야구 카페들은 cafearticle.json 응답에서 postdate가 거의 누락됨.
// description에서 날짜를 추출하려 시도했으나, description은 본문 일부이고 그 안의
// 날짜는 보통 게시 일자가 아닌 이벤트 기간/인용 날짜라 false-rejection을 유발.
// 따라서 enrichment를 빼고 다음 정책 사용:
//   - postdate가 유효하면 strict dateRange 검사
//   - postdate가 없거나 0인 항목은 dateTo로 추정하고 _dateUncertain 마킹 → 항상 통과
//   - 클라이언트에서 [날짜추정] 라벨로 식별

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
    let uncertainCount = 0;

    if (data.items) {
      const now = new Date().toISOString().slice(0, 10);
      const fallbackDate = dateTo || now;

      data.items = data.items.filter(item => {
        const pd = String(item.postdate || '').replace(/\D/g, '');
        if (pd.length === 8 && pd !== '00000000') {
          const d = `${pd.slice(0, 4)}-${pd.slice(4, 6)}-${pd.slice(6, 8)}`;
          // postdate 유효 — strict 범위 검사
          if (d < '2010-01-01' || d > now) return false;
          if (dateFrom && d < dateFrom) return false;
          if (dateTo   && d > dateTo)   return false;
          return true;
        } else {
          // postdate 없음 — sort=date 신뢰하여 통과 + 추정 플래그
          item._date = fallbackDate;
          item._dateUncertain = true;
          uncertainCount++;
          return true;
        }
      });
    }
    data._rawCount = rawCount;
    data._uncertain = uncertainCount;

    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
