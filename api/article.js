// Naver Cafe 게시글 본문 수집 API
// GET /api/article?url=ARTICLE_URL&cookie=NID_AUT=...;NID_SES=...

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function extractNextData(html) {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// __NEXT_DATA__ 내 본문 HTML 재귀 탐색
function findContentHtml(obj, depth = 0) {
  if (depth > 12 || !obj || typeof obj !== 'object') return null;
  const KEYS = ['contentHtml', 'content', 'articleBody', 'bodyText', 'text', 'body'];
  for (const k of KEYS) {
    if (obj[k] && typeof obj[k] === 'string' && obj[k].length > 30) return obj[k];
  }
  for (const val of Object.values(obj)) {
    if (typeof val === 'object') {
      const found = findContentHtml(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 정규식으로 특정 div 블록 추출 (깊이 무시 단순 추출)
function extractDivBlock(html, startPattern) {
  const idx = html.search(startPattern);
  if (idx === -1) return '';
  let depth = 0, i = idx, result = '';
  while (i < html.length) {
    if (html[i] === '<') {
      if (html.slice(i, i + 2) === '</') {
        depth--;
        const end = html.indexOf('>', i);
        result += html.slice(i, end + 1);
        i = end + 1;
        if (depth <= 0) break;
      } else {
        const tag = html.slice(i, html.indexOf('>', i) + 1);
        depth++;
        result += tag;
        i += tag.length;
        if (tag.endsWith('/>')) depth--;
      }
    } else {
      result += html[i++];
    }
  }
  return result;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url, cookie } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const headers = {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'Referer': 'https://cafe.naver.com/',
      'Cache-Control': 'no-cache',
    };
    if (cookie) headers['Cookie'] = cookie;

    const upstream = await fetch(url, { headers, redirect: 'follow' });
    const html = await upstream.text();

    // 1순위: __NEXT_DATA__ JSON
    const nextData = extractNextData(html);
    if (nextData) {
      const raw = findContentHtml(nextData);
      if (raw && raw.length > 30) {
        return res.status(200).json({ content: stripHtml(raw), method: 'next-data' });
      }
    }

    // 2순위: 본문 div 블록 추출
    const patterns = [
      /(<div[^>]*class="[^"]*se-main-container[^"]*")/,
      /(<div[^>]*class="[^"]*ContentRenderer[^"]*")/,
      /(<div[^>]*id="articleBody")/,
      /(<div[^>]*class="[^"]*article_body[^"]*")/,
    ];
    for (const pat of patterns) {
      const block = extractDivBlock(html, pat);
      if (block.length > 50) {
        return res.status(200).json({ content: stripHtml(block), method: 'html-div' });
      }
    }

    // 3순위: se-text-paragraph 수집
    const paras = [];
    const paraRe = /<p[^>]*class="[^"]*se-text-paragraph[^"]*"[^>]*>([\s\S]*?)<\/p>/g;
    let m;
    while ((m = paraRe.exec(html)) !== null) {
      const t = stripHtml(m[1]);
      if (t) paras.push(t);
    }
    if (paras.length) {
      return res.status(200).json({ content: paras.join('\n'), method: 'se-para' });
    }

    return res.status(200).json({ content: '', method: 'none' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
