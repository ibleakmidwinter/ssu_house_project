// api/transactions.js — 국토교통부 연립다세대 전월세 실거래가 API(XML)를 불러와 숫자형 레코드로 정제한다.
// 공공데이터 인증키를 쓰므로 반드시 서버(서버리스 함수)에서만 호출한다.

// ===== 설정 =====

/**
 * 건물 유형별 공공 API 엔드포인트.
 * 기본은 연립다세대(RHRent)다. 팀 PRD 1단계가 이 API를 기준으로 로직을 정의한다.
 * 나머지 3종은 비교 범위를 넓히고 싶을 때만 쓰는 확장 옵션이다.
 */
const ENDPOINTS = {
  연립다세대: 'https://apis.data.go.kr/1613000/RTMSDataSvcRHRent/getRTMSDataSvcRHRent',
  오피스텔:   'https://apis.data.go.kr/1613000/RTMSDataSvcOffiRent/getRTMSDataSvcOffiRent',
  아파트:     'https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent',
  단독다가구: 'https://apis.data.go.kr/1613000/RTMSDataSvcSHRent/getRTMSDataSvcSHRent',
};

const DEFAULT_TYPE = '연립다세대';
const FETCH_TIMEOUT_MS = 10000; // 한 달치 요청이 10초를 넘으면 포기하고 다음으로 넘어간다
const CONCURRENCY = 4;          // 공공 API 부하와 일일 한도를 고려한 동시 호출 수
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 실거래 자료는 하루 단위로 갱신되므로 24시간 캐시

/** 메모리 캐시. 함수가 살아 있는 동안만 유지된다(warm start). */
const cache = new Map(); // key: `${code}:${type}:${yyyymm}` → { at, records }

// ===== 유틸 =====

/**
 * XML 조각에서 특정 태그 값을 꺼낸다. 유형별로 태그명이 달라 후보를 여러 개 받는다.
 * @param {string} xml 한 건(item)의 XML
 * @param {string[]} names 태그명 후보
 * @returns {string|null} 값(공백 제거), 없으면 null
 */
function pick(xml, names) {
  for (const n of names) {
    const m = xml.match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`));
    if (m) {
      const v = m[1].trim();
      if (v !== '') return v;
    }
  }
  return null;
}

/**
 * "24,000" 처럼 쉼표가 섞인 공공데이터 숫자 문자열을 숫자로 바꾼다.
 * PRD 3.1: deposit/monthlyRent는 쉼표 제거 후 숫자 변환이 필수다.
 * @param {string|null} s
 * @returns {number} 숫자, 변환 실패 시 0
 */
function toNum(s) {
  if (s === null || s === undefined) return 0;
  const n = Number(String(s).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * 기준일로부터 과거 N개월의 'YYYYMM' 목록. 최신 월이 앞에 온다.
 * 실거래 신고에 시차가 있어 당월도 포함해 요청한다.
 * @param {number} months
 * @returns {string[]}
 */
function recentMonths(months) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < months; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/**
 * 동시 실행 수를 제한해 작업을 처리한다.
 * 공공 API에 한 번에 수십 건을 던지면 차단될 수 있어 직접 구현했다(라이브러리 금지).
 * @param {Array<() => Promise<any>>} tasks
 * @param {number} limit
 * @returns {Promise<any[]>} 실패한 작업은 null
 */
async function runLimited(tasks, limit) {
  const results = new Array(tasks.length).fill(null);
  let cursor = 0;
  const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
    while (cursor < tasks.length) {
      const i = cursor;
      cursor += 1;
      try { results[i] = await tasks[i](); } catch { results[i] = null; }
    }
  });
  await Promise.all(workers);
  return results;
}

/** 같은 계약이 수정 신고로 중복 등장할 수 있어 중복 제거 키를 만든다. */
function recordKey(r) {
  return [r.umdNm, r.mhouseNm, r.excluUseAr, r.floor, r.dealDate, r.deposit, r.monthlyRent].join('|');
}

// ===== 수집 =====

/**
 * 한 유형·한 달치 실거래 XML을 가져와 숫자형 레코드로 정제한다.
 *
 * @param {string} serviceKey 공공데이터포털 인증키
 * @param {string} code 시군구코드 5자리 (LAWD_CD)
 * @param {string} type 건물 유형
 * @param {string} ymd 'YYYYMM' (DEAL_YMD)
 * @returns {Promise<{records:object[], failed:boolean, reason:string|null, fromCache:boolean}>}
 */
async function fetchOne(serviceKey, code, type, ymd) {
  const cacheKey = `${code}:${type}:${ymd}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { records: hit.records, failed: false, reason: null, fromCache: true };
  }

  const url = `${ENDPOINTS[type]}?serviceKey=${encodeURIComponent(serviceKey)}`
    + `&LAWD_CD=${code}&DEAL_YMD=${ymd}&pageNo=1&numOfRows=1000`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let xml = '';
  try {
    const res = await fetch(url, { signal: ac.signal });
    xml = await res.text();
  } finally {
    clearTimeout(timer);
  }

  // 인증키 미등록·활용신청 미승인 등은 본문에 사유가 담겨 온다
  if (/SERVICE_KEY_IS_NOT_REGISTERED|SERVICE_ACCESS_DENIED|APPLICATION_ERROR|UNREGISTERED/i.test(xml)) {
    return { records: [], failed: true, reason: 'KEY_OR_PERMISSION', fromCache: false };
  }
  if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS/i.test(xml)) {
    return { records: [], failed: true, reason: 'QUOTA_EXCEEDED', fromCache: false };
  }

  // PRD 2.1: resultCode가 '000'일 때만 body를 파싱한다
  const resultCode = pick(xml, ['resultCode']);
  if (resultCode !== null && resultCode !== '000' && resultCode !== '00') {
    return { records: [], failed: true, reason: `RESULT_${resultCode}`, fromCache: false };
  }

  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  const records = [];
  for (const it of items) {
    const deposit = toNum(pick(it, ['deposit']));
    const monthlyRent = toNum(pick(it, ['monthlyRent']));
    // 단독·다가구만 전용면적 대신 연면적(totalFloorAr)으로 제공된다
    const excluUseAr = toNum(pick(it, ['excluUseAr', 'totalFloorAr']));
    const dealYear = toNum(pick(it, ['dealYear']));
    const dealMonth = toNum(pick(it, ['dealMonth']));
    const dealDay = toNum(pick(it, ['dealDay']));

    // 보증금·월세가 모두 0이거나 계약일이 없는 행은 통계에 쓸 수 없다
    if (deposit <= 0 && monthlyRent <= 0) continue;
    if (!dealYear || !dealMonth) continue;

    records.push({
      sggCd: pick(it, ['sggCd']) || code,
      umdNm: pick(it, ['umdNm']) || '',
      houseType: pick(it, ['houseType']) || (type === '연립다세대' ? '다세대' : type),
      mhouseNm: pick(it, ['mhouseNm', 'offiNm', 'aptNm']) || '',
      jibun: pick(it, ['jibun']) || '',
      buildYear: toNum(pick(it, ['buildYear'])) || null,
      dealYear, dealMonth, dealDay: dealDay || null,
      dealDate: `${dealYear}.${String(dealMonth).padStart(2, '0')}.${String(dealDay || 1).padStart(2, '0')}`,
      dealYm: `${dealYear}-${String(dealMonth).padStart(2, '0')}`,
      deposit, monthlyRent, excluUseAr,
      floor: toNum(pick(it, ['floor'])),
      contractType: pick(it, ['contractType']) || '',
      buildingType: type,
    });
  }

  cache.set(cacheKey, { at: Date.now(), records });
  return { records, failed: false, reason: null, fromCache: false };
}

/**
 * 한 시군구의 전월세 실거래를 유형×개월 전체로 수집해 정제·중복제거한다.
 * analyze.js(주변지역 수집)에서도 이 함수를 그대로 쓴다.
 *
 * @param {object} opts
 * @param {string} opts.serviceKey
 * @param {string} opts.code 시군구코드
 * @param {number} [opts.months=12] 조회 개월 수
 * @param {string[]} [opts.buildingTypes] 미지정 시 연립다세대만
 * @returns {Promise<{records:object[], meta:object}>}
 */
async function collectRegion({ serviceKey, code, months = 12, buildingTypes }) {
  const types = (buildingTypes && buildingTypes.length ? buildingTypes : [DEFAULT_TYPE])
    .filter((t) => ENDPOINTS[t]);
  const monthList = recentMonths(months);

  const jobs = [];
  for (const t of types) for (const m of monthList) jobs.push({ t, m });
  const results = await runLimited(
    jobs.map(({ t, m }) => () => fetchOne(serviceKey, code, t, m)),
    CONCURRENCY,
  );

  const seen = new Set();
  const records = [];
  const failedMonths = [];
  const failReasons = new Set();
  let cacheHits = 0;

  results.forEach((r, i) => {
    if (!r || r.failed) {
      failedMonths.push(`${jobs[i].t} ${jobs[i].m}`);
      if (r && r.reason) failReasons.add(r.reason);
      return;
    }
    if (r.fromCache) cacheHits += 1;
    for (const rec of r.records) {
      const k = recordKey(rec);
      if (seen.has(k)) continue;
      seen.add(k);
      records.push(rec);
    }
  });

  const countByMonth = {};
  for (const r of records) countByMonth[r.dealYm] = (countByMonth[r.dealYm] || 0) + 1;

  // 최근 3개월 표본이 있는지가 '현재 시세'로서의 쓸모를 가른다
  const recent3 = monthList.slice(0, 3).map((m) => `${m.slice(0, 4)}-${m.slice(4)}`);
  const recentCount = recent3.reduce((s, m) => s + (countByMonth[m] || 0), 0);

  return {
    records,
    meta: {
      sigunguCode: code,
      collectedAt: new Date().toISOString(),
      periodFrom: monthList[monthList.length - 1],
      periodTo: monthList[0],
      months,
      totalCount: records.length,
      countByMonth,
      recentCount,
      failedMonths,
      failReasons: [...failReasons],
      cacheHits,
      requested: jobs.length,
      isMock: false,
    },
  };
}

// ===== 핸들러 =====

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST만 허용합니다' } });
  }

  const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const code = String(body.sigunguCode || '').trim();

    if (!/^\d{5}$/.test(code)) {
      return res.status(400).json({ ok: false, error: { code: 'BAD_REGION', message: '시군구코드 5자리가 필요합니다' } });
    }

    // 키가 없으면 클라이언트가 Mock 데이터로 넘어갈 수 있게 사유를 분명히 알려 준다
    if (!serviceKey) {
      return res.status(502).json({
        ok: false,
        error: {
          code: 'NO_SERVICE_KEY',
          message: '공공데이터 인증키가 설정되지 않았습니다 (.env.local의 DATA_GO_KR_SERVICE_KEY). 샘플 데이터로 먼저 둘러보실 수 있습니다.',
        },
      });
    }

    const months = Math.min(Math.max(Number(body.months) || 12, 1), 24);
    const result = await collectRegion({ serviceKey, code, months, buildingTypes: body.buildingTypes });

    if (result.records.length === 0 && result.meta.failReasons.includes('KEY_OR_PERMISSION')) {
      return res.status(502).json({
        ok: false,
        error: {
          code: 'KEY_OR_PERMISSION',
          message: '인증키가 등록되지 않았거나 "연립다세대 전월세 실거래가 자료" 활용신청이 승인되지 않았습니다. data.go.kr 마이페이지에서 승인 상태를 확인해 주세요.',
        },
      });
    }
    if (result.records.length === 0 && result.meta.failReasons.includes('QUOTA_EXCEEDED')) {
      return res.status(502).json({
        ok: false,
        error: { code: 'QUOTA_EXCEEDED', message: '공공데이터 일일 호출 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.' },
      });
    }

    return res.status(200).json({ ok: true, data: result });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: { code: 'INTERNAL', message: `실거래가를 불러오는 중 오류가 발생했습니다: ${err.message}` },
    });
  }
};

// analyze.js에서 재사용하기 위해 수집 함수를 함께 내보낸다
module.exports.collectRegion = collectRegion;
module.exports.DEFAULT_TYPE = DEFAULT_TYPE;
