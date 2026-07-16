const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { DEFAULT_FIELD_MAP } = require('./lib/manualUpload');

const MANUAL_DEFAULTS_SETTING_KEY = 'MANUAL_DEFAULT_FIELD_MAP';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

// 기존에 1인 전용으로 쓰던 앱을 계정별로 분리하면서, ADMIN_PASSWORD로 로그인하던
// 계정이 있으면 그대로 첫 계정으로 이전하고 기존 데이터도 그 계정 소유로 넘겨줌.
async function ensureBootstrapUser() {
  const { rows } = await pool.query('SELECT COUNT(*) FROM users');
  const userCount = parseInt(rows[0].count, 10);
  if (userCount > 0) return null; // 이미 계정이 있으면(=이미 이전 완료) 건드리지 않음

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) return null; // 이전할 기존 계정이 없음 (완전 새 설치)

  const email = (process.env.ADMIN_EMAIL || 'admin@thesmc.co.kr').toLowerCase();
  const passwordHash = await bcrypt.hash(adminPassword, 10);
  const { rows: inserted } = await pool.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id',
    [email, passwordHash]
  );
  return inserted[0] ? inserted[0].id : null;
}

// 서버 시작 시 필요한 테이블을 자동으로 만들어줍니다 (이미 있으면 건너뜀)
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS raw_data (
      id SERIAL PRIMARY KEY,
      source TEXT NOT NULL,           -- meta, tiktok, google_ads, adpopcorn, asa, tenping, valista, appier, x 등
      date DATE,
      campaign_name TEXT,
      adgroup_name TEXT,
      ad_name TEXT,
      cost NUMERIC DEFAULT 0,
      impressions NUMERIC DEFAULT 0,
      clicks NUMERIC DEFAULT 0,
      views NUMERIC DEFAULT 0,
      video_play NUMERIC DEFAULT 0,
      p25 NUMERIC DEFAULT 0,
      p50 NUMERIC DEFAULT 0,
      p75 NUMERIC DEFAULT 0,
      p100 NUMERIC DEFAULT 0,
      installs NUMERIC DEFAULT 0,
      extra JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // 수동 raw 업로드 매체 목록 + 컬럼 매핑 (하드코딩 대신 /settings 화면에서 추가/수정/삭제 가능)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS manual_sources (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      field_map JSONB NOT NULL DEFAULT '{}',
      cost_multiplier NUMERIC DEFAULT 1,
      apply_margin_rate BOOLEAN DEFAULT false,
      ad_name_prefix TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0
    );
  `);
  // 이미 배포돼있던 테이블에는 sort_order 컬럼이 없을 수 있으므로 안전하게 추가 (업로드 화면 카드 드래그 순서 저장용)
  await pool.query(`ALTER TABLE manual_sources ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;`);

  // ===== 계정별 분리 마이그레이션 =====
  // settings/manual_sources/raw_data 전부 user_id 컬럼을 추가해서 계정별로 나눔.
  // 이미 있던 데이터는 ensureBootstrapUser()가 만든 첫 계정(예전 ADMIN_PASSWORD 계정) 소유로 옮김.
  await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;`);
  await pool.query(`ALTER TABLE manual_sources ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;`);
  await pool.query(`ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;`);

  const bootstrapUserId = await ensureBootstrapUser();
  if (bootstrapUserId) {
    await pool.query('UPDATE settings SET user_id = $1 WHERE user_id IS NULL', [bootstrapUserId]);
    await pool.query('UPDATE manual_sources SET user_id = $1 WHERE user_id IS NULL', [bootstrapUserId]);
    await pool.query('UPDATE raw_data SET user_id = $1 WHERE user_id IS NULL', [bootstrapUserId]);
  }

  // user_id가 다 채워졌으면 NOT NULL + (계정별) 고유키로 확정. 주인 없는 행이 남아있으면
  // (ADMIN_PASSWORD도 없이 기존 데이터만 있는 특이 케이스) 건드리지 않고 다음 시작 때 다시 시도함.
  const { rows: settingsNulls } = await pool.query('SELECT COUNT(*) FROM settings WHERE user_id IS NULL');
  if (parseInt(settingsNulls[0].count, 10) === 0) {
    await pool.query('ALTER TABLE settings ALTER COLUMN user_id SET NOT NULL');
    await pool.query('ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_pkey');
    await pool.query('ALTER TABLE settings ADD PRIMARY KEY (user_id, key)');
  }

  const { rows: manualNulls } = await pool.query('SELECT COUNT(*) FROM manual_sources WHERE user_id IS NULL');
  if (parseInt(manualNulls[0].count, 10) === 0) {
    await pool.query('ALTER TABLE manual_sources ALTER COLUMN user_id SET NOT NULL');
    await pool.query('ALTER TABLE manual_sources DROP CONSTRAINT IF EXISTS manual_sources_pkey');
    await pool.query('ALTER TABLE manual_sources ADD PRIMARY KEY (user_id, id)');
  }

  const { rows: rawNulls } = await pool.query('SELECT COUNT(*) FROM raw_data WHERE user_id IS NULL');
  if (parseInt(rawNulls[0].count, 10) === 0) {
    await pool.query('ALTER TABLE raw_data ALTER COLUMN user_id SET NOT NULL');
  }

  await pool.query('DROP INDEX IF EXISTS idx_raw_data_source_date;');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_raw_data_user_source_date ON raw_data(user_id, source, date);');

  // 계정을 새로 만든 사람(=매체를 하나도 등록 안 한 계정)에게는 기본 설정값/매체 목록을 채워줌.
  // 이미 데이터가 있는 계정(예: 이전된 기존 계정)은 그대로 두고 건드리지 않음.
  if (bootstrapUserId) {
    await seedDefaultsForUser(bootstrapUserId);
  }

  // 예전 이름(asa_raw, x_raw)으로 저장된 raw_data가 있으면 새 이름으로 이전 (계정 무관하게 데이터 내용만 정리)
  await pool.query(`UPDATE raw_data SET source = 'apple' WHERE source = 'asa_raw'`);
  await pool.query(`UPDATE raw_data SET source = 'x' WHERE source = 'x_raw'`);

  // 과거(기본값+재정의 병합 기능이 생기기 전)에는 매체별 field_map에 기본 컬럼명을 그대로 박아넣었던
  // 데이터가 남아있을 수 있음. 지금은 기본값을 전역으로 관리하므로, 값이 내장 기본값과 정확히 같은
  // 항목은 "실제 재정의"가 아니라고 보고 지워서 매체별 설정 화면을 깨끗하게 정리함.
  const { rows: existingManualSources } = await pool.query('SELECT user_id, id, field_map FROM manual_sources');
  for (const row of existingManualSources) {
    const fieldMap = row.field_map || {};
    const cleaned = {};
    let changed = false;
    for (const [key, value] of Object.entries(fieldMap)) {
      const builtin = DEFAULT_FIELD_MAP[key];
      if (builtin && String(value || '').trim() === builtin.trim()) {
        changed = true;
        continue;
      }
      cleaned[key] = value;
    }
    if (changed) {
      await pool.query('UPDATE manual_sources SET field_map = $1 WHERE user_id = $2 AND id = $3', [
        JSON.stringify(cleaned),
        row.user_id,
        row.id,
      ]);
    }
  }
}

// 새 계정이 만들어졌을 때 기본 설정값 + 시작용 매체 목록을 채워줌 (/signup에서 호출)
async function seedDefaultsForUser(userId) {
  const defaults = {
    DELIMITER: '_',
    MARGIN_RATE: '0.85',
  };
  for (const [key, value] of Object.entries(defaults)) {
    await pool.query(
      `INSERT INTO settings (user_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (user_id, key) DO NOTHING`,
      [userId, key, value]
    );
  }
}

// ===== 계정 관리 =====
async function createUser(email, passwordHash) {
  const normalizedEmail = email.toLowerCase().trim();
  const { rows } = await pool.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at',
    [normalizedEmail, passwordHash]
  );
  await seedDefaultsForUser(rows[0].id);
  return rows[0];
}

async function getUserByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
  return rows[0] || null;
}

async function getUserById(id) {
  const { rows } = await pool.query('SELECT id, email, created_at FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getAllUsers() {
  const { rows } = await pool.query('SELECT id, email FROM users ORDER BY id');
  return rows;
}

// ===== 전역 기본 컬럼명 (계정별로 관리, /settings > 수동 업로드 매체 상단에서 설정) =====
async function getManualDefaults(userId) {
  const raw = await getSetting(userId, MANUAL_DEFAULTS_SETTING_KEY, '');
  if (!raw) return { ...DEFAULT_FIELD_MAP };
  try {
    const parsed = JSON.parse(raw);
    // 혹시 일부 필드만 저장돼 있어도 나머지는 내장 기본값으로 채움
    return { ...DEFAULT_FIELD_MAP, ...parsed };
  } catch (e) {
    return { ...DEFAULT_FIELD_MAP };
  }
}

async function setManualDefaults(userId, map) {
  await setSetting(userId, MANUAL_DEFAULTS_SETTING_KEY, JSON.stringify(map));
}

async function getManualSources(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM manual_sources WHERE user_id = $1 ORDER BY sort_order, id',
    [userId]
  );
  return rows;
}

// 업로드 화면에서 매체 카드를 드래그로 재배열했을 때 순서를 저장
async function reorderManualSources(userId, orderedIds) {
  for (let i = 0; i < orderedIds.length; i++) {
    await pool.query('UPDATE manual_sources SET sort_order = $1 WHERE user_id = $2 AND id = $3', [
      i,
      userId,
      orderedIds[i],
    ]);
  }
}

async function getManualSource(userId, id) {
  const { rows } = await pool.query('SELECT * FROM manual_sources WHERE user_id = $1 AND id = $2', [userId, id]);
  return rows[0] || null;
}

async function upsertManualSource(userId, source) {
  const { id, label, field_map, cost_multiplier, apply_margin_rate, ad_name_prefix } = source;
  await pool.query(
    `INSERT INTO manual_sources (user_id, id, label, field_map, cost_multiplier, apply_margin_rate, ad_name_prefix)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, id) DO UPDATE SET
       label = EXCLUDED.label,
       field_map = EXCLUDED.field_map,
       cost_multiplier = EXCLUDED.cost_multiplier,
       apply_margin_rate = EXCLUDED.apply_margin_rate,
       ad_name_prefix = EXCLUDED.ad_name_prefix`,
    [userId, id, label, JSON.stringify(field_map), cost_multiplier, apply_margin_rate, ad_name_prefix]
  );
}

async function deleteManualSource(userId, id) {
  await pool.query('DELETE FROM manual_sources WHERE user_id = $1 AND id = $2', [userId, id]);
}

async function getSettings(userId) {
  const { rows } = await pool.query('SELECT key, value FROM settings WHERE user_id = $1 ORDER BY key', [userId]);
  return rows;
}

async function getSetting(userId, key, fallback = '') {
  const { rows } = await pool.query('SELECT value FROM settings WHERE user_id = $1 AND key = $2', [userId, key]);
  return rows.length > 0 ? rows[0].value : fallback;
}

async function setSetting(userId, key, value) {
  await pool.query(
    `INSERT INTO settings (user_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [userId, key, value]
  );
}

async function deleteSetting(userId, key) {
  await pool.query('DELETE FROM settings WHERE user_id = $1 AND key = $2', [userId, key]);
}

async function insertRawRows(userId, rows) {
  // rows: [{source, date, campaign_name, adgroup_name, ad_name, cost, impressions, clicks, views, video_play, p25, p50, p75, p100, installs, extra}]
  for (const r of rows) {
    await pool.query(
      `INSERT INTO raw_data
        (user_id, source, date, campaign_name, adgroup_name, ad_name, cost, impressions, clicks, views, video_play, p25, p50, p75, p100, installs, extra)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        userId, r.source, r.date || null, r.campaign_name || '', r.adgroup_name || '', r.ad_name || '',
        r.cost || 0, r.impressions || 0, r.clicks || 0, r.views || 0, r.video_play || 0,
        r.p25 || 0, r.p50 || 0, r.p75 || 0, r.p100 || 0, r.installs || 0,
        r.extra ? JSON.stringify(r.extra) : null,
      ]
    );
  }
}

async function replaceSourceData(userId, source, rows) {
  // 해당 매체의 기존 데이터를 지우고 새 데이터로 교체 (Apps Script의 clearContents 방식과 동일)
  await pool.query('DELETE FROM raw_data WHERE user_id = $1 AND source = $2', [userId, source]);
  await insertRawRows(userId, rows.map((r) => ({ ...r, source })));
}

async function queryRawData(userId, { source, startDate, endDate, limit = 500 }) {
  const conditions = ['user_id = $1'];
  const params = [userId];
  let idx = 2;

  if (source) {
    conditions.push(`source = $${idx++}`);
    params.push(source);
  }
  if (startDate) {
    conditions.push(`date >= $${idx++}`);
    params.push(startDate);
  }
  if (endDate) {
    conditions.push(`date <= $${idx++}`);
    params.push(endDate);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT * FROM raw_data ${where} ORDER BY date DESC, id DESC LIMIT $${idx}`,
    params
  );
  return rows;
}

async function distinctSources(userId) {
  const { rows } = await pool.query('SELECT DISTINCT source FROM raw_data WHERE user_id = $1 ORDER BY source', [
    userId,
  ]);
  return rows.map((r) => r.source);
}

module.exports = {
  pool,
  initDb,
  createUser,
  getUserByEmail,
  getUserById,
  getAllUsers,
  getSettings,
  getSetting,
  setSetting,
  deleteSetting,
  insertRawRows,
  replaceSourceData,
  queryRawData,
  distinctSources,
  getManualSources,
  getManualSource,
  upsertManualSource,
  deleteManualSource,
  reorderManualSources,
  getManualDefaults,
  setManualDefaults,
};
