/**
 * FM코리아 CORS 프록시 — Cloudflare Worker
 *
 * 배포 방법 (무료):
 *   1. https://workers.cloudflare.com 접속 → 로그인
 *   2. "Create Worker" → 이 파일 내용 붙여넣기 → "Save and Deploy"
 *   3. 배포된 URL (예: https://fmproxy.your-name.workers.dev) 복사
 *   4. Vercel 프로젝트 설정 → Environment Variables →
 *      CF_WORKER_URL = https://fmproxy.your-name.workers.dev  추가
 *   5. Vercel 재배포
 *
 * 동작 원리:
 *   Cloudflare Worker가 FMKorea를 대신 fetch → Cloudflare 내부망이라 차단 우회 가능
 *   CORS 헤더를 추가하여 브라우저에서도 직접 호출 가능
 */

export default {
  async fetch(request) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
        },
      })
    }

    const { searchParams } = new URL(request.url)
    const target = searchParams.get('url') || ''

    // 보안: FMKorea URL만 허용
    if (!target.startsWith('https://www.fmkorea.com/') &&
        !target.startsWith('https://m.fmkorea.com/')) {
      return new Response(JSON.stringify({ error: 'FMKorea URL만 허용됩니다' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      })
    }

    try {
      const res = await fetch(target, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Referer': 'https://www.fmkorea.com/',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Upgrade-Insecure-Requests': '1',
        },
        redirect: 'follow',
      })

      const html = await res.text()
      return new Response(html, {
        status: res.status,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'X-Via': 'cf-worker',
        },
      })
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      })
    }
  },
}
