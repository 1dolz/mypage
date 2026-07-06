require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const cron = require('node-cron');

const db = require('./db');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }, // 7일 유지
  })
);

// ===== 로그인 보호 =====
function requireLogin(req, res, next) {
  if (req.session.loggedIn) return next();
  res.redirect('/login');
}

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    return res.redirect('/');
  }
  res.render('login', { error: '비밀번호가 틀렸습니다.' });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ===== 대시보드 (raw 데이터 조회) =====
app.get('/', requireLogin, async (req, res) => {
  const { source, startDate, endDate } = req.query;
  const rows = await db.queryRawData({ source, startDate, endDate });
  const sources = await db.distinctSources();
  res.render('dashboard', { rows, sources, filters: { source, startDate, endDate } });
});

// ===== 수동 raw 업로드 =====
const MANUAL_SOURCES = ['tenping', 'valista', 'appier', 'asa_raw', 'x_raw'];

app.post('/upload', requireLogin, upload.single('file'), async (req, res) => {
  try {
    const source = req.body.source;
    if (!MANUAL_SOURCES.includes(source)) {
      return res.status(400).send('알 수 없는 매체입니다.');
    }
    if (!req.file) return res.status(400).send('파일이 없습니다.');

    const filename = req.file.originalname || '';
    const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();

    let records;
    if (ext === 'xlsx' || ext === 'xls') {
      // 엑셀 파일: 첫 번째 시트를 헤더 기준 객체 배열로 변환
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const firstSheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[firstSheetName];
      records = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    } else {
      // CSV 파일 (기본값)
      const text = req.file.buffer.toString('utf-8');
      records = parse(text, { columns: true, skip_empty_lines: true, trim: true });
    }

    // 매체별 컬럼 매핑은 다음 단계에서 채워 넣을 예정 (지금은 원본 그대로 저장)
    const rows = records.map((r) => ({
      date: r['Date'] || r['날짜'] || r['Time period'] || null,
      campaign_name: r['Campaign'] || r['캠페인'] || r['Campaign Name'] || '',
      adgroup_name: r['Ad group'] || r['광고그룹'] || r['Ad Group Name'] || '',
      ad_name: r['Ad name'] || r['광고명'] || r['Creative name'] || '',
      cost: parseFloat(String(r['Spend'] || r['비용'] || '0').replace(/[^0-9.-]/g, '')) || 0,
      impressions: parseFloat(String(r['Impressions'] || r['노출'] || '0').replace(/[^0-9.-]/g, '')) || 0,
      clicks: parseFloat(String(r['Clicks'] || r['클릭'] || '0').replace(/[^0-9.-]/g, '')) || 0,
      installs: parseFloat(String(r['Installs'] || r['설치'] || r['Actions'] || '0').replace(/[^0-9.-]/g, '')) || 0,
      extra: r,
    }));

    await db.replaceSourceData(source, rows);
    res.redirect(`/?source=${source}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('업로드 처리 중 오류: ' + err.message);
  }
});

// ===== 설정 관리 =====
app.get('/settings', requireLogin, async (req, res) => {
  const settings = await db.getSettings();
  res.render('settings', { settings, saved: req.query.saved === '1' });
});

app.post('/settings', requireLogin, async (req, res) => {
  const { key, value } = req.body;
  if (key) await db.setSetting(key.trim(), value || '');
  res.redirect('/settings?saved=1');
});

app.post('/settings/delete', requireLogin, async (req, res) => {
  const { key } = req.body;
  if (key) await db.deleteSetting(key);
  res.redirect('/settings?saved=1');
});

// ===== 매체별 자동 수집 함수 자리 (다음 단계에서 채워 넣을 예정) =====
async function runAllFetchers() {
  console.log('[cron] 매체 자동 수집 시작 (아직 구현 전)');
  // TODO: fetchMeta(), fetchTikTok(), fetchGoogleAds(), fetchAdpopcorn() 등을 여기서 순서대로 호출
}

// 매일 오전 9시 (Asia/Seoul) 자동 실행
cron.schedule('0 9 * * *', runAllFetchers, { timezone: 'Asia/Seoul' });

// 수동으로 즉시 실행해보고 싶을 때 쓰는 엔드포인트
app.post('/run-now', requireLogin, async (req, res) => {
  await runAllFetchers();
  res.redirect('/');
});

const PORT = process.env.PORT || 3000;

db.initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('DB 초기화 실패:', err);
    process.exit(1);
  });
