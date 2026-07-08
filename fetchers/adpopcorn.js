const db = require('../db');

const ADPOPCORN_API_URL = 'https://reward-report.adpopcorn.com/v1/Campaign/Report';

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function getYesterday() {
  return formatDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
}

function getMonthStart() {
  const today = new Date();
  return formatDate(new Date(today.getFullYear(), today.getMonth(), 1));
}

// 캠페인명에 "설치형"이 포함되면 CPI 230원, 그 외("실행형" 등)는 CPA 310원 고정단가.
// Adpopcorn 리포트 API는 실제 스펜드를 안 주고 완료건수(complete)만 줘서,
// 원본 Apps Script와 동일하게 고정단가 * 완료건수로 비용을 역산함.
function unitPriceFor(campaignName) {
  return String(campaignName || '').includes('설치형') ? 230 : 310;
}

// ===== 애드팝콘 데이터 수집 =====
// 필요한 설정값 (/settings > Adpopcorn 탭):
//   ADPOPCORN_ACCESS_TOKEN - 리포트 API 액세스 토큰
//   ADPOPCORN_FILTER_CAMPAIGNS - 집계할 캠페인명 목록 (한 줄에 하나씩). 비워두면 전체 캠페인 포함.
async function fetchAdpopcorn() {
  const accessToken = await db.getSetting('ADPOPCORN_ACCESS_TOKEN');
  const filterCampaignsRaw = await db.getSetting('ADPOPCORN_FILTER_CAMPAIGNS');

  if (!accessToken) {
    console.log('[adpopcorn] 설정값 누락 - /settings > Adpopcorn 탭에서 Access Token을 등록하세요.');
    return;
  }

  const filterCampaigns = (filterCampaignsRaw || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const startDate = getMonthStart();
  const endDate = getYesterday();

  const url = `${ADPOPCORN_API_URL}?accessToken=${encodeURIComponent(accessToken)}&startDate=${startDate}&endDate=${endDate}`;
  const res = await fetch(url);
  const result = await res.json();

  if (!result.Result || !result.Data) {
    console.log('[adpopcorn] 데이터 없음:', JSON.stringify(result));
    return;
  }

  const rows = [];
  result.Data.forEach((campaign) => {
    const name = campaign.campaignName;
    if (filterCampaigns.length > 0 && !filterCampaigns.includes(name)) return;

    const unitPrice = unitPriceFor(name);

    (campaign.dailyReport || []).forEach((day) => {
      const complete = Number(day.complete || 0);
      rows.push({
        date: day.reportDate,
        campaign_name: name,
        adgroup_name: '',
        ad_name: '',
        cost: complete * unitPrice,
        impressions: 0,
        clicks: Number(day.click || 0),
        installs: complete,
        extra: day,
      });
    });
  });

  rows.sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0));

  if (rows.length === 0) {
    console.log('[adpopcorn] 데이터 없음 (필터를 통과한 캠페인 없음)');
    return;
  }

  await db.replaceSourceData('adpopcorn', rows);
  console.log(`[adpopcorn] 완료: ${rows.length}개 행 저장 (${startDate} ~ ${endDate})`);
}

module.exports = { fetchAdpopcorn };
