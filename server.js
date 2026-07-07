require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const cron = require('node-cron');

const db = require('./db');
const { fetchMetaAds } = require('./fetchers/meta');
const { fetchGoogleBranding, exchangeAuthCodeForRefreshToken } = require('./fetchers/googleAds');
const { fetchTikTokAds, exchangeAuthCodeForAccessToken: exchangeTikTokAuthCode } = require('./fetchers/tiktok');
const { fetchAppleAds } = require('./fetchers/appleAds');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use(
  session({
    // 세션을 서버 메모리가 아니라 Postgres에 저장.
    // Serverless 모드로 컨테이너가 잠들었다 깨어나도 로그인이 풀리지 않도록 함.
    store: new pgSession({
      pool: db.pool,
      tableName: 'session',
      createTableIfMissing: true,
    }),
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

// 특정 매체의 raw 데이터를 통째로 삭제 (테스트 데이터/이름 바뀐 매체 정리용)
app.post('/delete-source', requireLogin, async (req, res) => {
  const { source } = req.body;
  if (source) {
    await db.pool.query('DELETE FROM raw_data WHERE source = $1', [source]);
  }
  res.redirect('/');
});

// ===== 조회 결과 내보내기 (CSV / Excel) =====
function buildExportRows(rows) {
  const headers = ['날짜', '매체', '캠페인', '광고그룹', '광고명', '비용', '노출', '클릭', '설치'];
  const dataRows = rows.map((r) => [
    r.date ? new Date(r.date).toISOString().slice(0, 10) : '',
    r.source,
    r.campaign_name,
    r.adgroup_name,
    r.ad_name,
    Number(r.cost) || 0,
    Number(r.impressions) || 0,
    Number(r.clicks) || 0,
    Number(r.installs) || 0,
  ]);
  return { headers, dataRows };
}

function toCsvValue(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

app.get('/export.csv', requireLogin, async (req, res) => {
  const { source, startDate, endDate } = req.query;
  const rows = await db.queryRawData({ source, startDate, endDate, limit: 50000 });
  const { headers, dataRows } = buildExportRows(rows);

  const lines = [headers, ...dataRows].map((row) => row.map(toCsvValue).join(','));
  const BOM = '﻿'; // 엑셀에서 한글 깨짐 방지
  const csv = BOM + lines.join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="raw_data_${Date.now()}.csv"`);
  res.send(csv);
});

app.get('/export.xlsx', requireLogin, async (req, res) => {
  const { source, startDate, endDate } = req.query;
  const rows = await db.queryRawData({ source, startDate, endDate, limit: 50000 });
  const { headers, dataRows } = buildExportRows(rows);

  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'raw_data');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="raw_data_${Date.now()}.xlsx"`);
  res.send(buffer);
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
// 매체별 연동에 필요한 값들을 탭으로 묶어서 보여주기 위한 스키마.
// 매체 연동을 추가할 때마다 여기에 그룹을 추가하면 /settings 화면에 탭이 자동으로 생김.
const MEDIA_SETTINGS_SCHEMA = [
  {
    id: 'meta',
    label: 'Meta',
    fields: [
      { key: 'META_APP_ID', label: 'App ID' },
      { key: 'META_APP_SECRET', label: 'App Secret', type: 'password' },
      { key: 'META_AD_ACCOUNT_ID', label: 'Ad Account ID (act_로 시작)' },
      { key: 'META_ACCESS_TOKEN', label: 'Access Token', type: 'password' },
    ],
  },
  {
    id: 'google_ads',
    label: 'Google Ads',
    fields: [
      { key: 'GOOGLE_DEVELOPER_TOKEN', label: 'Developer Token', type: 'password' },
      { key: 'GOOGLE_CLIENT_ID', label: 'Client ID' },
      { key: 'GOOGLE_CLIENT_SECRET', label: 'Client Secret', type: 'password' },
      { key: 'GOOGLE_CUSTOMER_ID', label: 'Customer ID' },
      { key: 'GOOGLE_MCC_ID', label: 'MCC ID' },
      { key: 'GOOGLE_REFRESH_TOKEN', label: 'Refresh Token', type: 'password' },
    ],
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    fields: [
      { key: 'TIKTOK_APP_ID', label: 'App ID' },
      { key: 'TIKTOK_APP_SECRET', label: 'Secret', type: 'password' },
      { key: 'TIKTOK_AUTH_CODE', label: 'Auth Code (최초 발급용, 1회용)', type: 'password' },
      { key: 'TIKTOK_ACCESS_TOKEN', label: 'Access Token', type: 'password' },
      { key: 'TIKTOK_ADVERTISER_ID', label: 'Advertiser ID' },
    ],
  },
  {
    id: 'apple',
    label: 'Apple',
    fields: [
      { key: 'APPLE_CLIENT_ID', label: 'Client ID' },
      { key: 'APPLE_TEAM_ID', label: 'Team ID' },
      { key: 'APPLE_KEY_ID', label: 'Key ID' },
      { key: 'APPLE_ORG_ID', label: 'Org ID' },
      { key: 'APPLE_PRIVATE_KEY', label: 'Private Key (.p8 파일 내용 전체)', type: 'textarea' },
    ],
  },
];

app.get('/settings', requireLogin, async (req, res) => {
  const settings = await db.getSettings();
  const settingsMap = {};
  settings.forEach((s) => {
    settingsMap[s.key] = s.value;
  });

  // 매체별 스키마에 포함된 키는 일반 설정 목록(키-값 테이블)에서는 숨겨서
  // 각자의 탭에서만 관리하도록 함
  const mediaKeys = new Set(MEDIA_SETTINGS_SCHEMA.flatMap((m) => m.fields.map((f) => f.key)));
  const generalSettings = settings.filter((s) => !mediaKeys.has(s.key));

  res.render('settings', {
    settings: generalSettings,
    settingsMap,
    mediaSchema: MEDIA_SETTINGS_SCHEMA,
    saved: req.query.saved === '1',
  });
});

app.post('/settings', requireLogin, async (req, res) => {
  const { key, value } = req.body;
  if (key) await db.setSetting(key.trim(), value || '');
  res.redirect('/settings?saved=1');
});

app.post('/settings/media', requireLogin, async (req, res) => {
  const { source, ...fields } = req.body;
  const group = MEDIA_SETTINGS_SCHEMA.find((m) => m.id === source);
  if (!group) return res.status(400).send('알 수 없는 매체입니다.');

  for (const { key } of group.fields) {
    if (fields[key] !== undefined) {
      await db.setSetting(key, fields[key]);
    }
  }
  res.redirect('/settings?saved=1');
});

app.post('/settings/delete', requireLogin, async (req, res) => {
  const { key } = req.body;
  if (key) await db.deleteSetting(key);
  res.redirect('/settings?saved=1');
});

// Google Ads Refresh Token 최초 발급 (OAuth 인증 코드 → Refresh Token 교환)
app.post('/settings/google-ads/exchange-code', requireLogin, async (req, res) => {
  try {
    const clientId = await db.getSetting('GOOGLE_CLIENT_ID');
    const clientSecret = await db.getSetting('GOOGLE_CLIENT_SECRET');
    const { authCode } = req.body;

    if (!clientId || !clientSecret) {
      return res.status(400).send('먼저 Client ID / Client Secret을 저장해주세요.');
    }
    if (!authCode) {
      return res.status(400).send('인증 코드를 입력해주세요.');
    }

    const refreshToken = await exchangeAuthCodeForRefreshToken({ clientId, clientSecret, authCode });
    await db.setSetting('GOOGLE_REFRESH_TOKEN', refreshToken);
    res.redirect('/settings?saved=1');
  } catch (err) {
    res.status(500).send('Refresh Token 발급 실패: ' + err.message);
  }
});

// TikTok Access Token 최초 발급 (App ID/Secret/Auth Code → Access Token + Advertiser ID 교환)
app.post('/settings/tiktok/exchange-code', requireLogin, async (req, res) => {
  try {
    const appId = await db.getSetting('TIKTOK_APP_ID');
    const secret = await db.getSetting('TIKTOK_APP_SECRET');
    const authCode = await db.getSetting('TIKTOK_AUTH_CODE');

    if (!appId || !secret || !authCode) {
      return res.status(400).send('App ID / Secret / Auth Code를 먼저 저장해주세요.');
    }

    const { accessToken, advertiserId } = await exchangeTikTokAuthCode({ appId, secret, authCode });
    await db.setSetting('TIKTOK_ACCESS_TOKEN', accessToken);
    if (advertiserId) await db.setSetting('TIKTOK_ADVERTISER_ID', advertiserId);
    res.redirect('/settings?saved=1');
  } catch (err) {
    res.status(500).send('TikTok Access Token 발급 실패: ' + err.message);
  }
});

// ===== 매체별 자동 수집 함수 자리 (순서대로 채워 넣는 중) =====
async function runAllFetchers() {
  console.log('[cron] 매체 자동 수집 시작');

  try {
    await fetchMetaAds();
  } catch (err) {
    console.error('[cron] Meta 수집 실패:', err.message);
  }

  try {
    await fetchGoogleBranding();
  } catch (err) {
    console.error('[cron] Google Ads 수집 실패:', err.message);
  }

  try {
    await fetchTikTokAds();
  } catch (err) {
    console.error('[cron] TikTok 수집 실패:', err.message);
  }

  try {
    await fetchAppleAds();
  } catch (err) {
    console.error('[cron] Apple Search Ads 수집 실패:', err.message);
  }

  // TODO: fetchAdpopcorn() 등을 여기서 순서대로 호출
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
