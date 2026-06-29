# FM코리아 수집 서버리스 함수 v3
# curl_cffi로 allorigins.win 경유 FM코리아 접근 (IP 차단 우회)

import json
import re
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, quote_plus
from datetime import datetime, timezone, timedelta


def today_kst():
    kst = timezone(timedelta(hours=9))
    return datetime.now(tz=kst).strftime('%Y-%m-%d')


def parse_fm_date(raw, today):
    if not raw:
        return None
    s = raw.strip()
    if re.match(r'^\d{1,2}:\d{2}$', s):
        return today
    m = re.match(r'^(\d{2})\.(\d{2})\.(\d{2})$', s)
    if m:
        return f'20{m.group(1)}-{m.group(2)}-{m.group(3)}'
    m = re.match(r'^(20\d{2})\.(\d{2})\.(\d{2})$', s)
    if m:
        return f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
    return None


def decode_html_entities(s):
    return (str(s)
            .replace('&amp;', '&')
            .replace('&lt;', '<')
            .replace('&gt;', '>')
            .replace('&quot;', '"')
            .replace('&#39;', "'")
            .replace('&nbsp;', ' '))


def strip_tags(s):
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', s)).strip()


def parse_articles(html, today, date_from, date_to):
    items = []
    seen = set()

    m = re.search(r'<tbody[^>]*>([\s\S]*?)<\/tbody>', html, re.I)
    if not m:
        return {'items': items, 'hitOld': False}

    tbody = m.group(1)
    rows = re.findall(r'<tr([^>]*)>([\s\S]*?)<\/tr>', tbody)
    hit_old = False

    for tr_attrs, row in rows:
        if re.search(r'class="[^"]*notice', tr_attrs):
            continue

        link_m = re.search(r'href="(\/index\.php\?[^"#]*document_srl=(\d+)[^"#]*)"', row)
        if not link_m:
            continue

        href = decode_html_entities(link_m.group(1))
        post_url = 'https://www.fmkorea.com' + href
        if post_url in seen:
            continue
        seen.add(post_url)

        title_m = re.search(
            r'<td[^>]*class="[^"]*title[^"]*"[^>]*>[\s\S]*?'
            r'<a[^>]*href="[^"#]*document_srl=\d+[^"#]*"[^>]*>([\s\S]*?)<\/a>',
            row, re.I
        )
        title = decode_html_entities(strip_tags(title_m.group(1))) if title_m else ''
        if not title or len(title) < 2:
            continue

        date_m = re.search(r'<td[^>]*class="[^"]*time[^"]*"[^>]*>([^<]+)<\/td>', row, re.I)
        date = parse_fm_date(date_m.group(1) if date_m else '', today)
        if not date:
            continue

        if date_from and date < date_from:
            hit_old = True
            continue
        if date_to and date > date_to:
            continue

        items.append({'title': title, 'url': post_url, 'date': date})

    return {'items': items, 'hitOld': hit_old}


_BASE_HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Upgrade-Insecure-Requests': '1',
}
# 시도 순서: 성공률 높은 프로파일 우선, 전체 소요 시간 최소화
_ATTEMPTS = [
    ('direct', 'chrome124', 'www'),
    ('direct', 'chrome120', 'www'),
    ('mobile', 'chrome124', 'm'),
    ('direct', 'chrome116', 'www'),
    ('mobile', 'safari17_0', 'm'),
]


def _is_valid_fmkorea(html):
    return len(html) > 5000 and ('fmkorea' in html or 'baseball_game' in html) and '<tbody' in html


def _fetch_via_allorigins(url):
    """allorigins.win 공개 프록시 경유 — Vercel IP 차단 우회용"""
    import urllib.request
    proxy_url = f'https://api.allorigins.win/get?url={quote_plus(url)}'
    try:
        req = urllib.request.Request(proxy_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=12) as resp:
            import json as _json
            body = _json.loads(resp.read().decode('utf-8'))
            return body.get('contents', '')
    except Exception as e:
        return ''


def fetch_html(url):
    """FM코리아 HTML 수집: curl_cffi 직접 → allorigins 프록시 순서로 시도"""
    try:
        from curl_cffi import requests as cffi_requests
        has_cffi = True
    except ImportError:
        has_cffi = False

    errors = []

    # 1순위: curl_cffi 직접 접근 (로컬/일부 Vercel 리전에서 작동)
    if has_cffi:
        for mode, profile, domain in _ATTEMPTS[:2]:  # 처음 2개만 빠르게 시도
            target = url.replace('www.fmkorea.com', f'{domain}.fmkorea.com')
            referer = f'https://{domain}.fmkorea.com/'
            try:
                r = cffi_requests.get(target, impersonate=profile, timeout=6, headers={
                    **_BASE_HEADERS,
                    'Referer': referer,
                    'Sec-Fetch-Site': 'same-origin',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                })
                html = r.text
                if _is_valid_fmkorea(html):
                    return html, f'{mode}/{profile}'
                errors.append(f'{mode}/{profile}:{len(html)}자')
            except Exception as e:
                errors.append(f'{mode}/{profile}:{type(e).__name__}')

    # 2순위: allorigins 공개 프록시 (Vercel IP 차단 우회)
    html = _fetch_via_allorigins(url)
    if _is_valid_fmkorea(html):
        return html, 'allorigins'
    errors.append(f'allorigins:{len(html)}자')

    # 3순위: 모바일 URL + allorigins
    mobile_url = url.replace('www.fmkorea.com', 'm.fmkorea.com')
    html = _fetch_via_allorigins(mobile_url)
    if len(html) > 3000 and 'fmkorea' in html and '<tbody' in html:
        return html, 'allorigins-mobile'
    errors.append(f'allorigins-mobile:{len(html)}자')

    return '', ' | '.join(errors)


class handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        def p(k, default=''):
            v = params.get(k, [default])
            return v[0] if v else default

        category = p('category')
        page = max(1, int(p('page', '1') or '1'))
        date_from = p('dateFrom')
        date_to = p('dateTo')

        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

        if category == 'ping':
            self._write({'pong': True, '_version': 'v3-allorigins'})
            return

        if not category:
            self._write({'_error': 'category required'})
            return

        url = f'https://www.fmkorea.com/index.php?mid=baseball_game&category={category}&page={page}'
        today = today_kst()

        html, via = fetch_html(url)

        if not html:
            self._write({
                'items': [], 'page': page, 'hitOld': False,
                '_error': f'수집 실패: {via}',
            })
            return

        result = parse_articles(html, today, date_from, date_to)
        self._write({
            'items': result['items'],
            'page': page,
            'hitOld': result['hitOld'],
            '_htmlLen': len(html),
            '_via': via,
        })

    def _write(self, obj):
        self.wfile.write(json.dumps(obj, ensure_ascii=False).encode('utf-8'))
