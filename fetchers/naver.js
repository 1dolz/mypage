const crypto = require('crypto');
const db = require('../db');

// ===== 네이버 검색광고 API =====
// 필요한 설정값 (/settings > 네이버 탭): NAVER_API_KEY, NAVER_SECRET_KEY, NAVER_CUSTOMER_ID
// 기존에 쓰던 Apps Script(NAVER 리포트 스프레드시트)를 그대로 포팅한 것.
// 원본은 "어제 하루" 데이터를 매일 시트에 append하는 방식이었는데, 이 앱은 다른 매체 fetcher들과
// 동일하게 "이번 달 1일~어제"를 매번 새로 계산해서 통째로 교체(replaceSourceData)하는 방식으로 맞춤.

const BASE_URL = 'https://api.searchad.naver.com';
const STAT_FIELDS = ['impCnt', 'clkCnt', 'ctr', 'cpc', 'salesAmt', 'ccnt'];
const ADDITIVE_FIELDS = ['impCnt', 'clkCnt', 'salesAmt', 'ccnt'];
const BATCH_SIZE = 50;
const NAVER_KEYWORD_CACHE_KEY = 'NAVER_KEYWORD_CACHE';

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function getPrevDate(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return formatDate(d);
}

function dateRange(startDate, endDate) {
  const dates = [];
  let cur = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  while (cur <= end) {
    dates.push(formatDate(cur));
    cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000);
  }
  return dates;
}

// Apps Script의 Utilities.computeHmacSha256Signature + base64Encode와 동일한 서명 생성
function makeHeaders(method, uri, creds) {
  const timestamp = String(Date.now());
  const message = `${timestamp}.${method}.${uri}`;
  const signature = crypto.createHmac('sha256', creds.secretKey).update(message).digest('base64');
  return {
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Timestamp': timestamp,
    'X-API-KEY': creds.apiKey,
    'X-Customer': String(creds.customerId),
    'X-Signature': signature,
  };
}

function buildQuery(params) {
  const parts = [];
  Object.keys(params).forEach((key) => {
    const value = params[key];
    if (Array.isArray(value)) {
      value.forEach((v) => parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`));
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  });
  return parts.join('&');
}

async function apiGet(uri, params, creds) {
  const url = BASE_URL + uri + (params ? '?' + buildQuery(params) : '');
  const res = await fetch(url, { method: 'GET', headers: makeHeaders('GET', uri, creds) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`네이버 API 오류 ${res.status}: ${text}`);
  }
  return res.json();
}

function getCampaigns(creds) {
  return apiGet('/ncc/campaigns', null, creds);
}
function getAdgroups(campaignId, creds) {
  return apiGet('/ncc/adgroups', { nccCampaignId: campaignId }, creds);
}
function getKeywords(adgroupId, creds) {
  return apiGet('/ncc/keywords', { nccAdgroupId: adgroupId }, creds);
}

function getStats(ids, targetDate, creds) {
  const params = {
    ids,
    fields: JSON.stringify(STAT_FIELDS),
    timeRange: JSON.stringify({ since: targetDate, until: targetDate }),
    timeIncrement: 'allDays',
  };
  return apiGet('/stats', params, creds);
}

// ===== 삭제된 키워드 추적용 캐시 (계정별 settings에 JSON으로 저장, 원본의 숨김 시트 역할) =====
async function loadCache(userId) {
  const raw = await db.getSetting(userId, NAVER_KEYWORD_CACHE_KEY, '');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

async function saveCache(userId, cache) {
  await db.setSetting(userId, NAVER_KEYWORD_CACHE_KEY, JSON.stringify(cache));
}

// ===== 캠페인 > 광고그룹 > 키워드 계층 조회 =====
async function collectHierarchy(creds) {
  const campaigns = await getCampaigns(creds);
  const keywordInfo = {};
  const adgroupInfo = {};

  for (const campaign of campaigns) {
    const campaignId = campaign.nccCampaignId;
    const campaignName = campaign.name || '';

    const adgroups = await getAdgroups(campaignId, creds);
    for (const adgroup of adgroups) {
      const adgroupId = adgroup.nccAdgroupId;
      const adgroupName = adgroup.name || '';
      adgroupInfo[adgroupId] = { name: adgroupName, campaign: campaignName };

      const keywords = await getKeywords(adgroupId, creds);
      for (const kw of keywords) {
        keywordInfo[kw.nccKeywordId] = {
          keyword: kw.keyword || '',
          campaign: campaignName,
          adgroup: adgroupName,
          adgroupId,
        };
      }
    }
  }

  return { keywordInfo, adgroupInfo };
}

function statRow(targetDate, campaign, adgroup, label, stat) {
  stat = stat || {};
  return {
    date: targetDate,
    campaign_name: campaign,
    adgroup_name: adgroup,
    ad_name: label,
    cost: stat.salesAmt || 0,
    impressions: stat.impCnt || 0,
    clicks: stat.clkCnt || 0,
    installs: stat.ccnt || 0, // 전환수(ccnt)를 다른 매체의 "설치" 컬럼 자리에 매핑
    extra: stat,
  };
}

function emptySum() {
  const s = {};
  ADDITIVE_FIELDS.forEach((f) => (s[f] = 0));
  return s;
}

function addToSum(total, stat) {
  ADDITIVE_FIELDS.forEach((f) => (total[f] += (stat && stat[f]) || 0));
}

// 광고그룹 전체 실적 - 키워드별 실적 합계 = 키워드 외 기타노출(콘텐츠/자동 매칭 등) 실적
function diffStat(adgroupStat, kwSum) {
  adgroupStat = adgroupStat || {};
  const diff = {};
  ADDITIVE_FIELDS.forEach((f) => (diff[f] = (adgroupStat[f] || 0) - kwSum[f]));
  diff.ctr = diff.impCnt ? Math.round((diff.clkCnt / diff.impCnt) * 10000) / 100 : 0;
  diff.cpc = diff.clkCnt ? Math.round(diff.salesAmt / diff.clkCnt) : 0;
  return diff;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function statByIdMap(result) {
  const map = {};
  (result.data || []).forEach((item) => (map[item.id] = item));
  return map;
}

// ===== 하루치 데이터 수집 (원본 Apps Script의 runDailyReport 로직을 그대로 포팅) =====
async function collectDayRows(targetDate, currentKeywords, adgroupInfo, cache, creds) {
  const rows = [];
  const adgroupKwSum = {};

  const keywordIds = Object.keys(currentKeywords);
  for (const batch of chunk(keywordIds, BATCH_SIZE)) {
    const statById = statByIdMap(await getStats(batch, targetDate, creds));
    batch.forEach((kid) => {
      const info = currentKeywords[kid];
      const stat = statById[kid];
      rows.push(statRow(targetDate, info.campaign, info.adgroup, info.keyword, stat));
      if (!adgroupKwSum[info.adgroupId]) adgroupKwSum[info.adgroupId] = emptySum();
      addToSum(adgroupKwSum[info.adgroupId], stat);
    });
  }

  // 지금은 삭제됐지만 캐시에 남아있는(예전에 있었던) 키워드도 혹시 그 날짜에 실적이 남아있으면 복구
  const missingIds = Object.keys(cache).filter((id) => !currentKeywords[id]);
  for (const kid of missingIds) {
    try {
      const statById = statByIdMap(await getStats([kid], targetDate, creds));
      const stat = statById[kid];
      if (stat) {
        const info = cache[kid];
        rows.push(statRow(targetDate, info.campaign, info.adgroup, `${info.keyword} (삭제됨)`, stat));
        if (info.adgroupId) {
          if (!adgroupKwSum[info.adgroupId]) adgroupKwSum[info.adgroupId] = emptySum();
          addToSum(adgroupKwSum[info.adgroupId], stat);
        }
      }
    } catch (e) {
      // 삭제된 키워드는 조회가 막힐 수 있음 - 스킵
    }
  }

  const adgroupIds = Object.keys(adgroupInfo);
  for (const batch of chunk(adgroupIds, BATCH_SIZE)) {
    const statById = statByIdMap(await getStats(batch, targetDate, creds));
    batch.forEach((aid) => {
      const info = adgroupInfo[aid];
      const diff = diffStat(statById[aid], adgroupKwSum[aid] || emptySum());
      rows.push(statRow(targetDate, info.campaign, info.name, '(키워드 외 기타노출 차이)', diff));
    });
  }

  return rows;
}

// ===== 메인 =====
async function fetchNaverAds(userId) {
  const apiKey = await db.getSetting(userId, 'NAVER_API_KEY');
  const secretKey = await db.getSetting(userId, 'NAVER_SECRET_KEY');
  const customerId = await db.getSetting(userId, 'NAVER_CUSTOMER_ID');

  if (!apiKey || !secretKey || !customerId) {
    console.log('[naver] 설정값 누락 - /settings > 네이버 탭에서 API Key / Secret Key / Customer ID를 등록하세요.');
    return;
  }

  const creds = { apiKey, secretKey, customerId };

  const today = new Date();
  const startDate = formatDate(new Date(today.getFullYear(), today.getMonth(), 1));
  const endDate = getPrevDate(1);

  const { keywordInfo: currentKeywords, adgroupInfo } = await collectHierarchy(creds);
  const cache = await loadCache(userId);

  const mergedCache = { ...cache, ...currentKeywords };

  const allRows = [];
  for (const targetDate of dateRange(startDate, endDate)) {
    const dayRows = await collectDayRows(targetDate, currentKeywords, adgroupInfo, cache, creds);
    allRows.push(...dayRows);
  }

  await saveCache(userId, mergedCache);

  if (allRows.length === 0) {
    console.log('[naver] 데이터 없음');
    return;
  }

  await db.replaceSourceData(userId, 'naver', allRows);
  console.log(`[naver] 완료: ${allRows.length}개 행 저장 (${startDate} ~ ${endDate})`);
}

module.exports = {
  fetchNaverAds,
  // 아래는 테스트용으로 노출 (실제 서버 로직에서는 fetchNaverAds만 사용)
  makeHeaders,
  buildQuery,
  statRow,
  emptySum,
  addToSum,
  diffStat,
  chunk,
  statByIdMap,
  dateRange,
};
