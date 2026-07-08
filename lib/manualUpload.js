const XLSX = require('xlsx');
const { parse } = require('csv-parse/sync');

function toAoa(buffer, ext) {
  if (ext === 'xlsx' || ext === 'xls') {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  }
  const text = buffer.toString('utf-8');
  return parse(text, { skip_empty_lines: true, trim: true });
}

function splitAltNames(str) {
  return String(str || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// 헤더 행을 자동으로 찾음: field_map에 등록된 모든 후보 컬럼명 중 각 행에서 몇 개가
// 정확히 일치하는지 세어서 제일 많이 일치하는 행을 헤더로 사용.
// Apple 리포트처럼 표 위에 메타데이터 줄이 붙어있어도 자동으로 건너뛰어짐.
function findHeaderRow(aoa, fieldMap) {
  const allNames = new Set(Object.values(fieldMap).flatMap((v) => splitAltNames(v)));
  let bestIdx = 0;
  let bestScore = -1;
  const scanLimit = Math.min(aoa.length, 25);
  for (let i = 0; i < scanLimit; i++) {
    const row = aoa[i] || [];
    const score = row.filter((cell) => allNames.has(String(cell || '').trim())).length;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestScore >= 2 ? bestIdx : 0;
}

function aoaToObjects(aoa, headerIdx) {
  const headers = (aoa[headerIdx] || []).map((h) => String(h || '').trim());
  return aoa
    .slice(headerIdx + 1)
    .filter((row) => row && row.some((cell) => cell !== '' && cell !== undefined && cell !== null))
    .map((row) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = row[i];
      });
      return obj;
    });
}

function pickField(record, altNamesStr) {
  const names = splitAltNames(altNamesStr);
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== '') return record[name];
  }
  return '';
}

// 다양한 날짜 표기(ISO, MM/DD/YYYY, YYYY.MM.DD 등)를 YYYY-MM-DD로 정규화
function parseFlexibleDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);

  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, mm, dd, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }

  m = s.match(/^(\d{4})[.\/](\d{1,2})[.\/](\d{1,2})$/);
  if (m) {
    const [, yyyy, mm, dd] = m;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }

  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);

  return null;
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const cleaned = String(v).replace(/[^0-9.-]/g, '');
  return parseFloat(cleaned) || 0;
}

// ===== 수동 업로드 파일 -> raw_data 행 변환 =====
// sourceConfig: { field_map, cost_multiplier, apply_margin_rate, ad_name_prefix } (manual_sources 테이블 레코드)
// opts.marginRate: 전역 MARGIN_RATE 설정값 (apply_margin_rate가 true일 때 비용을 이 값으로 나눔)
function parseManualUploadFile(buffer, ext, sourceConfig, opts = {}) {
  const marginRate = opts.marginRate || 1;
  const aoa = toAoa(buffer, ext);
  if (aoa.length === 0) return [];

  const fieldMap = sourceConfig.field_map || {};
  const headerIdx = findHeaderRow(aoa, fieldMap);
  const records = aoaToObjects(aoa, headerIdx);

  const costMultiplier = Number(sourceConfig.cost_multiplier) || 1;
  const adNamePrefix = sourceConfig.ad_name_prefix || '';

  return records.map((r) => {
    const rawCost = toNumber(pickField(r, fieldMap.cost));
    let cost = rawCost * costMultiplier;
    if (sourceConfig.apply_margin_rate) {
      cost = cost / (marginRate || 1);
    }
    const adNameRaw = pickField(r, fieldMap.ad_name);

    return {
      date: parseFlexibleDate(pickField(r, fieldMap.date)),
      campaign_name: String(pickField(r, fieldMap.campaign_name) || ''),
      adgroup_name: String(pickField(r, fieldMap.adgroup_name) || ''),
      ad_name: adNamePrefix ? `${adNamePrefix}${adNameRaw || ''}` : String(adNameRaw || ''),
      cost: Math.round(cost),
      impressions: toNumber(pickField(r, fieldMap.impressions)),
      clicks: toNumber(pickField(r, fieldMap.clicks)),
      installs: toNumber(pickField(r, fieldMap.installs)),
      extra: r,
    };
  });
}

module.exports = { parseManualUploadFile };
