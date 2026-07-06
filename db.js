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

  // 기본 설정값이 없으면 채워둠
  const defaults = {
    DELIMITER: '_',
    MARGIN_RATE: '0.85',
    ASA_EXCHANGE_RATE: '1500',
  };
  for (const [key, value] of Object.entries(defaults)) {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, value]
    );
  }
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
};
