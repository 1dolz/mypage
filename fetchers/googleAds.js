const db = require('../db');

const GOOGLE_ADS_API_VERSION = 'v24';

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function getPrevDate(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return formatDate(d);
}

// ===== STEP 1. Refresh Token 발급 (최초 1회, /settings 화면에서 실행) =====
// Apps Script의 getGoogleAdsRefreshToken()과 동일한 OAuth 인증 코드 교환 로직.
async function exchangeAuthCodeForRefreshToken({ clientId, clientSecret, authCode }) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:
      `code=${encodeURIComponent(authCode)}` +
      `&client_id=${encodeURIComponent(clientId)}` +
      `&client_secret=${encodeURIComponent(clientSecret)}` +
      `&redirect_uri=urn:ietf:wg:oauth:2.0:oob` +
      `&grant_type=authorization_code`,
  });
  const result = await res.json();
  if (!result.refresh_token) {
    throw new Error('Refresh Token 발급 실패: ' + JSON.stringify(result));
  }
  return result.refresh_token;
}

// ===== STEP 2. Access Token 발급 (매 실행 시) =====
async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:
      `client_id=${encodeURIComponent(clientId)}` +
      `&client_secret=${encodeURIComponent(clientSecret)}` +
      `&refresh_token=${encodeURIComponent(refreshToken)}` +
      `&grant_type=refresh_token`,
  });
  const result = await res.json();
  if (!result.access_token) {
    throw new Error('Google Ads Access Token 발급 실패: ' + JSON.stringify(result));
  }
  return result.access_token;
}

// ===== 공통: Google Ads API 쿼리 실행 =====
async function runGoogleAdsQuery({ accessToken, developerToken, customerId, mccId, query }) {
  const url = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${customerId}/googleAds:searchStream`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': developerToken,
      'login-customer-id': mccId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(`Google Ads API 오류 [${res.status}]: ${text.slice(0, 500)}`);
  }

  let results;
  try {
    results = JSON.parse(text);
  } catch (e) {
    throw new Error('Google Ads 응답 파싱 실패: ' + text.slice(0, 300));
  }
  if (!Array.isArray(results)) {
    throw new Error('Google Ads 응답 형식 오류: ' + text.slice(0, 300));
  }

  let allResults = [];
  results.forEach((batch) => {
    if (batch.results) allResults = allResults.concat(batch.results);
  });
  return allResults;
}

// ===== Google Branding 데이터 수집 =====
// 필요한 설정값 (/settings > Google Ads 탭):
//   GOOGLE_DEVELOPER_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
//   GOOGLE_CUSTOMER_ID, GOOGLE_MCC_ID, GOOGLE_REFRESH_TOKEN
async function fetchGoogleBranding(userId) {
  const developerToken = await db.getSetting(userId, 'GOOGLE_DEVELOPER_TOKEN');
  const clientId = await db.getSetting(userId, 'GOOGLE_CLIENT_ID');
  const clientSecret = await db.getSetting(userId, 'GOOGLE_CLIENT_SECRET');
  const customerId = await db.getSetting(userId, 'GOOGLE_CUSTOMER_ID');
  const mccId = await db.getSetting(userId, 'GOOGLE_MCC_ID');
  const refreshToken = await db.getSetting(userId, 'GOOGLE_REFRESH_TOKEN');
  const marginRate = parseFloat(await db.getSetting(userId, 'MARGIN_RATE', '0.85')) || 0.85;

  if (!developerToken || !clientId || !clientSecret || !customerId || !mccId || !refreshToken) {
    console.log('[google_ads] 설정값 누락 - /settings > Google Ads 탭을 확인하세요.');
    return;
  }

  const accessToken = await getAccessToken({ clientId, clientSecret, refreshToken });

  const today = new Date();
  const startDate = formatDate(new Date(today.getFullYear(), today.getMonth(), 1));
  const endDate = getPrevDate(1);

  const results = await runGoogleAdsQuery({
    accessToken,
    developerToken,
    customerId,
    mccId,
    query: `
      SELECT
        segments.date,
        campaign.name,
        ad_group.name,
        metrics.cost_micros,
        metrics.impressions,
        metrics.clicks,
        metrics.video_trueview_views,
        metrics.video_quartile_p25_rate,
        metrics.video_quartile_p50_rate,
        metrics.video_quartile_p75_rate,
        metrics.video_quartile_p100_rate
      FROM ad_group_ad
      WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      ORDER BY segments.date ASC
    `,
  });

  if (results.length === 0) {
    console.log('[google_ads] 데이터 없음');
    return;
  }

  const installResults = await runGoogleAdsQuery({
    accessToken,
    developerToken,
    customerId,
    mccId,
    query: `
      SELECT
        segments.date,
        segments.conversion_action_name,
        campaign.name,
        ad_group.name,
        metrics.conversions
      FROM ad_group_ad
      WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
        AND segments.conversion_action_name LIKE '%first_open%'
      ORDER BY segments.date ASC
    `,
  });

  const installMap = {};
  installResults.forEach((r) => {
    const key = `${r.segments.date}__${r.campaign.name}`;
    installMap[key] = (installMap[key] || 0) + Number(r.metrics?.conversions || 0);
  });

  const usedInstallKeys = new Set();

  const rows = results.map((r) => {
    const imp = Number(r.metrics?.impressions || 0);
    const cost = Number(r.metrics?.costMicros || 0);
    const key = `${r.segments.date}__${r.campaign.name}`;
    const install = usedInstallKeys.has(key) ? 0 : Math.round(installMap[key] || 0);
    usedInstallKeys.add(key);

    return {
      date: r.segments.date,
      campaign_name: r.campaign.name,
      adgroup_name: r.adGroup.name,
      ad_name: '',
      cost: Math.round(cost / 1000000 / marginRate),
      impressions: imp,
      clicks: Number(r.metrics?.clicks || 0),
      installs: install,
      views: Number(r.metrics?.videoTrueviewViews || 0),
      video_play: imp,
      p25: Math.round(imp * Number(r.metrics?.videoQuartileP25Rate || 0)),
      p50: Math.round(imp * Number(r.metrics?.videoQuartileP50Rate || 0)),
      p75: Math.round(imp * Number(r.metrics?.videoQuartileP75Rate || 0)),
      p100: Math.round(imp * Number(r.metrics?.videoQuartileP100Rate || 0)),
      extra: r,
    };
  });

  await db.replaceSourceData(userId, 'google', rows);
  console.log(`[google_ads] 완료: ${rows.length}개 행 저장 (${startDate} ~ ${endDate})`);
}

module.exports = { fetchGoogleBranding, exchangeAuthCodeForRefreshToken };
