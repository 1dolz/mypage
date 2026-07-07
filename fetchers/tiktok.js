const db = require('../db');

const TIKTOK_API_VERSION = 'v1.3';

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function getPrevDate(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return formatDate(d);
}

// ===== Access Token 발급 (최초 1회, /settings 화면에서 실행) =====
// Apps Script의 getTikTokAccessToken()과 동일한 인증 코드 교환 로직.
// auth_code는 1회용이라 성공하면 재사용할 수 없음 - 실패 시 TikTok에서 새로 발급받아야 함.
async function exchangeAuthCodeForAccessToken({ appId, secret, authCode }) {
  const res = await fetch('https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, secret, auth_code: authCode }),
  });
  const result = await res.json();
  if (!result.data || !result.data.access_token) {
    throw new Error('TikTok Access Token 발급 실패: ' + JSON.stringify(result));
  }
  return {
    accessToken: result.data.access_token,
    advertiserId: result.data.advertiser_ids && result.data.advertiser_ids[0],
  };
}

// 광고명에 붙은 소재 파일명/접두어 제거 (Apps Script 로직 그대로)
function cleanAdName(rawAdName) {
  if (!rawAdName) return '';
  const markers = ['#숏드라마_', '#숏드라마 _', 'mp4_', 'png_'];
  for (const marker of markers) {
    if (rawAdName.includes(marker)) {
      return rawAdName.split(marker).pop();
    }
  }
  return rawAdName;
}

// ===== TikTok 데이터 수집 =====
// 필요한 설정값 (/settings > TikTok 탭): TIKTOK_ACCESS_TOKEN, TIKTOK_ADVERTISER_ID
async function fetchTikTokAds() {
  const token = await db.getSetting('TIKTOK_ACCESS_TOKEN');
  const advertiserId = await db.getSetting('TIKTOK_ADVERTISER_ID');
  const marginRate = parseFloat(await db.getSetting('MARGIN_RATE', '0.85')) || 0.85;

  if (!token || !advertiserId) {
    console.log('[tiktok] 설정값 누락 - /settings > TikTok 탭에서 Access Token / Advertiser ID를 등록하세요.');
    return;
  }

  const today = new Date();
  const startDate = formatDate(new Date(today.getFullYear(), today.getMonth(), 1));
  const endDate = getPrevDate(1);

  const fields = [
    'campaign_name',
    'adgroup_name',
    'ad_name',
    'spend',
    'impressions',
    'clicks',
    'video_play_actions',
    'video_watched_6s',
    'video_views_p25',
    'video_views_p50',
    'video_views_p75',
    'video_views_p100',
    'app_install',
    'skan_app_install',
  ];

  let page = 1;
  let allData = [];

  while (true) {
    const params = {
      advertiser_id: advertiserId,
      report_type: 'BASIC',
      data_level: 'AUCTION_AD',
      dimensions: JSON.stringify(['ad_id', 'stat_time_day']),
      metrics: JSON.stringify(fields),
      filtering: JSON.stringify([
        { field_name: 'ad_status', filter_type: 'IN', filter_value: JSON.stringify(['STATUS_ALL']) },
      ]),
      start_date: startDate,
      end_date: endDate,
      page_size: 1000,
      page,
    };

    const queryString = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');

    const url = `https://business-api.tiktok.com/open_api/${TIKTOK_API_VERSION}/report/integrated/get/?${queryString}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Access-Token': token },
    });
    const result = await res.json();

    if (result.code !== 0) {
      throw new Error('TikTok API 오류: ' + JSON.stringify(result));
    }

    const list = result.data && result.data.list;
    if (!list || list.length === 0) break;

    allData = allData.concat(list);
    if (list.length < 1000) break;
    page++;
  }

  if (allData.length === 0) {
    console.log('[tiktok] 데이터 없음');
    return;
  }

  const rows = allData.map((item) => {
    const d = item.dimensions;
    const m = item.metrics;
    const date = (d.stat_time_day || '').split(' ')[0];
    const cost = Math.round(Number(m.spend || 0) / marginRate);
    const installs = Number(m.app_install || 0) + Number(m.skan_app_install || 0);

    return {
      date,
      campaign_name: m.campaign_name || '',
      adgroup_name: m.adgroup_name || '',
      ad_name: cleanAdName(m.ad_name),
      cost,
      impressions: Number(m.impressions || 0),
      clicks: Number(m.clicks || 0),
      installs,
      views: Number(m.video_play_actions || 0),
      video_play: Number(m.video_watched_6s || 0),
      p25: Number(m.video_views_p25 || 0),
      p50: Number(m.video_views_p50 || 0),
      p75: Number(m.video_views_p75 || 0),
      p100: Number(m.video_views_p100 || 0),
      extra: item,
    };
  });

  await db.replaceSourceData('tiktok', rows);
  console.log(`[tiktok] 완료: ${rows.length}개 행 저장 (${startDate} ~ ${endDate})`);
}

module.exports = { fetchTikTokAds, exchangeAuthCodeForAccessToken };
