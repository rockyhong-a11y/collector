// 로컬 개발 서버 — Vercel 배포 없이 바로 실행 가능
// 실행: node server.js
// 접속: http://localhost:3000

import http       from 'http';
import fs         from 'fs';
import path       from 'path';
import { spawn }  from 'child_process';
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
  '/fmkorea':     '/api/fmkorea',
};

async function loadHandler(apiPath) {
  const file = path.join(__dir, apiPath + '.js');
  const mod  = await import(`${file}?t=${Date.now()}`); // 캐시 방지
  return mod;
}

// Edge Function (config.runtime==='edge')을 Node.js에서 실행
async function runEdgeHandler(mod, req, res) {
  const base = `http://localhost:${PORT}`
  const webReq = new Request(base + req.url, {
    method: req.method,
    headers: new Headers(req.headers),
  })
  const webRes = await mod.default(webReq)
  const body   = await webRes.arrayBuffer()
  webRes.headers.forEach((v, k) => res.setHeader(k, v))
  res.writeHead(webRes.status)
  res.end(Buffer.from(body))
}

// Python WSGI 핸들러를 로컬에서 직접 실행 (에펨코리아 등)
function runPythonHandler(pyFile, reqUrl, res) {
  return new Promise((resolve) => {
    const py = spawn('python3', ['-c', `
import sys, json
sys.path.insert(0, '${path.dirname(pyFile)}')
from ${path.basename(pyFile, '.py')} import handler
from http.server import BaseHTTPRequestHandler
from io import BytesIO
import urllib.parse

class FakeReq:
    def __init__(self, path):
        self.path = path
        self.rfile = BytesIO(b'')
    def makefile(self, *a, **kw): return BytesIO(b'')

class FakeConn:
    def __init__(self): self.buf = BytesIO()
    def makefile(self, *a, **kw): return self.buf
    def sendall(self, data): self.buf.write(data)

buf = []
class H(handler):
    def __init__(self):
        self.path = ${JSON.stringify(reqUrl)}
        self.headers = {}
        self.rfile = BytesIO(b'')
        self.wfile = sys.stdout.buffer
    def send_response(self, code, msg=None): pass
    def send_header(self, k, v): pass
    def end_headers(self): pass
    def log_message(self, *a): pass

h = H()
h.do_GET()
sys.stdout.buffer.flush()
`]);
    let out = Buffer.alloc(0);
    py.stdout.on('data', d => { out = Buffer.concat([out, d]); });
    py.stderr.on('data', d => process.stderr.write(d));
    py.on('close', (code) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.writeHead(200);
      res.end(out);
      resolve();
    });
  });
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

  // API 라우팅 공통 처리
  async function dispatchApi(apiPath) {
    const jsFile = path.join(__dir, apiPath + '.js');
    const pyFile = path.join(__dir, apiPath + '.py');

    // fmkorea: Python(curl_cffi TLS 지문 우회)이 로컬에서 Cloudflare 차단 우회에 효과적
    if (apiPath.endsWith('/fmkorea') && fs.existsSync(pyFile)) {
      await runPythonHandler(pyFile, req.url, res);
      return;
    }

    // JS 파일 우선 (Edge Function 포함)
    if (fs.existsSync(jsFile)) {
      try {
        const mod = await loadHandler(apiPath);
        if (mod.config?.runtime === 'edge') {
          await runEdgeHandler(mod, req, res);
        } else {
          let body = '';
          req.on('data', c => body += c);
          await new Promise(r => req.on('end', r));
          const vReq = makeVercelReq(req, body, parsedUrl);
          const vRes = makeVercelRes(res);
          await mod.default(vReq, vRes);
        }
      } catch (e) {
        console.error('[API 오류]', e.message);
        res.writeHead(500, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // Python 폴백 (로컬 전용)
    if (fs.existsSync(pyFile)) {
      await runPythonHandler(pyFile, req.url, res);
      return;
    }

    res.writeHead(404, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ error: `핸들러 없음: ${apiPath}` }));
  }

  // rewrite 처리
  const apiTarget = REWRITES[rawPath];
  if (apiTarget) { await dispatchApi(apiTarget); return; }

  // /api/* 직접 접근
  if (rawPath.startsWith('/api/')) { await dispatchApi(rawPath); return; }

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
