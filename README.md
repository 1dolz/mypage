# 매체 raw 허브 (1단계: 뼈대)

지금 포함된 기능: 로그인 보호, 설정 관리(키-값), 수동 raw 업로드(텐핑/바리스타/Appier/ASA/X), raw 데이터 조회. 매체 API 자동 수집(Meta/Google Ads/TikTok/Adpopcorn)은 다음 단계에서 추가합니다.

## 배포 방법 (Node.js 설치 없이, GitHub + Railway)

### 1. GitHub에 업로드
1. github.com 가입 (이미 있으면 로그인)
2. 우측 상단 + → New repository → 이름 입력(예: media-raw-hub) → Create
3. "Add file" → "Upload files" 클릭 → `node_modules` 폴더만 빼고 나머지 파일/폴더 전부 드래그해서 업로드 → Commit

### 2. Railway 배포
1. railway.app 가입 (GitHub 계정으로 로그인 가능)
2. New Project → Deploy from GitHub repo → 방금 만든 저장소 선택
3. 같은 프로젝트 안에서 New → Database → Add PostgreSQL 클릭 (DATABASE_URL이 자동으로 앱에 연결됩니다)
4. 앱 서비스 클릭 → Variables 탭 → 아래 두 개 추가
   - `ADMIN_PASSWORD` = 원하는 로그인 비밀번호
   - `SESSION_SECRET` = 아무 임의의 긴 문자열
5. Settings 탭 → Networking → "Generate Domain" 클릭 → 나온 주소로 접속

접속해서 `ADMIN_PASSWORD`로 로그인하면 화면이 뜹니다. 설정 메뉴에서 API 토큰들을 하나씩 등록해두시면 다음 단계(매체별 자동 수집)에서 그대로 사용합니다.

## 로컬에서 테스트하려면 (선택사항)
Node.js가 설치되어 있어야 합니다.
```
npm install
cp .env.example .env   # 값 채워넣기 (로컬 Postgres 필요)
npm start
```
