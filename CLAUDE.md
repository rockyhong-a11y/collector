# 커뮤니티 수집 툴 — Claude 작업 가이드

## 버전 관리 규칙

`index.html` 상단 badge(`<span class="badge">vX.Y</span>`)를 변경 규모에 맞게 업데이트한다.

| 변경 유형 | 단위 | 예시 |
|-----------|------|------|
| 마이너 수정 (버그 수정, 키워드 추가, UI 소폭 조정 등) | +0.1 | v4.0 → v4.1 |
| 메이저 수정 (신규 기능, 수집 구조 변경, 분류 체계 전면 개편 등) | +1.0 | v4.0 → v5.0 |

- **자동화**: `index.html`을 수정하면 PostToolUse 훅이 자동으로 0.1 올림
- **메이저 트리거**: 메이저 작업 시작 전 `touch /tmp/collector-major-bump` 실행 → 다음 `index.html` 수정 시 1.0 올림
- **훅 미작동 환경**: 작업 완료 후 직접 badge 값을 수정 규모에 맞게 업데이트할 것

## 배포 구조

- **정적 파일**: `index.html` (단일 파일 SPA)
- **서버리스**: `api/proxy.js` (Vercel — CORS 우회 프록시)
- **배포 대상**: `main` 브랜치 → Vercel 자동 배포
- **개발 브랜치**: `claude/fix-community-keyword-bug-Y2Avs` (현재 작업 브랜치)

## 주요 파일

| 파일 | 역할 |
|------|------|
| `index.html` | 수집 툴 전체 UI + 스크래퍼 로직 |
| `api/proxy.js` | CORS 우회용 Vercel 서버리스 프록시 |
| `api/naver.js` | 네이버카페 API 중계 |
| `manifest.json` / `sw.js` | PWA 지원 |

## 수집 사이트

- DC인사이드 마이너갤러리 (컴프야V / MLB라이벌 / 컴프야26 / MLB9이닝스)
- 공식 커뮤니티 (cpbv-community.com2us.com / community.withhive.com)
- 네이버카페 (컴프야26 / MLB9이닝스)

## 분류 체계

우선순위 순: **버그/이슈** → **문의/질문** → **의견/평가**

- 분류 키워드: `BUG_KW`, `INQUIRY_KW`, `OPINION_KW` (index.html 내 정의)
- 2차 필터: 제목·본문·댓글에 BUG/INQUIRY 키워드가 없는 글 제외
- 자가 학습: localStorage 기반 (`collector.learnedKW.v1`)
