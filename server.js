// 로컬 개발 서버 — Vercel 배포 없이 바로 실행 가능
// 실행: node server.js
// 접속: http://localhost:3000

import http from 'http';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { URL } from 'url';

const __dir  = path.dirname(fileURLToPath(import.meta.url));
const PORT   = 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

// Vercel 라우팅 규칙 (vercel.json rewrites)
const REWRITES = {
  '/cafe':        '/api/naver',
  '/relay':       '/api/proxy',
};

async function loadHandler(apiPath) {
  const file = path.join(__dir, apiPath + '.js');
  const mod  = await import(`${file}?t=${Date.now()}`); // 캐시 방지
  return mod.default;
}

// 간단한 req/res 어댑터 (Node http → Vercel handler 호환)
function makeVercelReq(req, body, parsedUrl) {
  const query = Object.fromEntries(parsedUrl.searchParams.entries());
  return {
    method:  req.method,
    url:     req.url,
    headers: req.headers,
    query,
    body,
    [Symbol.asyncIterator]: async function*() {
      if (body) yield Buffer.from(body);
    },
    [Symbol.iterator]: undefined,
  };
  // asyncIterator for readBody in proxy.js
}

function makeVercelRes(res) {
  let statusCode = 200;
  const headers  = {};
  return {
    status(code)          { statusCode = code; return this; },
    setHeader(k, v)       { headers[k] = v; res.setHeader(k, v); return this; },
    end(data)             {
      res.writeHead(statusCode);
      res.end(data);
    },
    send(data)            {
      res.writeHead(statusCode, headers);
      res.end(typeof data === 'string' ? data : JSON.stringify(data));
    },
    json(obj)             {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(statusCode, headers);
      res.end(JSON.stringify(obj));
    },
  };
}

const server = http.createServer(async (req, res) => {
  // CORS 헤더
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // URL 파싱
  const rawPath = req.url.split('?')[0];
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

  // rewrite 처리
  const apiTarget = REWRITES[rawPath];
  if (apiTarget) {
    try {
      const handler = await loadHandler(apiTarget);
      let body = '';
      req.on('data', c => body += c);
      await new Promise(r => req.on('end', r));
      const vReq = makeVercelReq(req, body, parsedUrl);
      const vRes = makeVercelRes(res);
      await handler(vReq, vRes);
    } catch (e) {
      console.error('[API 오류]', e.message);
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // /api/* 직접 접근
  if (rawPath.startsWith('/api/')) {
    try {
      const handler = await loadHandler(rawPath);
      let body = '';
      req.on('data', c => body += c);
      await new Promise(r => req.on('end', r));
      const vReq = makeVercelReq(req, body, parsedUrl);
      const vRes = makeVercelRes(res);
      await handler(vReq, vRes);
    } catch (e) {
      console.error('[API 오류]', e.message);
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 정적 파일 서빙
  let filePath = path.join(__dir, rawPath === '/' ? 'index.html' : rawPath);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dir, 'index.html'); // SPA fallback
  }
  const ext  = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {'Content-Type': mime});
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n✅ 로컬 서버 실행 중`);
  console.log(`   브라우저에서 열기: http://localhost:${PORT}`);
  console.log(`   종료: Ctrl+C\n`);
});
