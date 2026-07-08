const XLSX = require('xlsx');
const { parse } = require('csv-parse/sync');

// 매체를 새로 등록할 때 별도 설정 없이도 바로 동작하도록 하는 기본 컬럼명 후보.
// manual_sources.field_map에 특정 필드가 지정돼 있으면 그 값을 먼저 시도하고,
// 못 찾으면 여기 있는 기본 후보명들도 이어서 시도함 (완전 대체가 아니라 "우선순위 추가").
const DEFAULT_FIELD_MAP = {
  date: 'Date,날짜,Time period',
  campaign_name: 'Campaign,캠페인,Campaign Name',
  adgroup_name: 'Ad group,광고그룹,Ad Group Name',
  ad_name: 'Ad name,광고명,Creative name',
  cost: 'Spend,비용',
  impressions: 'Impressions,노출',
  clicks: 'Clicks,클릭',
  installs: 'Installs,설치,Actions',
};

const FIELD_KEYS = Object.keys(DEFAULT_FIELD_MAP);

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

// 특정 필드에 대해 실제로 시도할 컬럼명 후보 목록.
// 우선순위: 1) 매체별 재정의 값  2) /settings 화면에서 관리하는 전역 기본값(defaultsMap)  3) 코드에 내장된 최종 fallback.
// (defaultsMap을 아직 커스터마이즈하지 않았으면 2)=3)이라 결과는 동일함)
function effectiveAltNames(fieldMap, defaultsMap, key) {
  const override = splitAltNames(fieldMap && fieldMap[key]);
  const configuredDefault = splitAltNames(defaultsMap && defaultsMap[key]);
  const builtinDefault = splitAltNames(DEFAULT_FIELD_MAP[key]);
  return [...new Set([...override, ...configuredDefault, ...builtinDefault])];
}

// 헤더 행을 자동으로 찾음: 모든 필드의 (재정의 + 기본) 후보 컬럼명 중 각 행에서 몇 개가
// 정확히 일치하는지 세어서 제일 많이 일치하는 행을 헤더로 사용.
// Apple 리포트처럼 표 위에 메타데이터 줄이 붙어있어도 자동으로 건너뛰어짐.
function findHeaderRow(aoa, fieldMap, defaultsMap) {
  const allNames = new Set(FIELD_KEYS.flatMap((key) => effectiveAltNames(fieldMap, defaultsMap, key)));
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

function pickField(record, altNames) {
  for (const name of altNames) {
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
// opts.defaultsMap: /settings 화면에서 관리하는 전역 기본 컬럼명 (커스터마이즈 안 했으면 {} 또는 undefined 전달해도 됨)
function parseManualUploadFile(buffer, ext, sourceConfig, opts = {}) {
  const marginRate = opts.marginRate || 1;
  const defaultsMap = opts.defaultsMap || {};
  const aoa = toAoa(buffer, ext);
  if (aoa.length === 0) return [];

  const fieldMap = sourceConfig.field_map || {};
  const headerIdx = findHeaderRow(aoa, fieldMap, defaultsMap);
  const records = aoaToObjects(aoa, headerIdx);

  const costMultiplier = Number(sourceConfig.cost_multiplier) || 1;
  const adNamePrefix = sourceConfig.ad_name_prefix || '';

  return records.map((r) => {
    const rawCost = toNumber(pickField(r, effectiveAltNames(fieldMap, defaultsMap, 'cost')));
    let cost = rawCost * costMultiplier;
    if (sourceConfig.apply_margin_rate) {
      cost = cost / (marginRate || 1);
    }
    const adNameRaw = pickField(r, effectiveAltNames(fieldMap, defaultsMap, 'ad_name'));

    return {
      date: parseFlexibleDate(pickField(r, effectiveAltNames(fieldMap, defaultsMap, 'date'))),
      campaign_name: String(pickField(r, effectiveAltNames(fieldMap, defaultsMap, 'campaign_name')) || ''),
      adgroup_name: String(pickField(r, effectiveAltNames(fieldMap, defaultsMap, 'adgroup_name')) || ''),
      ad_name: adNamePrefix ? `${adNamePrefix}${adNameRaw || ''}` : String(adNameRaw || ''),
      cost: Math.round(cost),
      impressions: toNumber(pickField(r, effectiveAltNames(fieldMap, defaultsMap, 'impressions'))),
      clicks: toNumber(pickField(r, effectiveAltNames(fieldMap, defaultsMap, 'clicks'))),
      installs: toNumber(pickField(r, effectiveAltNames(fieldMap, defaultsMap, 'installs'))),
      extra: r,
    };
  });
}

module.exports = { parseManualUploadFile, DEFAULT_FIELD_MAP, FIELD_KEYS };
