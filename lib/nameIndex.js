// 이름 매핑(Index): 매체별로 raw 캠페인명/광고명을 표준 이름으로 치환한다.
// 조회(표시) 시점에만 적용 → 원본 raw_data는 그대로 두고, Index를 고치면 과거 데이터까지 즉시 소급 반영된다.
//
// 저장 형태 (settings 테이블의 NAME_INDEX 값, JSON):
//   { "<source>": { "keyField": "campaign_name" | "ad_name",
//                   "rows": [ { match, campaign_name, adgroup_name, ad_name }, ... ] }, ... }

// 붙여넣은 표(엑셀 복붙=탭 구분, 콤마도 허용) 파싱.
// 컬럼 순서: 매칭값 | 표준 캠페인명 | 표준 광고그룹명 | 표준 광고명  (뒤쪽 열은 비워도 됨)
function parseIndexText(text) {
  if (!text) return [];
  return String(text)
    .split(/\r?\n/)
    .map((line) => (line.indexOf('\t') >= 0 ? line.split('\t') : line.split(',')))
    .map((cols) => cols.map((c) => String(c == null ? '' : c).trim()))
    .filter((cols) => cols[0]) // 매칭값(첫 열) 없는 줄 제외
    .map((cols) => ({
      match: cols[0],
      campaign_name: cols[1] || '',
      adgroup_name: cols[2] || '',
      ad_name: cols[3] || '',
    }))
    // 헤더로 보이는 줄 제거 (첫 열이 '매칭값'/'캠페인명'/'광고명'/'raw' 등)
    .filter((r) => !/^(매칭값|캠페인\s*명?|광고\s*명|raw|match)$/i.test(r.match));
}

// 저장된 rows → 편집용 TSV 문자열 (설정 화면 textarea에 다시 채워 넣기 위함)
function stringifyIndexRows(rows) {
  if (!Array.isArray(rows)) return '';
  return rows
    .map((r) => [r.match, r.campaign_name || '', r.adgroup_name || '', r.ad_name || ''].join('\t'))
    .join('\n');
}

// rows(raw)에 매체별 Index를 적용한 새 배열을 반환.
// indexAll: { source: { keyField, rows } }. 매칭 안 되면 원본 그대로. 표준값이 빈 칸이면 그 필드는 원본 유지.
function applyNameIndex(rows, indexAll) {
  if (!indexAll || !rows || !rows.length) return rows;
  const lookups = {}; // source -> { keyField, map }
  return rows.map((row) => {
    const cfg = indexAll[row.source];
    if (!cfg || !Array.isArray(cfg.rows) || !cfg.rows.length) return row;
    if (!lookups[row.source]) {
      const map = new Map();
      cfg.rows.forEach((r) => {
        if (r && r.match) map.set(String(r.match).trim(), r);
      });
      lookups[row.source] = { keyField: cfg.keyField === 'ad_name' ? 'ad_name' : 'campaign_name', map };
    }
    const { keyField, map } = lookups[row.source];
    const keyVal = String(row[keyField] == null ? '' : row[keyField]).trim();
    const hit = map.get(keyVal);
    if (!hit) return row;
    return {
      ...row,
      campaign_name: hit.campaign_name || row.campaign_name,
      adgroup_name: hit.adgroup_name || row.adgroup_name,
      ad_name: hit.ad_name || row.ad_name,
    };
  });
}

module.exports = { parseIndexText, stringifyIndexRows, applyNameIndex };
