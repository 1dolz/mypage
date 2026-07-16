require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const multer = require('multer');
const XLSX = require('xlsx');
const cron = require('node-cron');
const bcrypt = require('bcryptjs');

const db = require('./db');
const { fetchMetaAds } = require('./fetchers/meta');
const { fetchGoogleBranding, exchangeAuthCodeForRefreshToken } = require('./fetchers/googleAds');
const { fetchTikTokAds, exchangeAuthCodeForAccessToken: exchangeTikTokAuthCode } = require('./fetchers/tiktok');
const { fetchAppleAds } = require('./fetchers/appleAds');
const { fetchAdpopcorn } = require('./fetchers/adpopcorn');
const { fetchNaverAds } = require('./fetchers/naver');
const { parseManualUploadFile, DEFAULT_FIELD_MAP } = require('./lib/manualUpload');

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

// ===== 계정/로그인 =====
// 회사 이메일(@thesmc.co.kr)만 가입 가능. 필요하면 ALLOWED_EMAIL_DOMAIN 환경변수로 바꿀 수 있음.
const ALLOWED_EMAIL_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || 'thesmc.co.kr').toLowerCase();

function isAllowedEmail(email) {
  return String(email || '').toLowerCase().trim().endsWith('@' + ALLOWED_EMAIL_DOMAIN);
}

function requireLogin(req, res, next) {
  if (req.session.userId) return next();
  res.redirect('/login');
}

app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('login', { error: null, allowedDomain: ALLOWED_EMAIL_DOMAIN });
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = email ? await db.getUserByEmail(email) : null;
    const ok = user && (await bcrypt.compare(password || '', user.password_hash));
    if (!ok) {
      return res.render('login', { error: '이메일 또는 비밀번호가 틀렸습니다.', allowedDomain: ALLOWED_EMAIL_DOMAIN });
    }
    req.session.userId = user.id;
    req.session.userEmail = user.email;
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.render('login', { error: '로그인 처리 중 오류가 발생했습니다.', allowedDomain: ALLOWED_EMAIL_DOMAIN });
  }
});

app.get('/signup', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('signup', { error: null, allowedDomain: ALLOWED_EMAIL_DOMAIN });
});

app.post('/signup', async (req, res) => {
  const { email, password, passwordConfirm } = req.body;
  const renderError = (error) => res.render('signup', { error, allowedDomain: ALLOWED_EMAIL_DOMAIN });

  if (!email || !password) {
    return renderError('이메일과 비밀번호를 입력해주세요.');
  }
  if (!isAllowedEmail(email)) {
    return renderError(`@${ALLOWED_EMAIL_DOMAIN} 이메일로만 가입할 수 있습니다.`);
  }
  if (password.length < 8) {
    return renderError('비밀번호는 8자 이상이어야 합니다.');
  }
  if (password !== passwordConfirm) {
    return renderError('비밀번호가 일치하지 않습니다.');
  }

  try {
    const existing = await db.getUserByEmail(email);
    if (existing) {
      return renderError('이미 가입된 이메일입니다.');
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await db.createUser(email, passwordHash);
    req.session.userId = user.id;
    req.session.userEmail = user.email;
    res.redirect('/');
  } catch (err) {
    console.error(err);
    renderError('가입 처리 중 오류가 발생했습니다.');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// 지금 서버가 외부로 나갈 때 쓰는 IP 확인용 (Adpopcorn 같은 IP 화이트리스트 API 등록할 때 사용).
// 확인 후에는 지워도 됨.
app.get('/debug/outbound-ip', requireLogin, async (req, res) => {
  try {
    const ipRes = await fetch('https://api.ipify.org?format=json');
    const data = await ipRes.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== 대시보드 (raw 데이터 조회) =====
app.get('/', requireLogin, async (req, res) => {
  const { source, startDate, endDate } = req.query;
  const rows = await db.queryRawData(req.session.userId, { source, startDate, endDate });
  const totals = await db.sumRawData(req.session.userId, { source, startDate, endDate });
  const sources = await db.distinctSources(req.session.userId);
  res.render('dashboard', {
    rows,
    totals,
    sources,
    filters: { source, startDate, endDate },
    userEmail: req.session.userEmail,
  });
});

// 특정 매체의 raw 데이터를 통째로 삭제 (테스트 데이터/이름 바뀐 매체 정리용)
app.post('/delete-source', requireLogin, async (req, res) => {
  const { source } = req.body;
  if (source) {
    await db.pool.query('DELETE FROM raw_data WHERE user_id = $1 AND source = $2', [req.session.userId, source]);
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
  const rows = await db.queryRawData(req.session.userId, { source, startDate, endDate, limit: 50000 });
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
  const rows = await db.queryRawData(req.session.userId, { source, startDate, endDate, limit: 50000 });
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
// 매체 목록과 컬럼 매핑은 더 이상 코드에 하드코딩하지 않고 manual_sources 테이블(=/settings 화면)에서 관리함.
// 업로드는 대시보드에서 분리된 별도 화면으로 제공 (드래그앤드롭 지원)
app.get('/upload', requireLogin, async (req, res) => {
  const manualSources = await db.getManualSources(req.session.userId);
  res.render('upload', { manualSources, userEmail: req.session.userEmail });
});

// 업로드 화면에서 매체 카드를 드래그로 재배열했을 때 순서를 저장 (JSON 바디: { order: ['apple', 'x', ...] })
app.post('/settings/manual-sources/reorder', requireLogin, async (req, res) => {
  const { order } = req.body;
  if (Array.isArray(order) && order.length > 0) {
    await db.reorderManualSources(req.session.userId, order);
  }
  res.json({ ok: true });
});

app.post('/upload', requireLogin, upload.single('file'), async (req, res) => {
  try {
    const userId = req.session.userId;
    const source = req.body.source;
    const sourceConfig = await db.getManualSource(userId, source);
    if (!sourceConfig) {
      return res.status(400).send('알 수 없는 매체입니다. (/settings에서 매체를 먼저 등록해주세요)');
    }
    if (!req.file) return res.status(400).send('파일이 없습니다.');

    const filename = req.file.originalname || '';
    const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
    const marginRate = parseFloat(await db.getSetting(userId, 'MARGIN_RATE', '0.85')) || 0.85;
    const defaultsMap = await db.getManualDefaults(userId);

    const rows = parseManualUploadFile(req.file.buffer, ext, sourceConfig, { marginRate, defaultsMap });

    await db.replaceSourceData(userId, source, rows);
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
  {
    id: 'adpopcorn',
    label: 'Adpopcorn',
    fields: [
      { key: 'ADPOPCORN_ACCESS_TOKEN', label: 'Access Token', type: 'password' },
      {
        key: 'ADPOPCORN_FILTER_CAMPAIGNS',
        label: '집계할 캠페인명 (한 줄에 하나씩, 비워두면 전체 포함)',
        type: 'textarea',
      },
    ],
  },
  {
    id: 'naver',
    label: '네이버',
    fields: [
      { key: 'NAVER_API_KEY', label: 'API Key' },
      { key: 'NAVER_SECRET_KEY', label: 'Secret Key', type: 'password' },
      { key: 'NAVER_CUSTOMER_ID', label: 'Customer ID' },
    ],
  },
];

app.get('/settings', requireLogin, async (req, res) => {
  const userId = req.session.userId;
  const settings = await db.getSettings(userId);
  const settingsMap = {};
  settings.forEach((s) => {
    settingsMap[s.key] = s.value;
  });

  // 매체별 스키마에 포함된 키는 일반 설정 목록(키-값 테이블)에서는 숨겨서
  // 각자의 탭에서만 관리하도록 함
  const mediaKeys = new Set(MEDIA_SETTINGS_SCHEMA.flatMap((m) => m.fields.map((f) => f.key)));
  const generalSettings = settings.filter((s) => !mediaKeys.has(s.key));

  const manualSources = await db.getManualSources(userId);
  const manualDefaults = await db.getManualDefaults(userId);

  // 수동 업로드 매체 탭에서 선택된 매체 (드롭다운으로 고름). 없으면 첫 번째 매체, 그것도 없으면 "새 매체 추가" 상태.
  const selectedManualId =
    req.query.manualId !== undefined ? req.query.manualId : manualSources[0] ? manualSources[0].id : 'new';
  const selectedManual = manualSources.find((m) => m.id === selectedManualId) || null;

  res.render('settings', {
    settings: generalSettings,
    settingsMap,
    mediaSchema: MEDIA_SETTINGS_SCHEMA,
    manualSources,
    manualDefaults,
    selectedManualId,
    selectedManual,
    saved: req.query.saved === '1',
    userEmail: req.session.userEmail,
  });
});

// ===== 수동 업로드 매체 관리 (매체 추가/수정/삭제를 코드 수정 없이 이 화면에서) =====
const MANUAL_UPLOAD_FIELD_KEYS = [
  'date',
  'campaign_name',
  'adgroup_name',
  'ad_name',
  'cost',
  'impressions',
  'clicks',
  'installs',
];

// 모든 매체에 공통으로 적용되는 기본 컬럼명 저장 (매체별 재정의보다 우선순위가 낮음)
app.post('/settings/manual-defaults', requireLogin, async (req, res) => {
  const map = {};
  for (const key of MANUAL_UPLOAD_FIELD_KEYS) {
    map[key] = req.body[`default_${key}`] || '';
  }
  await db.setManualDefaults(req.session.userId, map);
  res.redirect('/settings?saved=1#tab-manual');
});

app.post('/settings/manual-sources', requireLogin, async (req, res) => {
  const { id, label, ad_name_prefix, cost_multiplier, apply_margin_rate } = req.body;

  if (!id || !id.trim()) {
    return res.status(400).send('매체 ID를 입력해주세요.');
  }
  const cleanId = id.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');

  const field_map = {};
  for (const key of MANUAL_UPLOAD_FIELD_KEYS) {
    field_map[key] = req.body[`field_${key}`] || '';
  }

  await db.upsertManualSource(req.session.userId, {
    id: cleanId,
    label: label || cleanId,
    field_map,
    cost_multiplier: parseFloat(cost_multiplier) || 1,
    apply_margin_rate: apply_margin_rate === '1' || apply_margin_rate === 'on',
    ad_name_prefix: ad_name_prefix || '',
  });

  res.redirect(`/settings?manualId=${encodeURIComponent(cleanId)}&saved=1#tab-manual`);
});

app.post('/settings/manual-sources/delete', requireLogin, async (req, res) => {
  const { id } = req.body;
  if (id) await db.deleteManualSource(req.session.userId, id);
  res.redirect('/settings?saved=1#tab-manual');
});

app.post('/settings', requireLogin, async (req, res) => {
  const { key, value } = req.body;
  if (key) await db.setSetting(req.session.userId, key.trim(), value || '');
  res.redirect('/settings?saved=1');
});

app.post('/settings/media', requireLogin, async (req, res) => {
  const { source, ...fields } = req.body;
  const group = MEDIA_SETTINGS_SCHEMA.find((m) => m.id === source);
  if (!group) return res.status(400).send('알 수 없는 매체입니다.');

  for (const { key } of group.fields) {
    if (fields[key] !== undefined) {
      await db.setSetting(req.session.userId, key, fields[key]);
    }
  }
  res.redirect('/settings?saved=1');
});

app.post('/settings/delete', requireLogin, async (req, res) => {
  const { key } = req.body;
  if (key) await db.deleteSetting(req.session.userId, key);
  res.redirect('/settings?saved=1');
});

// Google Ads Refresh Token 최초 발급 (OAuth 인증 코드 → Refresh Token 교환)
app.post('/settings/google-ads/exchange-code', requireLogin, async (req, res) => {
  try {
    const userId = req.session.userId;
    const clientId = await db.getSetting(userId, 'GOOGLE_CLIENT_ID');
    const clientSecret = await db.getSetting(userId, 'GOOGLE_CLIENT_SECRET');
    const { authCode } = req.body;

    if (!clientId || !clientSecret) {
      return res.status(400).send('먼저 Client ID / Client Secret을 저장해주세요.');
    }
    if (!authCode) {
      return res.status(400).send('인증 코드를 입력해주세요.');
    }

    const refreshToken = await exchangeAuthCodeForRefreshToken({ clientId, clientSecret, authCode });
    await db.setSetting(userId, 'GOOGLE_REFRESH_TOKEN', refreshToken);
    res.redirect('/settings?saved=1');
  } catch (err) {
    res.status(500).send('Refresh Token 발급 실패: ' + err.message);
  }
});

// TikTok Access Token 최초 발급 (App ID/Secret/Auth Code → Access Token + Advertiser ID 교환)
app.post('/settings/tiktok/exchange-code', requireLogin, async (req, res) => {
  try {
    const userId = req.session.userId;
    const appId = await db.getSetting(userId, 'TIKTOK_APP_ID');
    const secret = await db.getSetting(userId, 'TIKTOK_APP_SECRET');
    const authCode = await db.getSetting(userId, 'TIKTOK_AUTH_CODE');

    if (!appId || !secret || !authCode) {
      return res.status(400).send('App ID / Secret / Auth Code를 먼저 저장해주세요.');
    }

    const { accessToken, advertiserId } = await exchangeTikTokAuthCode({ appId, secret, authCode });
    await db.setSetting(userId, 'TIKTOK_ACCESS_TOKEN', accessToken);
    if (advertiserId) await db.setSetting(userId, 'TIKTOK_ADVERTISER_ID', advertiserId);
    res.redirect('/settings?saved=1');
  } catch (err) {
    res.status(500).send('TikTok Access Token 발급 실패: ' + err.message);
  }
});

// ===== 매체별 자동 수집 (계정별로 각자의 인증 정보를 사용) =====
async function runFetchersForUser(userId) {
  console.log(`[cron] 매체 자동 수집 시작 (user ${userId})`);

  try {
    await fetchMetaAds(userId);
  } catch (err) {
    console.error(`[cron] (user ${userId}) Meta 수집 실패:`, err.message);
  }

  try {
    await fetchGoogleBranding(userId);
  } catch (err) {
    console.error(`[cron] (user ${userId}) Google Ads 수집 실패:`, err.message);
  }

  try {
    await fetchTikTokAds(userId);
  } catch (err) {
    console.error(`[cron] (user ${userId}) TikTok 수집 실패:`, err.message);
  }

  try {
    await fetchAppleAds(userId);
  } catch (err) {
    console.error(`[cron] (user ${userId}) Apple Search Ads 수집 실패:`, err.message);
  }

  try {
    await fetchAdpopcorn(userId);
  } catch (err) {
    console.error(`[cron] (user ${userId}) Adpopcorn 수집 실패:`, err.message);
  }

  try {
    await fetchNaverAds(userId);
  } catch (err) {
    console.error(`[cron] (user ${userId}) 네이버 수집 실패:`, err.message);
  }
}

// 가입된 모든 계정을 순서대로 돌면서 각자의 인증 정보로 자동 수집 (cron이 호출)
async function runAllFetchers() {
  const users = await db.getAllUsers();
  for (const user of users) {
    await runFetchersForUser(user.id);
  }
}

// 매일 오전 9시 (Asia/Seoul) 자동 실행 - 계정 전체를 순서대로 수집
cron.schedule('0 9 * * *', runAllFetchers, { timezone: 'Asia/Seoul' });

// 수동으로 즉시 실행해보고 싶을 때 쓰는 엔드포인트 - 현재 로그인한 계정만 실행
app.post('/run-now', requireLogin, async (req, res) => {
  await runFetchersForUser(req.session.userId);
  res.redirect('/');
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  db.initDb()
    .then(() => {
      app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
    })
    .catch((err) => {
      console.error('DB 초기화 실패:', err);
      process.exit(1);
    });
}

module.exports = app;
