const db = require('../db');

const GRAPH_VERSION = 'v19.0';

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function getPrevDate(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return formatDate(d);
}

async function exchangeLongLivedToken({ appId, appSecret, shortToken }) {
  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token` +
    `?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortToken}`;

  const res = await fetch(url);
  const json = await res.json();
  if (!json.access_token) {
    throw new Error('Meta 토큰 교환 실패: ' + JSON.stringify(json));
  }
  return json.access_token;
}

function getAction(arr, type) {
  if (!arr) return 0;
  const found = arr.find((a) => a.action_type === type);
  return found ? Number(found.value) : 0;
}

function getActionTotal(arr) {
  if (!arr) return 0;
  return arr.reduce((sum, a) => sum + Number(a.value || 0), 0);
}

// ===== Meta Ads 자동 수집 =====
// 필요한 설정값 (/settings 화면에서 등록):
//   META_APP_ID, META_APP_SECRET, META_AD_ACCOUNT_ID, META_ACCESS_TOKEN
// 최초 실행 시 META_ACCESS_TOKEN(단기 토큰)을 장기 토큰으로 교환해 META_LONG_TOKEN에 저장하고,
// 그 다음부터는 META_LONG_TOKEN을 사용합니다 (만료되면 META_ACCESS_TOKEN을 새로 받아 갱신 필요).
async function fetchMetaAds() {
  const appId = await db.getSetting('META_APP_ID');
  const appSecret = await db.getSetting('META_APP_SECRET');
  const adAccountId = await db.getSetting('META_AD_ACCOUNT_ID');
  const marginRate = parseFloat(await db.getSetting('MARGIN_RATE', '0.85')) || 0.85;

  if (!appId || !appSecret || !adAccountId) {
    console.log(
      '[meta] 설정값 누락 - /settings 에서 META_APP_ID / META_APP_SECRET / META_AD_ACCOUNT_ID / META_ACCESS_TOKEN 을 등록하세요.'
    );
    return;
  }

  let token = await db.getSetting('META_LONG_TOKEN');
  const shortToken = await db.getSetting('META_ACCESS_TOKEN');

  if (!token && shortToken) {
    token = await exchangeLongLivedToken({ appId, appSecret, shortToken });
    await db.setSetting('META_LONG_TOKEN', token);
    console.log('[meta] 장기 토큰 발급 및 저장 완료');
  }

  if (!token) {
    console.log('[meta] 액세스 토큰 없음 - /settings 에서 META_ACCESS_TOKEN을 등록하세요.');
    return;
  }

  const today = new Date();
  const firstOfMonth = formatDate(new Date(today.getFullYear(), today.getMonth(), 1));
  const yesterday = getPrevDate(1);
  const timeRange = encodeURIComponent(JSON.stringify({ since: firstOfMonth, until: yesterday }));

  const fields = [
    'campaign_name',
    'adset_name',
    'ad_name',
    'impressions',
    'clicks',
    'spend',
    'actions',
    'video_play_actions',
    'video_p25_watched_actions',
    'video_p50_watched_actions',
    'video_p75_watched_actions',
    'video_p100_watched_actions',
  ].join(',');

  let after = '';
  let allData = [];

  while (true) {
    const url =
      `https://graph.facebook.com/${GRAPH_VERSION}/${adAccountId}/insights` +
      `?access_token=${token}&level=ad&fields=${fields}&time_range=${timeRange}&time_increment=1&limit=500` +
      (after ? `&after=${after}` : '');

    const res = await fetch(url);
    const result = await res.json();

    if (result.error) {
      throw new Error('Meta API 오류: ' + JSON.stringify(result.error));
    }
    if (!result.data || result.data.length === 0) break;
    allData = allData.concat(result.data);

    if (result.paging && result.paging.cursors && result.paging.next) {
      after = result.paging.cursors.after;
    } else {
      break;
    }
  }

  if (allData.length === 0) {
    console.log('[meta] 데이터 없음');
    return;
  }

  const rows = allData.map((row) => ({
    date: row.date_start,
    campaign_name: row.campaign_name || '',
    adgroup_name: row.adset_name || '',
    ad_name: row.ad_name || '',
    cost: Math.round(Number(row.spend || 0) / marginRate),
    impressions: Number(row.impressions || 0),
    clicks: Number(row.clicks || 0),
    installs: getAction(row.actions, 'mobile_app_install'),
    views: getActionTotal(row.video_play_actions),
    video_play: getAction(row.actions, 'video_view'),
    p25: getAction(row.video_p25_watched_actions, 'video_view'),
    p50: getAction(row.video_p50_watched_actions, 'video_view'),
    p75: getAction(row.video_p75_watched_actions, 'video_view'),
    p100: getAction(row.video_p100_watched_actions, 'video_view'),
    extra: row,
  }));

  await db.replaceSourceData('meta', rows);
  console.log(`[meta] 완료: ${rows.length}개 행 저장 (${firstOfMonth} ~ ${yesterday})`);
}

module.exports = { fetchMetaAds };
