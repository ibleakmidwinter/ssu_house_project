// api/analyze.js — 주변지역(인접 시군구) 실거래를 한 번에 모아 돌려준다.
// 통계 계산은 키가 필요 없으므로 script.js에서 하고, 이 함수는 '여러 지역 수집'만 담당한다.

const { collectRegion } = require('./transactions.js');

const MAX_REGIONS = 5;   // 공공 API 한도를 지키기 위한 상한
const CONCURRENCY = 3;   // 지역 단위 동시 수집 수 (지역 하나가 이미 내부에서 병렬 호출한다)

/**
 * 지역 수집 작업을 동시 실행 수를 제한해 처리한다.
 * @param {Array<() => Promise<any>>} tasks
 * @param {number} limit
 * @returns {Promise<any[]>}
 */
async function runLimited(tasks, limit) {
  const results = new Array(tasks.length).fill(null);
  let cursor = 0;
  const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
    while (cursor < tasks.length) {
      const i = cursor;
      cursor += 1;
      try {
        results[i] = await tasks[i]();
      } catch {
        results[i] = null; // 한 지역이 실패해도 나머지 비교는 계속한다
      }
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST만 허용합니다' } });
  }

  const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
  if (!serviceKey) {
    return res.status(500).json({
      ok: false,
      error: { code: 'NO_SERVICE_KEY', message: '공공데이터 인증키가 설정되지 않았습니다' },
    });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const codes = [...new Set((body.sigunguCodes || []).map(String))]
      .filter((c) => /^\d{5}$/.test(c))
      .slice(0, MAX_REGIONS);

    if (codes.length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'BAD_REGION', message: '비교할 시군구코드가 필요합니다' } });
    }

    // 주변지역은 '비교용'이므로 기간을 짧게(기본 6개월) 받아 호출량을 줄인다
    const months = Math.min(Math.max(Number(body.months) || 6, 1), 12);

    const results = await runLimited(
      codes.map((code) => () => collectRegion({ serviceKey, code, months, buildingTypes: body.buildingTypes })),
      CONCURRENCY,
    );

    const byCode = {};
    codes.forEach((code, i) => {
      byCode[code] = results[i] ? results[i] : { records: [], meta: { totalCount: 0, failed: true } };
    });

    return res.status(200).json({ ok: true, data: { byCode, months } });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: { code: 'INTERNAL', message: `주변지역 데이터를 불러오는 중 오류가 발생했습니다: ${err.message}` },
    });
  }
};
