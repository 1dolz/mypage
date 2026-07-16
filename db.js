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

async function ensureBootstrapUser() {
  const { rows } = await pool.query('SELECT COUNT(*) FROM users');
  const userCount = parseInt(rows[0].count, 10);
  if (userCount > 0) return null;

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) return null;

  const email = (process.env.ADMIN_EMAIL || 'admin@thesmc.co.kr').toLowerCase();
  const passwordHash = await bcrypt.hash(adminPassword, 10);
  const { rows: inserted } = await pool.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id',
    [email, passwordHash]
  );
  return inserted[0] ? inserted[0].id : null;
}

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
      source TEXT NOT NULL,
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
  await pool.query(`ALTER TABLE manual_sources ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;`);

  await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;`);
  await pool.query(`ALTER TABLE manual_sources ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;`);
  await pool.query(`ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;`);

  const bootstrapUserId = await ensureBootstrapUser();
  if (bootstrapUserId) {
    await pool.query('UPDATE settings SET user_id = $1 WHERE user_id IS NULL', [bootstrapUserId]);
    await pool.query('UPDATE manual_sources SET user_id = $1 WHERE user_id IS NULL', [bootstrapUserId]);
    await pool.query('UPDATE raw_data SET user_id = $1 WHERE user_id IS NULL', [bootstrapUserId]);
  }

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

  if (bootstrapUserId) {
    await seedDefaultsForUser(bootstrapUserId);
  }

  await pool.query(`UPDATE raw_data SET source = 'apple' WHERE source = 'asa_raw'`);
  await pool.query(`UPDATE raw_data SET source = 'x' WHERE source = 'x_raw'`);

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

async function seedDefaultsForUser(userId) {
  const defaults = {
    DELIMITER: '_',
    MARGIN_RATE: '0.85',
  };
  for (const [key, value] of Object.entries(defaults)) {
    const { rows: existing } = await pool.query('SELECT 1 FROM settings WHERE user_id = $1 AND key = $2', [
      userId,
      key,
    ]);
    if (existing.length === 0) {
      await pool.query('INSERT INTO settings (user_id, key, value) VALUES ($1, $2, $3)', [userId, key, value]);
    }
  }
}

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

async function getManualDefaults(userId) {
  const raw = await getSetting(userId, MANUAL_DEFAULTS_SETTING_KEY, '');
  if (!raw) return { ...DEFAULT_FIELD_MAP };
  try {
    const parsed = JSON.parse(raw);
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
