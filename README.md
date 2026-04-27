# ⚾ 야구 게임 커뮤니티 수집 툴

DC인사이드, 공식 커뮤니티, 네이버 카페 게시글을 자동 수집하는 웹 툴입니다.

## 배포 방법 (Vercel)

1. 이 저장소를 GitHub에 올리기
2. [vercel.com](https://vercel.com)에서 GitHub 저장소 연결
3. Environment Variables에 아래 두 가지 추가:
   - `NAVER_CLIENT_ID` = 네이버 API Client ID
   - `NAVER_CLIENT_SECRET` = 네이버 API Client Secret
4. Deploy 클릭

## 파일 구조

```
├── index.html       # 메인 UI
├── api/
│   └── naver.js     # 네이버 API 중계 (서버리스 함수)
└── vercel.json      # Vercel 설정
```
