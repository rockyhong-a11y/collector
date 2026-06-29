// FM코리아 수집 — Vercel Edge Function (Cloudflare 네트워크)
// 로컬: server.js가 Web API Request/Response 형식으로 호출
// Vercel: Edge Runtime에서 Cloudflare 망으로 직접 fetch

export const config = { runtime: 'edge' }

// ── 날짜 유틸 ────────────────────────────────────────────────
function todayKst() {
  const now = new Date()
  // UTC+9
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  return kst.toISOString().slice(0, 10)
}

function parseFmDate(raw, today) {
  if (!raw) return null
  const s = raw.trim()
  if (/^\d{1,2}:\d{2}$/.test(s)) return today
  let m = s.match(/^(\d{2})\.(\d{2})\.(\d{2})$/)
  if (m) return `20${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(20\d{2})\.(\d{2})\.(\d{2})$/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  return null
}

// ── HTML 파싱 ────────────────────────────────────────────────
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function parseArticles(html, today, dateFrom, dateTo) {
  const items = []
  const seen = new Set()
  const tbodyM = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)
  if (!tbodyM) return { items, hitOld: false }

  const rowRe = /<tr([^>]*)>([\s\S]*?)<\/tr>/g
  let hitOld = false
  let m

  while ((m = rowRe.exec(tbodyM[1])) !== null) {
    const [, trAttrs, row] = m
    if (/class="[^"]*notice/.test(trAttrs)) continue

    const linkM = row.match(/href="(\/index\.php\?[^"#]*document_srl=(\d+)[^"#]*)"/)
    if (!linkM) continue

    const postUrl = 'https://www.fmkorea.com' + decodeEntities(linkM[1])
    if (seen.has(postUrl)) continue
    seen.add(postUrl)

    const titleM = row.match(
      /<td[^>]*class="[^"]*title[^"]*"[^>]*>[\s\S]*?<a[^>]*href="[^"#]*document_srl=\d+[^"#]*"[^>]*>([\s\S]*?)<\/a>/i
    )
    const title = titleM ? decodeEntities(stripTags(titleM[1])) : ''
    if (!title || title.length < 2) continue

    const dateM = row.match(/<td[^>]*class="[^"]*time[^"]*"[^>]*>([^<]+)<\/td>/i)
    const date = parseFmDate(dateM ? dateM[1] : '', today)
    if (!date) continue

    if (dateFrom && date < dateFrom) { hitOld = true; continue }
    if (dateTo && date > dateTo) continue

    items.push({ title, url: postUrl, date })
  }

  return { items, hitOld }
}

// ── HTTP 수집 ────────────────────────────────────────────────
const BROWSER_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Upgrade-Insecure-Requests': '1',
}

function isValidFmHtml(html) {
  return html.length > 5000 && html.includes('<tbody') &&
    (html.includes('fmkorea') || html.includes('baseball_game'))
}

function isCfChallenge(html) {
  return html.includes('에펨코리아 보안 시스템') || html.includes('cf-turnstile')
}

// 방법 1: Cloudflare Worker CORS 프록시 (CF_WORKER_URL 환경변수)
// 배포법: worker/fmproxy.js 참고
async function fetchViaWorker(url, workerUrl) {
  const endpoint = `${workerUrl}?url=${encodeURIComponent(url)}`
  const res = await fetch(endpoint, { redirect: 'follow' })
  if (!res.ok) return ''
  return res.text()
}

// 방법 2: ScraperAPI 주거용 IP 프록시 (SCRAPERAPI_KEY 환경변수)
// 무료: scraperapi.com 가입 → 1,000 크레딧/월
async function fetchViaScraperApi(url, apiKey) {
  const endpoint = `https://api.scraperapi.com/?api_key=${apiKey}&url=${encodeURIComponent(url)}&country_code=kr&premium=true`
  const res = await fetch(endpoint, { signal: AbortSignal.timeout(25000) })
  if (!res.ok) return ''
  return res.text()
}

// 방법 3: allorigins.win 공개 프록시 (무료, 설정 불필요)
async function fetchViaAllorigins(url) {
  const endpoint = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`
  const res = await fetch(endpoint, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) return ''
  const json = await res.json()
  return json.contents || ''
}

async function fetchFmHtml(url, cfWorkerFromClient = '') {
  const workerUrl   = cfWorkerFromClient || (typeof process !== 'undefined' && process.env?.CF_WORKER_URL)   || ''
  const scraperKey  = (typeof process !== 'undefined' && process.env?.SCRAPERAPI_KEY)  || ''

  // 1순위: Cloudflare Worker 프록시 (CF 내부망 → 차단 우회 가능, 무료)
  if (workerUrl) {
    try {
      const html = await fetchViaWorker(url, workerUrl)
      if (isValidFmHtml(html))  return { html, via: 'cf-worker' }
      if (isCfChallenge(html))  return { html: '', via: 'cf-worker-challenge' }
    } catch (_) {}
  }

  // 2순위: ScraperAPI 주거용 IP (확실히 우회, 유료)
  if (scraperKey) {
    try {
      const html = await fetchViaScraperApi(url, scraperKey)
      if (isValidFmHtml(html)) return { html, via: 'scraperapi' }
    } catch (_) {}
  }

  // 3순위: allorigins.win 공개 프록시 (무료, 설정 불필요 — Cloudflare IP 차단 우회)
  for (const aoTarget of [url, url.replace('www.fmkorea.com', 'm.fmkorea.com')]) {
    try {
      const html = await fetchViaAllorigins(aoTarget)
      if (isValidFmHtml(html)) return { html, via: 'allorigins' }
      if (isCfChallenge(html))  break
    } catch (_) {}
  }

  // 4순위: 직접 fetch (로컬 주거용 IP에서는 동작, Vercel에서는 차단됨)
  for (const [target, label] of [
    [url, 'direct'],
    [url.replace('www.fmkorea.com', 'm.fmkorea.com'), 'mobile'],
  ]) {
    try {
      const res = await fetch(target, {
        headers: { ...BROWSER_HEADERS, Referer: `https://${label === 'mobile' ? 'm' : 'www'}.fmkorea.com/` },
        redirect: 'follow',
      })
      const html = await res.text()
      if (isValidFmHtml(html))  return { html, via: label }
      if (isCfChallenge(html))  return { html: '', via: `${label}-cf-challenge` }
    } catch (_) {}
  }

  return { html: '', via: 'failed' }
}

// ── Edge Handler ─────────────────────────────────────────────
export default async function handler(req) {
  const CORS = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  }

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  const url = new URL(req.url)
  const category     = url.searchParams.get('category') || ''
  const page         = Math.max(1, parseInt(url.searchParams.get('page') || '1'))
  const dateFrom     = url.searchParams.get('dateFrom') || ''
  const dateTo       = url.searchParams.get('dateTo') || ''
  // 클라이언트에서 전달된 CF Worker URL (env var 없이도 동작)
  const cfWorkerFromClient = url.searchParams.get('cfWorkerUrl') || ''

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj, null, 0), { status, headers: CORS })

  if (category === 'ping') return json({ pong: true, _version: 'v4-edge' })
  if (!category) return json({ _error: 'category required' }, 400)

  const fmUrl = `https://www.fmkorea.com/index.php?mid=baseball_game&category=${category}&page=${page}`
  const today = todayKst()
  const { html, via } = await fetchFmHtml(fmUrl, cfWorkerFromClient)

  if (!html) {
    return json({ items: [], page, hitOld: false, _error: `수집 실패 (${via})`, _via: via })
  }

  const { items, hitOld } = parseArticles(html, today, dateFrom, dateTo)
  return json({ items, page, hitOld, _htmlLen: html.length, _via: via })
}
