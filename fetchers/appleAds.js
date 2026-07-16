const crypto = require('crypto');
const db = require('../db');

const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/oauth2/token';
const APPLE_API_BASE = 'https://api.searchads.apple.com/api/v5';

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Apple Ads Portal에서 발급받은 .p8 개인키로 ES256 서명된 JWT(client_secret)를 생성.
// 실행할 때마다 새로 만들어서 사용 (유효기간 1시간이면 충분 - 최대 180일까지 가능하지만 매번 새로 생성하는 게 더 안전함).
function buildClientSecret({ clientId, teamId, keyId, privateKey }) {
  const header = { alg: 'ES256', kid: keyId };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: clientId,
    aud: 'https://appleid.apple.com',
    iat: now,
    exp: now + 60 * 60,
    iss: teamId,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  // JWS는 EC 서명을 raw R||S 포맷으로 요구함 (Node 기본 DER 포맷이 아님) -> dsaEncoding: 'ieee-p1363'
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64url(signature)}`;
}

async function getAccessToken({ clientId, teamId, keyId, privateKey }) {
  const clientSecret = buildClientSecret({ clientId, teamId, keyId, privateKey });
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'searchadsorg',
  });

  const res = await fetch(APPLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const result = await res.json();
  if (!result.access_token) {
    throw new Error('Apple Search Ads 토큰 발급 실패: ' + JSON.stringify(result));
  }
  return result.access_token;
}

async function appleApiRequest(path, { method = 'GET', body, accessToken, orgId }) {
  const res = await fetch(`${APPLE_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-AP-Context': `orgId=${orgId}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await res.json();
  if (!res.ok) {
    throw new Error(`Apple Search Ads API 오류 (${path}): ` + JSON.stringify(result));
  }
  return result;
}

async function listCampaigns({ accessToken, orgId }) {
  const limit = 1000;
  let offset = 0;
  let all = [];
  while (true) {
    const result = await appleApiRequest(`/campaigns?limit=${limit}&offset=${offset}`, { accessToken, orgId });
    const data = result.data || [];
    all = all.concat(data);
    if (data.length < limit) break;
    offset += limit;
  }
  return all;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

// 캠페인 1개에 대한 키워드 레벨 일별 리포트 (DAILY granularity) 페이지네이션 조회
async function fetchKeywordReport({ campaignId, startDate, endDate, accessToken, orgId }) {
  const limit = 1000;
  let offset = 0;
  let allRows = [];
  while (true) {
    const body = {
      startTime: startDate,
      endTime: endDate,
      granularity: 'DAILY',
      timeZone: 'Asia/Seoul',
      returnRowTotals: true,
      returnGrandTotals: false,
      returnRecordsWithNoMetrics: true,
      selector: {
        conditions: [{ field: 'deleted', operator: 'IN', values: ['false', 'true'] }],
        pagination: { offset, limit },
      },
    };
    const result = await appleApiRequest(`/reports/campaigns/${campaignId}/keywords`, {
      method: 'POST',
      body,
      accessToken,
      orgId,
    });
    const rows =
      (result.data && result.data.reportingDataResponse && result.data.reportingDataResponse.row) || [];
    allRows = allRows.concat(rows);
    if (rows.length < limit) break;
    offset += limit;
  }
  return allRows;
}

// ===== Apple Search Ads 키워드 레벨 데이터 수집 =====
// 필요한 설정값 (/settings > Apple 탭): APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY, APPLE_ORG_ID
async function fetchAppleAds(userId) {
  const clientId = await db.getSetting(userId, 'APPLE_CLIENT_ID');
  const teamId = await db.getSetting(userId, 'APPLE_TEAM_ID');
  const keyId = await db.getSetting(userId, 'APPLE_KEY_ID');
  const privateKey = await db.getSetting(userId, 'APPLE_PRIVATE_KEY');
  const orgId = await db.getSetting(userId, 'APPLE_ORG_ID');
  const marginRate = parseFloat(await db.getSetting(userId, 'MARGIN_RATE', '0.85')) || 0.85;

  if (!clientId || !teamId || !keyId || !privateKey || !orgId) {
    console.log('[apple] 설정값 누락 - /settings > Apple 탭에서 인증 정보를 등록하세요.');
    return;
  }

  const today = new Date();
  const startDate = formatDate(new Date(today.getFullYear(), today.getMonth(), 1));
  const endDate = formatDate(new Date(today.getTime() - 24 * 60 * 60 * 1000)); // 어제까지

  const accessToken = await getAccessToken({ clientId, teamId, keyId, privateKey });
  const campaigns = await listCampaigns({ accessToken, orgId });

  if (campaigns.length === 0) {
    console.log('[apple] 캠페인 없음');
    return;
  }

  const rows = [];

  for (const campaign of campaigns) {
    const reportRows = await fetchKeywordReport({
      campaignId: campaign.id,
      startDate,
      endDate,
      accessToken,
      orgId,
    });

    for (const row of reportRows) {
      const meta = row.metadata || {};
      const daily = row.granularity || [];
      for (const d of daily) {
        const spend = Number((d.localSpend && d.localSpend.amount) || 0);
        rows.push({
          date: d.date,
          campaign_name: campaign.name || '',
          adgroup_name: meta.adGroupName || '',
          ad_name: meta.keyword || '',
          cost: Math.round(spend / marginRate),
          impressions: Number(d.impressions || 0),
          clicks: Number(d.taps || 0),
          installs: Number(d.totalInstalls != null ? d.totalInstalls : d.tapInstalls || 0),
          extra: {
            matchType: meta.matchType,
            campaignId: campaign.id,
            adGroupId: meta.adGroupId,
            keywordId: meta.keywordId,
          },
        });
      }
    }
  }

  if (rows.length === 0) {
    console.log('[apple] 데이터 없음');
    return;
  }

  await db.replaceSourceData(userId, 'apple', rows);
  console.log(`[apple] 완료: ${rows.length}개 행 저장 (${startDate} ~ ${endDate})`);
}

module.exports = { fetchAppleAds };
