const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

// 서버 시작 시 필요한 테이블을 자동으로 만들어줍니다 (이미 있으면 건너뜀)
async function initDb() {
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

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_raw_data_source_date ON raw_data(source, date);`);

  // 수동 raw 업로드 매체 목록 + 컬럼 매핑 (하드코딩 대신 /settings 화면에서 추가/수정/삭제 가능)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS manual_sources (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      field_map JSONB NOT NULL DEFAULT '{}',
      cost_multiplier NUMERIC DEFAULT 1,
      apply_margin_rate BOOLEAN DEFAULT false,
      ad_name_prefix TEXT DEFAULT ''
    );
  `);

  // 기본 설정값이 없으면 채워둠
  const defaults = {
    DELIMITER: '_',
    MARGIN_RATE: '0.85',
  };
  for (const [key, value] of Object.entries(defaults)) {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, value]
    );
  }

  // 기존에 하드코딩돼있던 수동 업로드 매체들을 manual_sources 테이블 기본값으로 이전
  const GENERIC_FIELD_MAP = {
    date: 'Date,날짜,Time period',
    campaign_name: 'Campaign,캠페인,Campaign Name',
    adgroup_name: 'Ad group,광고그룹,Ad Group Name',
    ad_name: 'Ad name,광고명,Creative name',
    cost: 'Spend,비용',
    impressions: 'Impressions,노출',
    clicks: 'Clicks,클릭',
    installs: 'Installs,설치,Actions',
  };

  const seedManualSources = [
    { id: 'tenping', label: '텐핑', field_map: GENERIC_FIELD_MAP, cost_multiplier: 1, apply_margin_rate: false, ad_name_prefix: '' },
    { id: 'appier', label: 'Appier', field_map: GENERIC_FIELD_MAP, cost_multiplier: 1, apply_margin_rate: false, ad_name_prefix: '' },
    { id: 'valista', label: '바리스타', field_map: GENERIC_FIELD_MAP, cost_multiplier: 1, apply_margin_rate: false, ad_name_prefix: '' },
    { id: 'tradingworks', label: '트레이딩웍스', field_map: GENERIC_FIELD_MAP, cost_multiplier: 1, apply_margin_rate: false, ad_name_prefix: '' },
    {
      id: 'apple',
      label: 'Apple',
      field_map: {
        date: 'Date',
        campaign_name: 'Campaign Name',
        adgroup_name: 'Ad Group Name',
        ad_name: 'Keyword',
        cost: 'Spend',
        impressions: 'Impressions',
        clicks: 'Taps',
        installs: 'Installs (Total)',
      },
      cost_multiplier: 1500,
      apply_margin_rate: true,
      ad_name_prefix: 'keyword_',
    },
    { id: 'x', label: 'X', field_map: GENERIC_FIELD_MAP, cost_multiplier: 1, apply_margin_rate: false, ad_name_prefix: '' },
  ];

  for (const s of seedManualSources) {
    await pool.query(
      `INSERT INTO manual_sources (id, label, field_map, cost_multiplier, apply_margin_rate, ad_name_prefix)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [s.id, s.label, JSON.stringify(s.field_map), s.cost_multiplier, s.apply_margin_rate, s.ad_name_prefix]
    );
  }

  // 예전 이름(asa_raw, x_raw)으로 저장된 raw_data가 있으면 새 이름으로 이전
  await pool.query(`UPDATE raw_data SET source = 'apple' WHERE source = 'asa_raw'`);
  await pool.query(`UPDATE raw_data SET source = 'x' WHERE source = 'x_raw'`);
}

async function getManualSources() {
  const { rows } = await pool.query('SELECT * FROM manual_sources ORDER BY id');
  return rows;
}

async function getManualSource(id) {
  const { rows } = await pool.query('SELECT * FROM manual_sources WHERE id = $1', [id]);
  return rows[0] || null;
}

async function upsertManualSource(source) {
  const { id, label, field_map, cost_multiplier, apply_margin_rate, ad_name_prefix } = source;
  await pool.query(
    `INSERT INTO manual_sources (id, label, field_map, cost_multiplier, apply_margin_rate, ad_name_prefix)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       label = EXCLUDED.label,
       field_map = EXCLUDED.field_map,
       cost_multiplier = EXCLUDED.cost_multiplier,
       apply_margin_rate = EXCLUDED.apply_margin_rate,
       ad_name_prefix = EXCLUDED.ad_name_prefix`,
    [id, label, JSON.stringify(field_map), cost_multiplier, apply_margin_rate, ad_name_prefix]
  );
}

async function deleteManualSource(id) {
  await pool.query('DELETE FROM manual_sources WHERE id = $1', [id]);
}

async function getSettings() {
  const { rows } = await pool.query('SELECT key, value FROM settings ORDER BY key');
  return rows;
}

async function getSetting(key, fallback = '') {
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length > 0 ? rows[0].value : fallback;
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

async function deleteSetting(key) {
  await pool.query('DELETE FROM settings WHERE key = $1', [key]);
}

async function insertRawRows(rows) {
  // rows: [{source, date, campaign_name, adgroup_name, ad_name, cost, impressions, clicks, views, video_play, p25, p50, p75, p100, installs, extra}]
  for (const r of rows) {
    await pool.query(
      `INSERT INTO raw_data
        (source, date, campaign_name, adgroup_name, ad_name, cost, impressions, clicks, views, video_play, p25, p50, p75, p100, installs, extra)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        r.source, r.date || null, r.campaign_name || '', r.adgroup_name || '', r.ad_name || '',
        r.cost || 0, r.impressions || 0, r.clicks || 0, r.views || 0, r.video_play || 0,
        r.p25 || 0, r.p50 || 0, r.p75 || 0, r.p100 || 0, r.installs || 0,
        r.extra ? JSON.stringify(r.extra) : null,
      ]
    );
  }
}

async function replaceSourceData(source, rows) {
  // 해당 매체의 기존 데이터를 지우고 새 데이터로 교체 (Apps Script의 clearContents 방식과 동일)
  await pool.query('DELETE FROM raw_data WHERE source = $1', [source]);
  await insertRawRows(rows.map((r) => ({ ...r, source })));
}

async function queryRawData({ source, startDate, endDate, limit = 500 }) {
  const conditions = [];
  const params = [];
  let idx = 1;

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

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT * FROM raw_data ${where} ORDER BY date DESC, id DESC LIMIT $${idx}`,
    params
  );
  return rows;
}

async function distinctSources() {
  const { rows } = await pool.query('SELECT DISTINCT source FROM raw_data ORDER BY source');
  return rows.map((r) => r.source);
}

module.exports = {
  pool,
  initDb,
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
};
