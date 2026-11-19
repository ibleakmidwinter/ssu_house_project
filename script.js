/* ==========================================================================
   script.js — 방값판독기 클라이언트 전체 로직
   1단계(조회·파싱·판정 엔진) · 2단계(UI 연결) · 3단계(예외 처리)

   설계 원칙: 모든 수치 계산은 이 파일의 순수 함수가 결정론적으로 수행한다.
   AI(api/*.js)는 이미 계산된 숫자를 '설명'만 한다.
   파일을 나누지 않고 섹션 주석으로 구획한다. (AGENTS.md 규칙)
   ========================================================================== */

// ===== 0. 빌드 표식 =====
// 브라우저가 옛 파일을 캐시하고 있으면 수정이 반영되지 않는다.
// 화면 하단과 콘솔에 이 값을 찍어 어느 버전이 돌고 있는지 바로 알 수 있게 한다.
const BUILD = '2026-11-19 b5';

// ===== 1. 상태 =====

/** 앱 전역 상태 */
const appState = {
  regionMode: 'text',          // 'text' | 'select'
  input: {
    sido: '', sigungu: '', sigunguCode: '', dong: '',
    houseType: '전체',          // '전체' | '연립' | '다세대'
    contractType: '전세',       // '전세' | '월세'
    deposit: null, monthlyRent: 0,
    areaM2: null, buildYear: null,
    conversionRate: 5.5,       // 전월세전환율(%) 기본값. PRD 기준.
    maintenanceFee: null, addressDisclosure: '', postingAge: '', agentNumber: '',
  },
  raw: null,                   // 수집 원본 { records, meta }
  result: null,                // 분석 결과
  tableShown: 10,              // 비교 테이블에 보여 준 행 수
};

/** data/*.json 정적 데이터. fetch 실패 시 폴백을 쓴다. */
const refData = { regions: null, landmarks: null, adjacency: null, riskRules: null, mock: null, loaded: false };

/** data/*.json 을 못 읽을 때 쓰는 최소 지역 목록 (첫 화면은 어떤 상황에서도 동작해야 한다) */
const REGION_FALLBACK = [
  { sido: '서울특별시', sigungu: '동작구', code: '11590' },
  { sido: '서울특별시', sigungu: '관악구', code: '11620' },
  { sido: '서울특별시', sigungu: '서대문구', code: '11410' },
  { sido: '서울특별시', sigungu: '마포구', code: '11440' },
  { sido: '서울특별시', sigungu: '성북구', code: '11290' },
  { sido: '서울특별시', sigungu: '동대문구', code: '11230' },
  { sido: '서울특별시', sigungu: '광진구', code: '11215' },
  { sido: '서울특별시', sigungu: '성동구', code: '11200' },
];
const LANDMARK_FALLBACK = [
  { name: '숭실대', aliases: ['상도동'], code: '11590' },
  { name: '중앙대', aliases: ['흑석동'], code: '11590' },
  { name: '서울대', aliases: ['신림', '봉천동'], code: '11620' },
  { name: '연세대', aliases: ['신촌'], code: '11410' },
];

/**
 * data/mock-transactions.json 을 읽을 수 없을 때(파일을 직접 열었을 때) 쓰는 내장 샘플.
 * 난수를 쓰지 않고 고정 수열로 만들어 항상 같은 결과가 나오게 한다.
 *
 * @returns {object[]} 공공데이터 레코드와 같은 형태의 배열
 */
function buildEmbeddedMock() {
  const names = ['럭키상도빌라', '동작그린빌', '성대리치빌', '숭실하이츠', '상도삼성빌라', '퍼스트빌'];
  const dongs = ['상도동', '상도동', '상도동', '사당동', '흑석동'];
  const areas = [16.5, 19.8, 23.1, 26.4, 29.7, 33.0, 36.3, 42.9, 49.5, 56.1];
  const recs = [];
  const now = new Date();
  for (let i = 0; i < 60; i += 1) {
    const area = areas[i % areas.length] + ((i % 5) - 2) * 0.3;
    // ㎡당 전세 환산 단가를 고정 수열로 흔들어 분포를 만든다
    const perM2 = 380 + ((i * 37) % 140);
    const je = perM2 * area;
    const isJeonse = i % 9 < 4;
    const deposit = isJeonse ? Math.round(je / 100) * 100 : Math.round((je * (0.1 + (i % 4) * 0.05)) / 100) * 100;
    const rent = isJeonse ? 0 : Math.max(20, Math.round(((je - deposit) * 0.055) / 12));
    const d = new Date(now.getFullYear(), now.getMonth() - (i % 12), 1);
    recs.push({
      sggCd: '11590', umdNm: dongs[i % dongs.length], houseType: i % 4 === 0 ? '연립' : '다세대',
      mhouseNm: names[i % names.length], jibun: `${100 + i}-${1 + (i % 20)}`,
      buildYear: 1995 + (i % 29),
      dealYear: d.getFullYear(), dealMonth: d.getMonth() + 1, dealDay: 1 + (i % 28),
      dealDate: `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(1 + (i % 28)).padStart(2, '0')}`,
      dealYm: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      deposit, monthlyRent: rent, excluUseAr: Math.round(area * 100) / 100,
      floor: (i % 6) - 1, contractType: '', buildingType: '연립다세대',
    });
  }
  return recs;
}

/** 유사 면적 허용 오차. 기본 ±15%, 표본이 모자라면 ±25%로 넓힌다. (PRD 3.1 / 3단계 2.1) */
const AREA_TOLERANCE = 0.15;
const AREA_TOLERANCE_WIDE = 0.25;
const MIN_COMPARABLES = 5;

/** 괴리율 기준 판정 등급. (PRD 3.3) */
const GRADES = [
  { max: -5,       key: 'safe',   emoji: '🟢', name: '안심', tone: 'safe',
    comment: '주변 시세보다 저렴한 편입니다.' },
  { max: 10,       key: 'fair',   emoji: '🔵', name: '적정', tone: 'fair',
    comment: '적정 시세 범위 내에 있습니다.' },
  { max: 20,       key: 'warn',   emoji: '🟡', name: '주의', tone: 'warn',
    comment: '주변 평균보다 다소 높습니다. 옵션이나 신축 여부를 확인하세요.' },
  { max: Infinity, key: 'danger', emoji: '🔴', name: '위험', tone: 'danger',
    comment: '주변 시세보다 현저히 비쌉니다. 계약 전 시세와 조건을 재확인하세요.' },
];

// ===== 2. 유틸(금액·면적·포맷) =====

const PYEONG_TO_M2 = 3.3058; // 1평 = 3.3058㎡

/**
 * 만원 단위 숫자를 한국식 금액 문구로 바꾼다. (예: 12000 → "1억 2,000만원")
 * @param {number} manwon 금액 (만원)
 * @returns {string}
 */
function formatManwon(manwon) {
  if (manwon === null || manwon === undefined || Number.isNaN(Number(manwon))) return '';
  const n = Math.round(Number(manwon));
  if (n === 0) return '0원';
  const eok = Math.floor(n / 10000); // 1억 = 10,000만원
  const rest = n % 10000;
  if (eok > 0 && rest > 0) return `${eok}억 ${rest.toLocaleString('ko-KR')}만원`;
  if (eok > 0) return `${eok}억원`;
  return `${n.toLocaleString('ko-KR')}만원`;
}

/** 차트 축 레이블용 짧은 금액 표기 (예: 12000 → "1.2억") */
function formatShort(manwon) {
  const n = Math.round(Number(manwon) || 0);
  if (n >= 10000) {
    const eok = n / 10000;
    return `${eok >= 10 ? Math.round(eok) : Math.round(eok * 10) / 10}억`;
  }
  return n.toLocaleString('ko-KR');
}

/** 평 → ㎡ */
function pyeongToM2(pyeong) { return Math.round(pyeong * PYEONG_TO_M2 * 100) / 100; }
/** ㎡ → 평 */
function m2ToPyeong(m2) { return Math.round((m2 / PYEONG_TO_M2) * 10) / 10; }

/** 사용 가능한 지역·랜드마크 목록 (JSON 로드 실패 시 폴백) */
function regionList() { return refData.regions || REGION_FALLBACK; }
function landmarkList() { return refData.landmarks || LANDMARK_FALLBACK; }

/**
 * 입력 문장에서 지역 후보를 찾는다.
 * 랜드마크(대학·역) 표를 먼저 보고 그다음 시군구 이름을 본다.
 * AI 지리 추측보다 표를 우선해 엉뚱한 지역이 나오는 것을 막는다.
 *
 * @param {string} query 사용자 입력
 * @returns {Array<{sido:string, sigungu:string, code:string, matched:string}>} 최대 8개
 */
function searchRegion(query) {
  const q = String(query || '').trim().replace(/\s+/g, '');
  if (q.length < 2) return [];
  const regions = regionList();
  const byCode = new Map(regions.map((r) => [r.code, r]));
  const hits = []; const pushed = new Set();

  const add = (code, matched) => {
    const r = byCode.get(code);
    if (!r) return;
    const key = `${code}:${matched}`;
    if (pushed.has(key)) return;
    pushed.add(key);
    hits.push({ sido: r.sido, sigungu: r.sigungu, code: r.code, matched });
  };

  for (const lm of landmarkList()) {
    const names = [lm.name, ...(lm.aliases || [])];
    const m = names.find((n) => q.includes(n) || n.includes(q));
    if (m) add(lm.code, m);
  }
  for (const r of regions) {
    const bare = r.sigungu.replace(/\s+/g, '');
    if (bare.includes(q) || q.includes(bare)) add(r.code, r.sigungu);
  }
  return hits.slice(0, 8);
}

/** 짧은 안내 메시지를 2.6초간 띄운다. */
let toastTimer = null;
function showToast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/** 로딩 오버레이 — 경과 시간을 함께 보여 주고, 길어지면 탈출 버튼을 띄운다 */
let loadingTimer = null;
let loadingStartedAt = 0;

function showLoading(title, step, pct) {
  const box = document.getElementById('loading');
  if (!box) return;
  box.hidden = false;
  document.getElementById('loading-title').textContent = title;
  document.getElementById('loading-step').textContent = step || '';
  document.getElementById('loading-fill').style.width = `${Math.max(0, Math.min(100, pct || 0))}%`;

  // 타이머는 한 번만 시작한다 (showLoading은 단계마다 여러 번 불린다)
  if (loadingTimer === null) {
    loadingStartedAt = Date.now();
    const esc = document.getElementById('loading-escape');
    const el = document.getElementById('loading-elapsed');
    loadingTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - loadingStartedAt) / 1000);
      if (el) el.textContent = `${sec}초 경과`;
      // 5초가 넘으면 멈춰 있는 것처럼 보이므로 빠져나갈 길을 준다
      if (esc && sec >= 5) esc.hidden = false;
    }, 500);
  }
}

function hideLoading() {
  const box = document.getElementById('loading');
  if (box) box.hidden = true;
  if (loadingTimer !== null) { clearInterval(loadingTimer); loadingTimer = null; }
  const esc = document.getElementById('loading-escape');
  if (esc) esc.hidden = true;
}

/** HTML 주입을 막기 위해 문자열을 이스케이프한다. 공공데이터의 건물명 등을 표에 넣을 때 쓴다. */
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===== 3. 통계 =====

/**
 * 월세를 전세로 환산한 금액(환산보증금)을 구한다.
 * 전세와 월세 매물을 같은 축에서 비교하기 위해 필요하다. (PRD 3.2)
 *
 * @param {number} deposit 보증금 (만원)
 * @param {number} monthlyRent 월세 (만원)
 * @param {number} conversionRate 전월세전환율 (%) — 예: 5.5
 * @returns {number} 환산보증금 (만원)
 */
function toJeonseEquivalent(deposit, monthlyRent, conversionRate) {
  const rate = Number(conversionRate) > 0 ? Number(conversionRate) : 5.5;
  const rent = Number(monthlyRent) || 0;
  // 전세(월세 0)면 보증금이 곧 환산보증금이다
  if (rent === 0) return Math.round(Number(deposit) || 0);
  // 연간 월세를 전환율로 나누면 같은 가치의 보증금이 된다
  return Math.round((Number(deposit) || 0) + (rent * 12) / (rate / 100));
}

/**
 * 백분위수를 선형 보간으로 구한다.
 * @param {number[]} sorted 오름차순 정렬된 값
 * @param {number} p 0~100
 * @returns {number}
 */
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx); const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * 값 배열의 기술통계를 구한다. (PRD 3.3: 최저가·Q1·중앙값·평균·Q3·최고가)
 * @param {number[]} values
 * @returns {{n:number, min:number, q1:number, median:number, mean:number, q3:number, max:number, std:number, p5:number, p10:number}}
 */
function describe(values) {
  const v = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return { n: 0, min: 0, q1: 0, median: 0, mean: 0, q3: 0, max: 0, std: 0, p5: 0, p10: 0 };
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const variance = v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length;
  return {
    n: v.length,
    min: Math.round(v[0]),
    q1: Math.round(percentile(v, 25)),
    median: Math.round(percentile(v, 50)),
    mean: Math.round(mean),
    q3: Math.round(percentile(v, 75)),
    max: Math.round(v[v.length - 1]),
    std: Math.round(Math.sqrt(variance)),
    p5: Math.round(percentile(v, 5)),
    p10: Math.round(percentile(v, 10)),
  };
}

/**
 * IQR 1.5배 규칙으로 이상치를 걸러낸다.
 * 표본이 20건 미만이면 IQR이 불안정하고 지울 여유도 없어 그대로 둔다.
 *
 * @param {object[]} items 레코드 배열
 * @param {(o:object)=>number} getter 판정에 쓸 값
 * @returns {{kept:object[], removed:object[]}}
 */
function trimOutliers(items, getter) {
  if (items.length < 20) return { kept: items.slice(), removed: [] };
  const sorted = items.map(getter).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const q1 = percentile(sorted, 25);
  const q3 = percentile(sorted, 75);
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  const kept = []; const removed = [];
  for (const it of items) {
    const v = getter(it);
    if (Number.isFinite(v) && v >= lo && v <= hi) kept.push(it);
    else removed.push(it);
  }
  // 너무 많이 걸러지면(1/3 초과) 분포 자체가 넓은 것이므로 원본을 쓴다
  if (removed.length > items.length / 3) return { kept: items.slice(), removed: [] };
  return { kept, removed };
}

/**
 * 값이 분포에서 몇 퍼센타일인지 구한다.
 * @param {number[]} sorted 오름차순 값
 * @param {number} value
 * @returns {number} 0~100
 */
function percentileOf(sorted, value) {
  if (!sorted.length) return 50;
  let below = 0;
  for (const v of sorted) { if (v < value) below += 1; else break; }
  return Math.max(0, Math.min(100, (below / sorted.length) * 100));
}

/**
 * 괴리율(%)을 구한다. 양수면 주변보다 비싸다는 뜻이다. (PRD 3.3)
 * @param {number} myPrice 내 매물 환산보증금
 * @param {number} median 주변 중앙값
 * @returns {number} 소수 첫째 자리까지
 */
function gapRate(myPrice, median) {
  if (!median) return 0;
  return Math.round(((myPrice - median) / median) * 1000) / 10;
}

/**
 * 괴리율로 판정 등급을 정한다. (PRD 3.3)
 * @param {number} gapPct 괴리율(%)
 * @returns {object} GRADES 항목
 */
function gradeOf(gapPct) {
  // -5 미만 안심 / -5~10 적정 / 10~20 주의 / 20 초과 위험
  return GRADES.find((g) => gapPct < g.max) || GRADES[GRADES.length - 1];
}

/**
 * 비교 대상 거래를 추린다.
 * 동네 → 주택유형 → 유사 면적(±15%, 부족하면 ±25%, 그래도 부족하면 면적 무시) 순으로 넓힌다. (PRD 3.1 / 3단계 2.1)
 *
 * @param {object[]} records 정제된 실거래 레코드
 * @param {object} input appState.input
 * @returns {{list:object[], tolerance:number|null, expanded:boolean, steps:string[]}}
 */
function selectComparables(records, input) {
  const steps = [];
  let base = records.slice();

  // 1) 동네
  // 법정동은 '상도동'과 '상도1동'이 따로 있어 정확일치만 보면 거래를 놓친다.
  // 숫자를 뗀 이름이 같으면 같은 생활권으로 본다.
  if (input.dong) {
    const norm = (v) => String(v || '').replace(/[0-9]/g, '');
    const want = norm(input.dong);
    const inDong = base.filter((r) => r.umdNm === input.dong || norm(r.umdNm) === want);
    if (inDong.length >= MIN_COMPARABLES) base = inDong;
    else steps.push(`${input.dong} 거래가 ${inDong.length}건뿐이라 시군구 전체로 넓혔습니다`);
  }

  // 2) 주택유형 (전체면 거르지 않는다)
  if (input.houseType && input.houseType !== '전체') {
    const typed = base.filter((r) => String(r.houseType || '').includes(input.houseType));
    if (typed.length >= MIN_COMPARABLES) base = typed;
    else steps.push(`'${input.houseType}' 거래가 ${typed.length}건뿐이라 연립·다세대 전체로 분석했습니다`);
  }

  // 3) 유사 면적
  if (!input.areaM2) {
    return { list: base, tolerance: null, expanded: false, steps };
  }
  for (const tol of [AREA_TOLERANCE, AREA_TOLERANCE_WIDE]) {
    const lo = input.areaM2 * (1 - tol);
    const hi = input.areaM2 * (1 + tol);
    const near = base.filter((r) => r.excluUseAr >= lo && r.excluUseAr <= hi);
    if (near.length >= MIN_COMPARABLES) {
      if (tol !== AREA_TOLERANCE) steps.push(`비슷한 면적 거래가 적어 면적 범위를 ±${Math.round(tol * 100)}%로 넓혔습니다`);
      return { list: near, tolerance: tol, expanded: tol !== AREA_TOLERANCE, steps };
    }
  }
  steps.push('비슷한 면적 거래가 5건 미만이라 면적 조건 없이 분석했습니다');
  return { list: base, tolerance: null, expanded: true, steps };
}

/**
 * 허위매물 신호를 규칙으로 점검한다.
 * '너무 비싼가'는 판정 등급이 보고, 여기서는 '설명되지 않게 싼가'를 본다.
 * 점수는 이 함수만 계산하고 AI는 설명만 한다. 단정 표현을 쓰지 않는다.
 *
 * @param {object} ctx { myPrice, stats, values, comparables, input }
 * @returns {{score:number, grade:string, tone:string, message:string, signals:object[], notEvaluated:string[], cap:number|null}}
 */
function checkRiskSignals(ctx) {
  const { myPrice, stats, values, comparables, input } = ctx;
  const signals = [];
  const notEvaluated = [];
  const pct = percentileOf(values, myPrice);
  const z = stats.std > 0 ? (myPrice - stats.mean) / stats.std : 0;

  // R1 이례적 저가 — 미끼 매물의 가장 흔한 형태
  if (stats.n >= 5 && myPrice < stats.p10) {
    signals.push({ id: 'R1', name: '이례적 저가', points: 15,
      actual: `${formatManwon(myPrice)} (하위 ${Math.round(pct)}%)`, threshold: `하위 10% = ${formatManwon(stats.p10)}`,
      why: '주변 실거래 대부분보다 낮은 가격입니다. 미끼 매물에서 가장 흔한 형태라 한 번 더 확인할 가치가 있습니다.' });
  }
  // R1+ 극단적 저가 — 실거래로 설명되지 않는 수준
  if (stats.n >= 10 && (myPrice < stats.p5 || z < -2.5)) {
    signals.push({ id: 'R1P', name: '극단적 저가', points: 20,
      actual: `${formatManwon(myPrice)} (표준편차 ${z.toFixed(1)}배)`, threshold: `하위 5% = ${formatManwon(stats.p5)}`,
      why: '주변 실거래로는 설명되지 않는 가격대입니다. 실제 존재하는 매물인지 전화로 먼저 확인해 보세요.' });
  }
  // R2 면적-가격 불일치 — '넓고 싼 집'으로 유인하는 패턴
  if (input.areaM2 && comparables.length >= 10) {
    const areas = comparables.map((r) => r.excluUseAr).sort((a, b) => a - b);
    const areaPct = percentileOf(areas, input.areaM2);
    if (areaPct >= 75 && pct <= 10) {
      signals.push({ id: 'R2', name: '면적-가격 불일치', points: 15,
        actual: `면적 상위 ${Math.round(100 - areaPct)}%인데 가격은 하위 ${Math.round(pct)}%`, threshold: '면적 상위 25% + 가격 하위 10%',
        why: '넓은데 싼 조건이 겹칩니다. 실제 전용면적과 사진이 같은 집인지 확인이 필요합니다.' });
    }
  } else if (!input.areaM2) {
    notEvaluated.push('전용면적을 입력하면 면적 대비 가격을 점검할 수 있습니다');
  }
  // R3 비현실적 조건 조합
  if (input.buildYear && input.areaM2 && comparables.length >= 10) {
    const age = new Date().getFullYear() - input.buildYear;
    const areas = comparables.map((r) => r.excluUseAr).sort((a, b) => a - b);
    if (age <= 5 && percentileOf(areas, input.areaM2) >= 75 && pct <= 10) {
      signals.push({ id: 'R3', name: '비현실적 조건 조합', points: 15,
        actual: `준공 ${age}년 + 넓은 면적 + 하위 ${Math.round(pct)}% 가격`, threshold: '신축 5년 이내 + 면적 상위 25% + 가격 하위 10%',
        why: '세 조건이 동시에 성립하는 실거래는 드뭅니다. 조건이 실제와 같은지 확인해 보세요.' });
    }
  } else if (!input.buildYear) {
    notEvaluated.push('건축년도를 입력하면 신축 여부까지 함께 점검할 수 있습니다');
  }
  // R4 관리비 위장 의심
  if (input.maintenanceFee !== null && input.monthlyRent > 0) {
    const ratio = input.maintenanceFee / input.monthlyRent;
    if (ratio > 0.35) {
      signals.push({ id: 'R4', name: '관리비 비중이 큼', points: 12,
        actual: `월세 ${input.monthlyRent}만원 대비 관리비 ${input.maintenanceFee}만원 (${Math.round(ratio * 100)}%)`,
        threshold: '관리비가 월세의 35% 초과',
        why: '월세를 낮게 보이게 하고 관리비로 받는 경우가 있습니다. 관리비에 무엇이 포함되는지 물어보세요.' });
    }
  } else if (input.maintenanceFee === null) {
    notEvaluated.push('관리비를 입력하면 관리비로 월세를 낮춰 보이게 한 경우를 점검할 수 있습니다');
  }
  // R5 정보 은닉
  if (input.addressDisclosure === 'hidden') {
    signals.push({ id: 'R5', name: '주소 비공개', points: 10,
      actual: '주소 비공개', threshold: '지번 또는 동까지 공개',
      why: '주소를 알 수 없으면 등기부등본으로 소유자와 근저당을 확인할 수 없습니다.' });
    if (!input.agentNumber) {
      signals.push({ id: 'R5P', name: '책임 주체 확인 불가', points: 8,
        actual: '주소·중개사 등록번호 모두 없음', threshold: '둘 중 하나는 확인 가능',
        why: '문제가 생겼을 때 확인하고 책임을 물을 대상이 없습니다.' });
    }
  } else if (!input.addressDisclosure) {
    notEvaluated.push('주소 공개 수준을 선택하면 정보 은닉 여부를 점검할 수 있습니다');
  }
  // R6 장기 게시 모순
  if (input.postingAge === '1개월 이상' && pct <= 25) {
    signals.push({ id: 'R6', name: '오래된 저가 매물', points: 10,
      actual: `게시 1개월 이상 + 가격 하위 ${Math.round(pct)}%`, threshold: '1개월 이상 게시 + 가격 하위 25%',
      why: '조건이 좋은데 오래 남아 있는 것은 모순입니다. 지금도 계약 가능한 매물인지 확인해 보세요.' });
  } else if (!input.postingAge) {
    notEvaluated.push('게시 기간을 선택하면 오래 남아 있는 저가 매물인지 점검할 수 있습니다');
  }
  // R7 비교 가능한 실거래 없음
  if (stats.n < MIN_COMPARABLES) {
    signals.push({ id: 'R7', name: '비교할 실거래가 거의 없음', points: 8,
      actual: `비교 거래 ${stats.n}건`, threshold: `${MIN_COMPARABLES}건 이상`,
      why: '같은 조건의 거래가 거의 없어 가격이 적정한지 판단할 근거가 부족합니다.' });
  }
  // R8 유사 저가 실거래 존재 → 의심을 덜어 준다 (감점)
  if (stats.n >= 10 && myPrice < stats.p10) {
    const near = values.filter((v) => Math.abs(v - myPrice) <= myPrice * 0.1).length;
    if (near >= 2) {
      signals.push({ id: 'R8', name: '비슷한 가격의 실거래가 있음', points: -5,
        actual: `±10% 범위에 실거래 ${near}건`, threshold: '2건 이상',
        why: '그 가격대 거래가 실제로 있으므로 가격만으로 의심할 이유는 줄어듭니다.' });
    }
  }

  let score = signals.reduce((s, x) => s + x.points, 0);
  score = Math.max(0, Math.min(100, score));

  // 표본이 빈약할 때 단정적 판정은 오판 위험이 더 크므로 상한을 둔다
  let cap = null;
  if (stats.n < 10) { cap = 49; }
  else if (stats.n < 30) { cap = 74; }
  if (cap !== null && score > cap) score = cap;

  const grade = score <= 29 ? '정상 범위' : score <= 59 ? '주의' : '높은 주의';
  const tone = score <= 29 ? 'ok' : score <= 59 ? 'warn' : 'danger';
  const positive = signals.filter((s) => s.points > 0).length;
  const message = positive === 0
    ? '확인이 필요한 특이 신호는 발견되지 않았습니다'
    : `확인이 필요한 신호가 ${positive}개 있습니다`;

  return { score, grade, tone, message, signals, notEvaluated, cap, percentile: Math.round(pct) };
}

/**
 * 전체 분석 파이프라인. 수집 레코드를 판정 결과로 바꾼다.
 *
 * @param {object} raw { records, meta }
 * @param {object} input appState.input
 * @returns {object} 분석 결과
 */
function analyze(raw, input) {
  const rate = input.conversionRate;

  // 모든 거래를 환산보증금으로 통일한다 (PRD 3.2)
  const records = raw.records.map((r) => ({
    ...r,
    jeonseEquivalent: toJeonseEquivalent(r.deposit, r.monthlyRent, rate),
  }));

  const sel = selectComparables(records, input);
  // 실거래에는 특수 거래(가족 간 거래, 신고 오류 등)가 섞여 최저·최고가가 크게 튄다.
  // 중앙값은 영향이 적지만 '최저~최고' 표시가 오해를 부르므로 IQR 규칙으로 걸러낸다.
  const trimmed = trimOutliers(sel.list, (r) => r.jeonseEquivalent);
  const comparables = trimmed.kept;
  const values = comparables.map((r) => r.jeonseEquivalent).sort((a, b) => a - b);
  const stats = describe(values);

  const myPrice = toJeonseEquivalent(input.deposit, input.monthlyRent, rate);
  const gapPct = gapRate(myPrice, stats.median);
  const grade = gradeOf(gapPct);

  const risk = checkRiskSignals({ myPrice, stats, values, comparables, input });

  // 동 목록은 다음 조회의 자동완성에 쓴다
  const dongs = [...new Set(records.map((r) => r.umdNm).filter(Boolean))].sort();

  return {
    input: { ...input },
    meta: raw.meta,
    comparables: comparables.slice().sort((a, b) => (a.dealDate < b.dealDate ? 1 : -1)),
    values, stats, myPrice, gapPct, grade, risk,
    selection: sel,
    outliersRemoved: trimmed.removed.length,
    dongs,
    neighborhood: null, // 아래 attachNeighborhood()에서 채운다
    computedAt: new Date().toISOString(),
  };
}

/**
 * 주변 시군구 수집 결과를 붙인다. (추가 기능: 예산에 맞는 가까운 동네 찾기)
 * @param {object} result analyze() 결과
 * @param {object} byCode { 코드: {records, meta} }
 * @returns {object} result
 */
function attachNeighborhood(result, byCode) {
  const regions = regionList();
  const nameOf = (code) => (regions.find((x) => x.code === code) || {}).sigungu || code;
  const rate = result.input.conversionRate;
  const list = [];

  for (const code of Object.keys(byCode)) {
    const recs = (byCode[code].records || []).map((r) => ({
      ...r, jeonseEquivalent: toJeonseEquivalent(r.deposit, r.monthlyRent, rate),
    }));
    if (recs.length === 0) continue;
    // 기준 지역과 같은 조건(면적 ±15%)으로 비교해야 의미가 있다
    const sel = selectComparables(recs, { ...result.input, dong: '' });
    const s = describe(sel.list.map((r) => r.jeonseEquivalent));
    if (s.n < 5) continue;
    list.push({ code, name: nameOf(code), median: s.median, q1: s.q1, q3: s.q3, n: s.n });
  }

  list.sort((a, b) => a.median - b.median);
  const myMedian = result.stats.median;
  const medians = list.map((r) => r.median).sort((a, b) => a - b);
  const relPct = medians.length ? Math.round(percentileOf(medians, myMedian)) : null;
  const relLabel = relPct === null ? null : relPct <= 35 ? '저렴한' : relPct >= 65 ? '비싼' : '비슷한';

  // 내 매물 가격이 '보통 거래되는 범위(Q1~Q3)' 안에 들어가고, 중앙값이 더 싼 동네를 추천한다
  const alternatives = list
    .filter((r) => result.myPrice >= r.q1 && result.myPrice <= r.q3 && r.median < myMedian)
    .map((r) => ({
      region: r.name, median: r.median, n: r.n,
      savingsPct: Math.round(((myMedian - r.median) / myMedian) * 1000) / 10,
    }))
    .sort((a, b) => b.savingsPct - a.savingsPct)
    .slice(0, 3);

  result.neighborhood = { regions: list, relativePercentile: relPct, relativeLabel: relLabel, alternatives };
  return result;
}

// ===== 4. API 호출 =====

/**
 * 서버리스 함수를 호출한다. 응답은 { ok, data } 또는 { ok:false, error }.
 * @param {string} path '/api/...'
 * @param {object} body
 * @returns {Promise<object>} data
 * @throws {Error} code 속성에 사유가 담긴 예외
 */
async function callApi(path, body, timeoutMs = 45000) {
  let res;
  // 타임아웃이 없으면 응답이 오지 않을 때 화면이 영원히 멈춘다. 반드시 끊어 준다.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    const e = new Error(timedOut
      ? `응답이 ${Math.round(timeoutMs / 1000)}초 안에 오지 않아 중단했습니다.`
      : '서버 기능을 쓸 수 없습니다. 터미널에서 "npx vercel dev"로 실행해 주세요. (python -m http.server로는 /api 함수가 동작하지 않습니다)');
    e.code = timedOut ? 'TIMEOUT' : 'NO_SERVER';
    throw e;
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  if (!json) {
    const e = new Error('서버 응답을 읽을 수 없습니다. "npx vercel dev"로 실행 중인지 확인해 주세요.');
    e.code = 'NO_SERVER';
    throw e;
  }
  if (!json.ok) {
    const e = new Error(json.error?.message || '요청이 실패했습니다');
    e.code = json.error?.code || 'ERROR';
    throw e;
  }
  return json.data;
}

/** 정적 데이터(data/*.json)를 한 번만 불러온다. 실패해도 폴백으로 동작한다. */
async function loadRefData() {
  if (refData.loaded) return;
  const files = {
    regions: 'data/legal-dong-codes.json',
    landmarks: 'data/landmarks.json',
    adjacency: 'data/sigungu-adjacency.json',
    riskRules: 'data/risk-rules.json',
    mock: 'data/mock-transactions.json',
  };
  await Promise.all(Object.entries(files).map(async ([key, path]) => {
    try {
      const res = await fetch(path);
      if (!res.ok) return;
      const json = await res.json();
      if (key === 'regions') refData.regions = json.regions;
      else if (key === 'landmarks') refData.landmarks = json.landmarks;
      else if (key === 'adjacency') refData.adjacency = json.adjacency;
      else refData[key] = json;
    } catch { /* 폴백으로 동작한다 */ }
  }));
  refData.loaded = true;
}

/**
 * Mock 샘플 데이터를 수집 결과 형태로 돌려준다. (3단계 2.1: API 오류 시 폴백)
 * @returns {object|null} { records, meta } 또는 null
 */
function mockResult() {
  // data/mock-transactions.json 을 못 읽었으면 코드에 내장된 샘플을 쓴다.
  // 파일을 직접 열었을 때도 전체 흐름을 볼 수 있어야 한다. (AGENTS.md: 실행 가능성)
  if (!refData.mock) {
    return {
      records: buildEmbeddedMock(),
      meta: {
        sigunguCode: '11590', collectedAt: new Date().toISOString(),
        totalCount: 60, months: 12, isMock: true, isEmbedded: true,
        failedMonths: [], failReasons: [], recentCount: 0, countByMonth: {},
      },
    };
  }
  const records = refData.mock.records.map((r) => ({
    ...r,
    dealDate: `${r.dealYear}.${String(r.dealMonth).padStart(2, '0')}.${String(r.dealDay).padStart(2, '0')}`,
    dealYm: `${r.dealYear}-${String(r.dealMonth).padStart(2, '0')}`,
    buildingType: '연립다세대',
  }));
  return {
    records,
    meta: {
      sigunguCode: refData.mock.sigunguCode,
      collectedAt: new Date().toISOString(),
      totalCount: records.length,
      months: 12,
      isMock: true,
      failedMonths: [], failReasons: [], recentCount: 0, countByMonth: {},
    },
  };
}

// ===== 5. SVG 차트 =====
// 차트 라이브러리를 쓰지 않고 SVG 문자열을 직접 만들어 넣는다. (AGENTS.md 규칙)

/** 차트 공통: 숫자를 안전한 좌표 문자열로 */
function n2(v) { return Math.round(v * 100) / 100; }

/**
 * 시세 분포 차트. 히스토그램 + 사분위 박스 + 중앙값 + 내 매물 위치를 한 그림에 그린다.
 *
 * @param {HTMLElement} el 그릴 위치
 * @param {object} opts { stats, values, myPrice }
 */
function renderDistribution(el, { stats, values, myPrice }) {
  if (!el) return;
  if (!stats.n) { el.innerHTML = '<p class="help">그릴 데이터가 없습니다.</p>'; return; }

  const W = 600; const H = 230;
  const padL = 14; const padR = 14; const padT = 18; const padB = 42;
  const plotW = W - padL - padR;

  // 내 매물이 범위 밖이어도 보이도록 축 범위를 넓힌다
  const lo = Math.min(stats.min, myPrice) * 0.96;
  const hi = Math.max(stats.max, myPrice) * 1.04;
  const x = (v) => padL + ((v - lo) / (hi - lo || 1)) * plotW;

  // 히스토그램: 20칸으로 나눠 건수를 센다
  const BINS = 20;
  const binW = (hi - lo) / BINS;
  const counts = new Array(BINS).fill(0);
  for (const v of values) {
    const i = Math.min(BINS - 1, Math.max(0, Math.floor((v - lo) / binW)));
    counts[i] += 1;
  }
  const maxCount = Math.max(...counts, 1);
  const barAreaH = H - padT - padB - 46;

  let bars = '';
  counts.forEach((c, i) => {
    if (!c) return;
    const h = (c / maxCount) * barAreaH;
    const bx = padL + (i / BINS) * plotW;
    const bw = (plotW / BINS) - 2;
    bars += `<rect x="${n2(bx)}" y="${n2(padT + barAreaH - h)}" width="${n2(bw)}" height="${n2(h)}" rx="2" class="bar"/>`;
  });

  const boxY = padT + barAreaH + 14;
  const boxH = 26;
  const x1 = x(stats.q1); const x3 = x(stats.q3); const xm = x(stats.median);
  const xMin = x(stats.min); const xMax = x(stats.max);
  const xMy = x(myPrice);

  // 축 눈금: 최저 / Q1 / 중앙 / Q3 / 최고
  const ticks = [
    { v: stats.min, label: '최저' },
    { v: stats.q1, label: '하위25%' },
    { v: stats.median, label: '중앙' },
    { v: stats.q3, label: '상위25%' },
    { v: stats.max, label: '최고' },
  ];
  let tickMarks = '';
  ticks.forEach((t, i) => {
    const tx = x(t.v);
    // 레이블이 서로 겹치지 않도록 양끝은 안쪽으로 당긴다
    const anchor = i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle';
    tickMarks += `<line x1="${n2(tx)}" y1="${n2(boxY + boxH)}" x2="${n2(tx)}" y2="${n2(boxY + boxH + 5)}" class="tick"/>`
      + `<text x="${n2(tx)}" y="${n2(boxY + boxH + 18)}" text-anchor="${anchor}" class="tick-val">${formatShort(t.v)}</text>`
      + `<text x="${n2(tx)}" y="${n2(boxY + boxH + 31)}" text-anchor="${anchor}" class="tick-lab">${t.label}</text>`;
  });

  const myTone = appState.result ? appState.result.grade.tone : 'fair';

  el.innerHTML = `
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="주변 실거래 ${stats.n}건의 분포와 내 매물 위치">
  <g class="dist">
    ${bars}
    <line x1="${n2(xMin)}" y1="${n2(boxY + boxH / 2)}" x2="${n2(xMax)}" y2="${n2(boxY + boxH / 2)}" class="whisker"/>
    <rect x="${n2(x1)}" y="${n2(boxY)}" width="${n2(Math.max(2, x3 - x1))}" height="${boxH}" rx="4" class="box"/>
    <line x1="${n2(xm)}" y1="${n2(boxY - 3)}" x2="${n2(xm)}" y2="${n2(boxY + boxH + 3)}" class="median"/>
    ${tickMarks}
    <g class="marker marker--${myTone}">
      <line x1="${n2(xMy)}" y1="${n2(padT - 6)}" x2="${n2(xMy)}" y2="${n2(boxY + boxH + 4)}"/>
      <polygon points="${n2(xMy)},${n2(padT + 2)} ${n2(xMy - 6)},${n2(padT - 8)} ${n2(xMy + 6)},${n2(padT - 8)}"/>
      <text x="${n2(Math.max(34, Math.min(W - 34, xMy)))}" y="${n2(padT - 12)}" text-anchor="middle">내 매물 ${formatShort(myPrice)}</text>
    </g>
  </g>
</svg>`;
}

/**
 * 허위매물 점검 점수 게이지. 반원 아크를 직접 그린다.
 * @param {HTMLElement} el
 * @param {number} score 0~100
 * @param {string} tone 'ok' | 'warn' | 'danger'
 */
function renderRiskGauge(el, score, tone) {
  if (!el) return;
  const W = 200; const H = 118;
  const cx = W / 2; const cy = 100; const r = 78;
  const toXY = (deg) => {
    const rad = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };
  // 180°(왼쪽)에서 360°(오른쪽)까지가 0~100점이다
  const [sx, sy] = toXY(180);
  const [ex, ey] = toXY(360);
  const endDeg = 180 + (Math.max(0, Math.min(100, score)) / 100) * 180;
  const [vx, vy] = toXY(endDeg);
  const largeArc = endDeg - 180 > 180 ? 1 : 0;

  el.innerHTML = `
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="허위매물 점검 점수 ${score}점">
  <path d="M ${n2(sx)} ${n2(sy)} A ${r} ${r} 0 0 1 ${n2(ex)} ${n2(ey)}" class="gauge-track"/>
  <path d="M ${n2(sx)} ${n2(sy)} A ${r} ${r} 0 ${largeArc} 1 ${n2(vx)} ${n2(vy)}" class="gauge-fill gauge-fill--${tone}"/>
  <text x="${cx}" y="${cy - 16}" text-anchor="middle" class="gauge-score">${score}</text>
  <text x="${cx}" y="${cy + 2}" text-anchor="middle" class="gauge-unit">/ 100점</text>
</svg>`;
}

/**
 * 주변 동네 중앙값 비교 막대.
 * @param {HTMLElement} el
 * @param {object[]} regions [{name, median, n}]
 * @param {string} myName 기준 지역 이름
 * @param {number} myMedian 기준 지역 중앙값
 */
function renderNeighborBars(el, regions, myName, myMedian) {
  if (!el) return;
  const rows = [{ name: myName, median: myMedian, isTarget: true }, ...regions.map((r) => ({ ...r, isTarget: false }))]
    .sort((a, b) => a.median - b.median);
  if (rows.length < 2) { el.innerHTML = '<p class="help">비교할 주변 지역 데이터를 불러오지 못했습니다.</p>'; return; }

  const max = Math.max(...rows.map((r) => r.median)) * 1.02;
  const rowH = 30;
  const W = 600; const labelW = 110; const H = rows.length * rowH + 8;

  const bars = rows.map((r, i) => {
    const y = i * rowH + 4;
    const w = Math.max(2, (r.median / max) * (W - labelW - 86));
    return `<g class="nbar ${r.isTarget ? 'is-target' : ''}">
      <text x="${labelW - 8}" y="${y + 16}" text-anchor="end" class="nbar__name">${esc(r.name)}</text>
      <rect x="${labelW}" y="${y + 4}" width="${n2(w)}" height="16" rx="4"/>
      <text x="${n2(labelW + w + 8)}" y="${y + 17}" class="nbar__val">${formatShort(r.median)}</text>
    </g>`;
  }).join('');

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="주변 지역 중앙값 비교">${bars}</svg>`;
}

// ===== 6. 렌더링 =====

/** 지역 입력 방식 패널 전환 */
function renderRegionMode() {
  const isText = appState.regionMode === 'text';
  document.getElementById('region-text-pane').classList.toggle('pane--active', isText);
  document.getElementById('region-select-pane').classList.toggle('pane--active', !isText);
  document.querySelectorAll('[data-region-mode]').forEach((b) => {
    const on = b.dataset.regionMode === appState.regionMode;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
  });
}

/** 계약 구분에 따라 월세 칸을 보이거나 숨긴다 */
function renderContractType() {
  const isMonthly = appState.input.contractType === '월세';
  document.getElementById('rent-field').hidden = !isMonthly;
  if (!isMonthly) {
    // 전세로 돌아가면 월세를 0으로 고정한다 (PRD 2.1)
    document.getElementById('monthly-rent').value = '';
    appState.input.monthlyRent = 0;
    document.getElementById('rent-readout').textContent = '월세를 입력해 주세요';
  }
  document.querySelectorAll('[data-contract]').forEach((b) => {
    const on = b.dataset.contract === appState.input.contractType;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-checked', String(on));
  });
  document.querySelector('label[for="deposit"]').innerHTML =
    `${isMonthly ? '월세 보증금' : '전세 보증금'} <span class="unit-tag">만원</span>`;
  renderConvReadout();
}

/** 주택 유형 토글 */
function renderHouseType() {
  document.querySelectorAll('[data-house]').forEach((b) => {
    const on = b.dataset.house === appState.input.houseType;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-checked', String(on));
  });
}

/** 전월세전환율을 바꿨을 때 환산보증금을 즉시 보여 준다 */
function renderConvReadout() {
  const el = document.getElementById('conv-readout');
  const { deposit, monthlyRent, contractType, conversionRate } = appState.input;
  if (!deposit) { el.textContent = '보증금을 입력하면 환산보증금을 보여드립니다'; return; }
  if (contractType === '전세') { el.textContent = `전세라서 환산보증금은 보증금과 같습니다 — ${formatManwon(deposit)}`; return; }
  const je = toJeonseEquivalent(deposit, monthlyRent, conversionRate);
  el.textContent = `환산보증금 ${formatManwon(je)} = 보증금 ${formatManwon(deposit)} + 월세 ${monthlyRent}만원 환산분`;
}

/** 시·도 / 시·군·구 드롭다운 채우기 */
function renderRegionSelects() {
  const sidoEl = document.getElementById('sido');
  const sigunguEl = document.getElementById('sigungu');
  const list = regionList();
  const sidos = [...new Set(list.map((r) => r.sido))];
  sidoEl.innerHTML = sidos.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  const fill = () => {
    const sub = list.filter((r) => r.sido === sidoEl.value);
    sigunguEl.innerHTML = '<option value="">선택하세요</option>'
      + sub.map((r) => `<option value="${r.code}">${esc(r.sigungu)}</option>`).join('');
  };
  fill();
  sidoEl.onchange = fill;
}

/** 지역 자동완성 */
function renderSuggestions(query) {
  const dl = document.getElementById('region-suggestions');
  const hits = searchRegion(query);
  dl.innerHTML = hits.map((h) => `<option value="${esc(h.sido)} ${esc(h.sigungu)}">${esc(h.matched)} · ${esc(h.sigungu)}</option>`).join('');
  const picked = document.getElementById('region-picked');
  picked.textContent = hits.length ? `인식: ${hits[0].sido} ${hits[0].sigungu}` : (query.trim().length >= 2 ? '해당 지역을 찾지 못했습니다' : '—');
}

/** 오류 메시지 표시/숨김 */
function setError(id, message) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!message) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = message;
}

/** 안내 배지(표본 확장, Mock 등) */
function renderNotices(result) {
  const box = document.getElementById('notice-row');
  const items = [];
  if (result.meta.isMock) {
    items.push({ tone: 'warn', text: '샘플(Mock) 데이터로 분석한 결과입니다. 실제 실거래가 아닙니다.' });
    if (result.meta.isEmbedded) {
      items.push({ tone: 'info', text: '파일을 직접 열어 data 폴더를 읽을 수 없어, 코드에 내장된 샘플로 분석했습니다. 서버로 실행하면 실제 실거래를 조회합니다.' });
    }
    if (result.meta.mockReason) {
      items.push({ tone: 'info', text: `실거래 조회를 쓰지 못한 이유: ${result.meta.mockReason}` });
    }
  }
  // '시세보다 싸서 안심'인데 허위매물 신호가 뜨면 사용자가 오해할 수 있다.
  // 싼 것 자체가 미끼 매물의 전형이므로 두 결과를 함께 읽도록 안내한다.
  if (result.grade.key === 'safe' && result.risk.grade !== '정상 범위') {
    items.push({
      tone: 'warn',
      text: `시세보다 ${Math.abs(result.gapPct)}% 저렴해 가격 등급은 '안심'이지만, 아래 허위매물 점검에서 확인이 필요한 신호가 나왔습니다. 두 결과를 함께 보세요.`,
    });
  }
  for (const s of result.selection.steps) items.push({ tone: 'info', text: s });
  if (result.outliersRemoved > 0) {
    items.push({ tone: 'info', text: `지나치게 튀는 거래 ${result.outliersRemoved}건을 통계에서 제외했습니다 (가족 간 거래·신고 오류 등).` });
  }
  if (result.stats.n > 0 && result.stats.n < MIN_COMPARABLES) {
    items.push({ tone: 'warn', text: `비교 거래가 ${result.stats.n}건뿐이라 판정 신뢰도가 낮습니다.` });
  }
  if (result.risk.cap !== null) {
    items.push({ tone: 'info', text: `표본이 적어 허위매물 점수 상한을 ${result.risk.cap}점으로 제한했습니다.` });
  }
  box.innerHTML = items.map((i) => `<div class="notice notice--${i.tone}">${esc(i.text)}</div>`).join('');
}

/** 통계 요약 타일 */
function renderStatGrid(stats) {
  const el = document.getElementById('stat-grid');
  const cells = [
    ['최저가', stats.min], ['하위 25%', stats.q1], ['중앙값', stats.median],
    ['평균가', stats.mean], ['상위 25%', stats.q3], ['최고가', stats.max],
  ];
  el.innerHTML = cells.map(([k, v], i) =>
    `<div class="stat ${i === 2 ? 'stat--hl' : ''}"><span class="stat__k">${k}</span><b class="stat__v">${formatManwon(v)}</b></div>`).join('');
}

/** 비교 근거 테이블 (PRD 2.2) */
function renderTable(result) {
  const tbody = document.querySelector('#comp-table tbody');
  const rows = result.comparables.slice(0, appState.tableShown);
  tbody.innerHTML = rows.map((r) => `<tr>
    <td>${esc(r.dealDate)}</td>
    <td class="cell-name">${esc(r.mhouseNm || '—')}</td>
    <td>${esc(r.houseType || '—')}</td>
    <td>${r.floor || '—'}</td>
    <td>${r.excluUseAr}㎡<span class="cell-sub">${m2ToPyeong(r.excluUseAr)}평</span></td>
    <td>${r.deposit.toLocaleString('ko-KR')}</td>
    <td>${r.monthlyRent ? r.monthlyRent.toLocaleString('ko-KR') : '—'}</td>
    <td class="cell-strong">${r.jeonseEquivalent.toLocaleString('ko-KR')}</td>
    <td>${r.buildYear || '—'}</td>
  </tr>`).join('');
  document.getElementById('table-count').textContent = `${result.comparables.length}건`;
  const more = document.getElementById('table-more');
  more.hidden = result.comparables.length <= appState.tableShown;
  more.textContent = `더 보기 (${result.comparables.length - appState.tableShown}건 남음)`;
}

/** 허위매물 신호 카드 */
function renderSignals(risk) {
  renderRiskGauge(document.getElementById('risk-gauge'), risk.score, risk.tone);
  document.getElementById('risk-grade').textContent = risk.grade;
  document.getElementById('risk-grade').className = `risk-row__grade is-${risk.tone}`;
  document.getElementById('risk-msg').textContent = risk.message;

  const positive = risk.signals.filter((s) => s.points > 0);
  document.getElementById('signal-count').textContent = `${positive.length}개`;

  const list = document.getElementById('signal-list');
  if (risk.signals.length === 0) {
    list.innerHTML = '<div class="signal signal--empty">가격만으로 의심할 신호는 발견되지 않았습니다. 그래도 현장 확인과 등기부등본 조회는 꼭 하세요.</div>';
  } else {
    list.innerHTML = risk.signals.map((s) => {
      const tone = s.points < 0 ? 'ok' : s.points >= 15 ? 'danger' : 'warn';
      return `<div class="signal signal--${tone}">
        <div class="signal__head">
          <span class="signal__name">${esc(s.name)}</span>
          <span class="signal__pts">${s.points > 0 ? '+' : ''}${s.points}점</span>
        </div>
        <p class="signal__why">${esc(s.why)}</p>
        <div class="signal__nums"><span>실제: ${esc(s.actual)}</span><span>기준: ${esc(s.threshold)}</span></div>
      </div>`;
    }).join('');
  }

  const box = document.getElementById('not-evaluated-box');
  if (risk.notEvaluated.length) {
    box.hidden = false;
    document.getElementById('not-evaluated-count').textContent = `${risk.notEvaluated.length}개`;
    document.getElementById('not-evaluated-list').innerHTML =
      risk.notEvaluated.map((t) => `<li>${esc(t)}</li>`).join('');
  } else {
    box.hidden = true;
  }
}

/** 계약 전 확인 질문 체크리스트 */
function renderQuestions(questions) {
  const el = document.getElementById('questions-list');
  el.innerHTML = questions.map((q, i) =>
    `<li><label><input type="checkbox" data-q="${i}" /><span>${esc(q)}</span></label></li>`).join('');
  // 체크 상태를 세션 동안 유지한다 (새로고침 전까지)
  el.querySelectorAll('input').forEach((input) => {
    const key = `q:${input.dataset.q}`;
    try { input.checked = sessionStorage.getItem(key) === '1'; } catch { /* 비공개 모드 등 */ }
    input.addEventListener('change', () => {
      try { sessionStorage.setItem(key, input.checked ? '1' : '0'); } catch { /* 무시 */ }
    });
  });
}

/** AI 설명(또는 템플릿 폴백) 표시 */
function renderAiReport(report) {
  document.getElementById('ai-source').textContent = report.source === 'ai' ? 'AI 생성' : '자동 생성';
  document.getElementById('ai-headline').textContent = report.headline || '';
  document.getElementById('ai-summary').textContent = report.summary || '';
  document.getElementById('ai-budgetfit').textContent =
    [report.neighborhoodComparison, report.budgetFit].filter(Boolean).join(' ');
  document.getElementById('ai-cautions').innerHTML =
    (report.cautions || []).map((c) => `<li>${esc(c)}</li>`).join('');
  document.getElementById('ai-glossary').innerHTML =
    (report.glossary || []).map((g) => `<dt>${esc(g.term)}</dt><dd>${esc(g.plain)}</dd>`).join('');
}

/**
 * api/parse-query.js 가 돌려준 해석 결과를 입력 폼에 채운다.
 * AI 결과를 그대로 확정하지 않고 '폼에 채워 주기'까지만 한다. 사용자가 보고 고칠 수 있어야 한다.
 *
 * @param {object} parsed ParsedQuery
 * @returns {string} 사용자에게 보여 줄 결과 설명
 */
function applyParsedQuery(parsed) {
  const filled = [];

  // 지역: AI의 지리 지식은 틀릴 수 있다(실제로 '숭실대'를 동대문구라고 답한 사례가 있다).
  // 랜드마크·동 이름을 우리 표로 먼저 조회하고, 거기서 못 찾을 때만 AI가 준 시군구를 쓴다.
  const candidates = [parsed.region?.keyword, parsed.region?.dong, parsed.region?.sigungu].filter(Boolean);
  let hits = [];
  for (const c of candidates) {
    hits = searchRegion(c);
    if (hits.length) break;
  }
  {
    if (hits.length) {
      document.getElementById('region-text').value = `${hits[0].sido} ${hits[0].sigungu}`;
      renderSuggestions(`${hits[0].sido} ${hits[0].sigungu}`);
      filled.push(`지역 ${hits[0].sigungu}`);
      // 동 이름이 함께 잡혔으면 동 칸에도 넣는다
      if (parsed.region?.dong) {
        document.getElementById('dong').value = parsed.region.dong;
        filled.push(`동 ${parsed.region.dong}`);
      }
    }
  }

  // 계약 구분
  if (parsed.budget?.contractType) {
    appState.input.contractType = parsed.budget.contractType;
    renderContractType();
    filled.push(parsed.budget.contractType);
  }
  // 보증금
  if (parsed.budget?.deposit) {
    const el = document.getElementById('deposit');
    el.value = parsed.budget.deposit;
    el.dispatchEvent(new Event('input'));
    filled.push(`보증금 ${formatManwon(parsed.budget.deposit)}`);
  }
  // 월세
  if (parsed.budget?.monthlyRent) {
    const el = document.getElementById('monthly-rent');
    el.value = parsed.budget.monthlyRent;
    el.dispatchEvent(new Event('input'));
    filled.push(`월세 ${parsed.budget.monthlyRent}만원`);
  }
  // 면적 (문장에 ㎡가 있으면 AI가 areaMinM2/areaMaxM2로 준다)
  const area = parsed.filters?.areaMinM2 || parsed.filters?.areaMaxM2;
  if (area) {
    const el = document.getElementById('area');
    el.value = area;
    el.dispatchEvent(new Event('input'));
    filled.push(`면적 ${area}㎡`);
  }
  // 주택 유형: 이 앱은 연립다세대 자료를 쓰므로 연립/다세대만 반영한다
  const types = parsed.filters?.buildingTypes || [];
  if (types.includes('연립다세대')) {
    appState.input.houseType = '전체';
    renderHouseType();
  }

  return filled.length
    ? `${parsed.source === 'ai' ? 'AI가' : '간단 규칙으로'} 채웠습니다 — ${filled.join(' · ')}. 틀린 값은 직접 고쳐 주세요.`
    : '문장에서 조건을 찾지 못했습니다. 아래 칸에 직접 입력해 주세요.';
}

/**
 * api/appraise.js 로 판정 결과 설명과 확인 질문을 받아 채운다.
 * 점수·등급은 이미 규칙 엔진이 정했고, AI는 설명만 한다. 실패하면 기본 질문 목록을 쓴다.
 *
 * @param {object} result analyze() 결과
 */
async function loadAppraisal(result) {
  const payload = {
    fairPrice: {
      jeonseEquivalentRange: [result.stats.q1, result.stats.q3],
      listingPercentile: result.risk.percentile,
      grade: result.grade.name,
      gapPct: result.gapPct,
      median: result.stats.median,
      myPrice: result.myPrice,
    },
    risk: {
      score: result.risk.score,
      grade: result.risk.grade,
      triggeredSignals: result.risk.signals.map((x) => ({
        id: x.id, name: x.name, points: x.points, actual: x.actual, threshold: x.threshold, reason: x.why,
      })),
      notEvaluated: result.risk.notEvaluated,
    },
    reliability: { n: result.stats.n, grade: result.stats.n >= 30 ? '높음' : result.stats.n >= 10 ? '보통' : '낮음' },
    formatted: {
      median: formatManwon(result.stats.median),
      q1: formatManwon(result.stats.q1),
      q3: formatManwon(result.stats.q3),
      myPrice: formatManwon(result.myPrice),
      gap: `${Math.abs(result.gapPct)}%`,
    },
  };

  try {
    const out = await callApi('/api/appraise', payload, 40000);
    const vEl = document.getElementById('appraise-verdict');
    vEl.hidden = false;
    vEl.textContent = out.verdict_plain;
    if (Array.isArray(out.questions_to_ask) && out.questions_to_ask.length) {
      renderQuestions(out.questions_to_ask);
      document.getElementById('questions-source').textContent = out.source === 'ai' ? 'AI 생성' : '자동 생성';
    }
  } catch {
    // 서버가 없을 때도 기본 질문은 보여 준다 (renderResult에서 이미 채워 둔 목록 유지)
    document.getElementById('questions-source').textContent = '기본 목록';
  }
}

/** 분석 결과 전체 그리기 */
function renderResult(result) {
  appState.result = result;
  document.getElementById('intro').hidden = true;
  document.getElementById('result').hidden = false;

  renderNotices(result);

  // ① 판정 요약 카드
  const g = result.grade;
  const badge = document.getElementById('grade-badge');
  badge.textContent = `${g.emoji} ${g.name}`;
  badge.className = `grade-badge grade-badge--lg grade-badge--${g.tone}`;
  document.getElementById('judge-card').className = `card judge is-${g.tone}`;
  document.getElementById('judge-n').textContent = `비교 거래 ${result.stats.n}건`;

  const gap = result.gapPct;
  document.getElementById('gap-text').textContent = gap === 0
    ? '주변 중앙값과 같은 수준입니다'
    : `주변 시세보다 ${Math.abs(gap)}% ${gap > 0 ? '높습니다' : '낮습니다'}`;
  document.getElementById('my-price').textContent = formatManwon(result.myPrice);
  document.getElementById('median-price').textContent = formatManwon(result.stats.median);
  // 25% 넘게 싸면 '저렴해서 좋다'로 읽히지 않도록 코멘트를 바꾼다
  document.getElementById('grade-comment').textContent =
    (g.key === 'safe' && gap <= -25)
      ? '주변 시세보다 크게 낮습니다. 좋은 조건일 수도 있지만, 매물이 실제로 존재하는지와 조건이 설명과 같은지 먼저 확인해 보세요.'
      : g.comment;

  // ② 분포 차트
  renderDistribution(document.getElementById('dist-chart'), result);
  renderStatGrid(result.stats);

  // ④ 허위매물 신호
  renderSignals(result.risk);

  // ⑥ 비교 테이블
  appState.tableShown = 10;
  renderTable(result);

  // ⑦ 확인 질문
  renderQuestions([
    '이 매물 지금도 계약 가능한 상태인가요? 지번 주소를 알려주실 수 있나요?',
    '관리비에 어떤 항목이 포함되나요? 따로 내는 비용이 또 있나요?',
    '집주인이 등기부등본상 소유자와 같은 분인가요?',
    '근저당이 설정되어 있나요? 보증금보다 큰 금액인가요?',
    '전세보증금 반환보증(HUG·SGI) 가입이 가능한 집인가요?',
    '등기부등본과 건축물대장을 미리 확인했나요?',
  ]);

  // ⑧ 출처
  const m = result.meta;
  document.getElementById('result-meta').textContent =
    `${result.input.sido} ${result.input.sigungu}${result.input.dong ? ` ${result.input.dong}` : ''} · `
    + `최근 ${m.months || 12}개월 · 수집 ${m.totalCount}건 중 조건에 맞는 ${result.stats.n}건으로 분석 · `
    + `전월세전환율 ${result.input.conversionRate}% 적용`
    + (m.isMock ? ' · 샘플 데이터' : '');

  // 동 자동완성 채우기
  document.getElementById('dong-suggestions').innerHTML =
    result.dongs.map((d) => `<option value="${esc(d)}"></option>`).join('');

  document.getElementById('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 주변 동네 비교 그리기 */
function renderNeighborhood(result) {
  const card = document.getElementById('neighbor-card');
  const nb = result.neighborhood;
  if (!nb || nb.regions.length === 0) { card.hidden = true; return; }
  card.hidden = false;
  renderNeighborBars(document.getElementById('neighbor-chart'), nb.regions,
    result.input.sigungu, result.stats.median);
  document.getElementById('neighbor-note').textContent = nb.relativeLabel
    ? `주변 ${nb.regions.length}개 지역과 비교하면 ${result.input.sigungu}는 ${nb.relativeLabel} 편입니다.`
    : '';
  document.getElementById('alt-list').innerHTML = nb.alternatives.map((a) => `
    <div class="alt-item">
      <div class="alt-item__name">${esc(a.region)}</div>
      <div class="alt-item__price">중앙값 ${formatManwon(a.median)} · ${a.n}건</div>
      <div class="alt-item__save">약 ${a.savingsPct}% 저렴</div>
    </div>`).join('');
}

// ===== 7. 이벤트 바인딩 =====

/**
 * 입력값을 appState에 모으고 검증한다.
 * @returns {boolean} 필수 입력이 올바르면 true
 */
function collectAndValidate() {
  let ok = true;
  setError('region-error', '');
  setError('budget-error', '');
  const inp = appState.input;

  // 시군구 코드 직접 입력이 있으면 그것을 최우선으로 쓴다 (코드 표가 낡았을 때의 보정 수단)
  const manual = document.getElementById('manual-code').value.trim();
  if (/^\d{5}$/.test(manual)) {
    const r = regionList().find((x) => x.code === manual);
    inp.sigunguCode = manual;
    inp.sido = r ? r.sido : '';
    inp.sigungu = r ? r.sigungu : `코드 ${manual}`;
  } else if (appState.regionMode === 'text') {
    const hits = searchRegion(document.getElementById('region-text').value);
    if (!hits.length) {
      setError('region-error', '해당 지역을 찾을 수 없습니다. "직접 선택"으로 시·군·구를 골라 주세요.');
      ok = false;
    } else {
      inp.sido = hits[0].sido; inp.sigungu = hits[0].sigungu; inp.sigunguCode = hits[0].code;
    }
  } else {
    const code = document.getElementById('sigungu').value;
    if (!code) { setError('region-error', '시·군·구를 선택해 주세요.'); ok = false; }
    else {
      const r = regionList().find((x) => x.code === code);
      inp.sido = r.sido; inp.sigungu = r.sigungu; inp.sigunguCode = r.code;
    }
  }

  inp.dong = document.getElementById('dong').value.trim();

  const deposit = Number(document.getElementById('deposit').value);
  if (!deposit || deposit <= 0) { setError('budget-error', '보증금을 입력해 주세요.'); ok = false; }
  else inp.deposit = deposit;

  if (inp.contractType === '월세') {
    const rent = Number(document.getElementById('monthly-rent').value);
    if (!rent || rent <= 0) { setError('budget-error', '월세를 입력해 주세요.'); ok = false; }
    else inp.monthlyRent = rent;
  } else {
    inp.monthlyRent = 0;
  }

  const area = Number(document.getElementById('area').value);
  inp.areaM2 = area > 0 ? area : null;
  const by = Number(document.getElementById('buildyear').value);
  inp.buildYear = by >= 1950 && by <= 2030 ? by : null;
  const rate = Number(document.getElementById('conv-rate').value);
  inp.conversionRate = rate > 0 ? rate : 5.5;

  // 선택 입력(허위매물 점검용)
  const feeEl = document.getElementById('maintenance-fee');
  inp.maintenanceFee = feeEl && feeEl.value !== '' ? Number(feeEl.value) : null;
  const addrEl = document.getElementById('address-disclosure');
  inp.addressDisclosure = addrEl ? addrEl.value : '';
  const postEl = document.getElementById('posting-age');
  inp.postingAge = postEl ? postEl.value : '';
  const agentEl = document.getElementById('agent-number');
  inp.agentNumber = agentEl ? agentEl.value.trim() : '';

  return ok;
}

/**
 * 분석을 실행한다. 실거래 수집 → 판정 → 화면 → (비동기) 주변비교·AI 설명.
 * @param {boolean} [forceMock=false] 샘플 데이터로 바로 보기
 */
async function runAnalysis(forceMock = false) {
  // 어떤 단계에서 예외가 나도 로딩 오버레이는 반드시 닫고, 무엇이 문제인지 보여 준다.
  try {
    await runAnalysisInner(forceMock);
  } catch (err) {
    console.error('[분석 실패]', err);
    showAnalysisError(err);
  } finally {
    hideLoading();
  }
}

/**
 * 분석 실패를 화면에 보여 준다. 콘솔을 열지 않아도 원인을 알 수 있어야 한다.
 * @param {Error} err
 */
function showAnalysisError(err) {
  const box = document.getElementById('notice-row');
  const msg = (err && err.message) ? err.message : '알 수 없는 오류가 발생했습니다';
  if (box) {
    document.getElementById('intro').hidden = true;
    document.getElementById('result').hidden = false;
    box.innerHTML = `<div class="notice notice--warn">분석을 끝내지 못했습니다 — ${esc(msg)}</div>`
      + '<div class="notice notice--info">브라우저 개발자도구(F12) 콘솔에 자세한 내용이 찍혀 있습니다. '
      + '"샘플 데이터로 먼저 보기"로는 서버 없이도 확인할 수 있습니다.</div>';
  }
  setError('region-error', msg);
  showToast('분석에 실패했습니다');
}

/** 실제 분석 절차 (예외는 runAnalysis가 처리한다) */
async function runAnalysisInner(forceMock = false) {
  await loadRefData();

  if (forceMock) {
    // 샘플 보기는 동작구 상도동 조건으로 폼을 채워 준다
    document.getElementById('region-text').value = '상도동';
    document.getElementById('deposit').value = document.getElementById('deposit').value || '15000';
    document.getElementById('area').value = document.getElementById('area').value || '33';
    renderSuggestions('상도동');
  }
  if (!collectAndValidate()) { showToast('입력을 확인해 주세요'); return; }

  const inp = appState.input;
  let raw = null;
  let mockReason = '';

  showLoading('실거래가를 불러오는 중…',
    `${inp.sigungu}(${inp.sigunguCode}) · 최근 12개월 · 최대 45초`, 20);

  if (!forceMock) {
    try {
      // 실측 0.9초면 끝나는 요청이다. 25초가 넘으면 환경 문제이므로 끊고 샘플로 넘어간다.
      raw = await callApi('/api/transactions', {
        sigunguCode: inp.sigunguCode, months: 12, buildingTypes: ['연립다세대'],
      }, 25000);
      showLoading('통계를 계산하는 중…', `실거래 ${raw.records.length}건 수집 완료`, 60);
    } catch (err) {
      console.warn('[실거래 수집 실패 → 샘플 데이터로 대체]', err);
      mockReason = err.message;
      showLoading('샘플 데이터를 준비하는 중…', err.message, 50);
    }
  }

  // API 오류·키 문제·0건이면 Mock 데이터로 폴백한다 (3단계 2.1)
  if (!raw || raw.records.length === 0) {
    const mock = mockResult();
    if (!mock) {
      hideLoading();
      setError('region-error', mockReason || '실거래 데이터를 불러오지 못했습니다.');
      showToast('데이터를 불러오지 못했습니다');
      return;
    }
    raw = mock;
    raw.meta.mockReason = mockReason || '';
    if (mockReason) showToast('샘플 데이터로 보여 드립니다');
  }

  appState.raw = raw;
  const result = analyze(raw, inp);

  if (result.stats.n === 0) {
    hideLoading();
    setError('region-error',
      '선택한 조건에 해당하는 실거래 내역이 없습니다. 면적이나 지역·주택유형을 넓혀 다시 조회해 보세요.');
    showToast('조건에 맞는 거래가 없습니다');
    return;
  }

  hideLoading();
  renderResult(result);

  // 여기서부터는 결과를 이미 보여 준 뒤 비동기로 채운다 (먼저 보여 주고 나중에 보강)
  loadAiReport(result);
  loadAppraisal(result);
  loadNeighborhood(result);
}

/** AI 설명을 비동기로 받아 채운다. 실패해도 템플릿이 들어간다. */
async function loadAiReport(result) {
  // AI에는 계산이 끝난 숫자만 넘긴다 (원시 레코드를 보내지 않는다)
  const payload = {
    region: { sido: result.input.sido, sigungu: result.input.sigungu, dong: result.input.dong || null },
    stats: result.stats,
    conversion: { rate: result.input.conversionRate, source: 'user_input' },
    budget: {
      contractType: result.input.contractType, deposit: result.input.deposit,
      monthlyRent: result.input.monthlyRent, jeonseEquivalent: result.myPrice,
      percentile: result.risk.percentile,
    },
    judgement: { gapPct: result.gapPct, grade: result.grade.name },
    // AI가 금액 서식을 직접 만들다 숫자를 틀리는 일이 있어, 완성된 문자열을 주고 복사만 하게 한다
    formatted: {
      median: formatManwon(result.stats.median),
      q1: formatManwon(result.stats.q1),
      q3: formatManwon(result.stats.q3),
      mean: formatManwon(result.stats.mean),
      min: formatManwon(result.stats.min),
      max: formatManwon(result.stats.max),
      myPrice: formatManwon(result.myPrice),
      gap: `${Math.abs(result.gapPct)}%`,
    },
    confidence: { grade: result.stats.n >= 30 ? '높음' : result.stats.n >= 10 ? '보통' : '낮음' },
    trend: { reliable: false },
  };
  try {
    const report = await callApi('/api/interpret', payload, 40000);
    renderAiReport(report);
  } catch {
    // 서버가 없을 때도 설명은 보여 준다 (완전히 클라이언트에서 만든 문장)
    renderAiReport({
      source: 'template',
      headline: `${result.input.sigungu} 비교 거래 ${result.stats.n}건 기준 중앙값은 ${formatManwon(result.stats.median)}입니다`,
      summary: `비슷한 조건의 거래는 보통 ${formatManwon(result.stats.q1)}에서 ${formatManwon(result.stats.q3)} 사이에서 이뤄졌습니다. `
        + `가장 낮은 거래는 ${formatManwon(result.stats.min)}, 가장 높은 거래는 ${formatManwon(result.stats.max)}였습니다.`,
      budgetFit: `입력하신 매물의 환산보증금 ${formatManwon(result.myPrice)}은 중앙값보다 ${Math.abs(result.gapPct)}% `
        + `${result.gapPct > 0 ? '높아' : '낮아'} '${result.grade.name}' 등급입니다.`,
      cautions: result.stats.n < 10 ? ['비교 거래가 10건 미만이라 참고용으로만 보시는 것이 좋습니다.'] : [],
      glossary: [
        { term: '환산보증금', plain: '월세를 전세로 바꿔 계산한 금액입니다. 전세 매물과 월세 매물을 같은 기준으로 비교할 수 있습니다.' },
        { term: '중앙값', plain: '거래를 금액순으로 줄 세웠을 때 가운데 있는 값입니다. 비싼 집 몇 채에 휘둘리지 않아 평균보다 체감 시세에 가깝습니다.' },
        { term: '전용면적', plain: '현관문 안쪽, 실제로 쓰는 공간의 면적입니다. 복도나 계단은 빠집니다.' },
      ],
    });
  }
}

/** 주변 지역 비교를 비동기로 받아 채운다. */
async function loadNeighborhood(result) {
  const adj = (refData.adjacency || {})[result.input.sigunguCode];
  if (!adj || !adj.length || result.meta.isMock) return;
  try {
    const data = await callApi('/api/analyze', {
      sigunguCodes: adj.slice(0, 5), months: 6, buildingTypes: ['연립다세대'],
    }, 60000);
    attachNeighborhood(result, data.byCode);
    renderNeighborhood(result);
  } catch { /* 주변 비교는 부가 기능이라 실패해도 넘어간다 */ }
}

/** 모든 이벤트를 연결한다. */
function bindEvents() {
  document.querySelectorAll('[data-region-mode]').forEach((b) => {
    b.addEventListener('click', () => { appState.regionMode = b.dataset.regionMode; renderRegionMode(); });
  });
  document.getElementById('region-text').addEventListener('input', (e) => {
    renderSuggestions(e.target.value); setError('region-error', '');
  });
  document.querySelectorAll('[data-house]').forEach((b) => {
    b.addEventListener('click', () => { appState.input.houseType = b.dataset.house; renderHouseType(); });
  });
  document.querySelectorAll('[data-contract]').forEach((b) => {
    b.addEventListener('click', () => { appState.input.contractType = b.dataset.contract; renderContractType(); });
  });

  document.getElementById('deposit').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    appState.input.deposit = v > 0 ? v : null;
    document.getElementById('deposit-readout').textContent = v > 0 ? formatManwon(v) : '금액을 입력해 주세요';
    setError('budget-error', ''); renderConvReadout();
  });
  document.getElementById('monthly-rent').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    appState.input.monthlyRent = v > 0 ? v : 0;
    document.getElementById('rent-readout').textContent =
      v > 0 ? `${formatManwon(v)} / 월 · 1년 ${formatManwon(v * 12)}` : '월세를 입력해 주세요';
    setError('budget-error', ''); renderConvReadout();
  });
  document.getElementById('area').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    const out = document.getElementById('area-readout');
    out.textContent = v > 0
      ? `약 ${m2ToPyeong(v)}평 · 비교 범위 ${(v * 0.85).toFixed(1)}~${(v * 1.15).toFixed(1)}㎡ (±15%)`
      : '입력하면 평수를 함께 보여드립니다';
  });
  document.getElementById('conv-rate').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    appState.input.conversionRate = v > 0 ? v : 5.5;
    renderConvReadout();
  });

  document.getElementById('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runAnalysis(false);
  });
  document.getElementById('demo-btn').addEventListener('click', () => runAnalysis(true));

  // 로딩이 길어질 때 빠져나가는 버튼. 기다리던 요청은 버리고 샘플 데이터로 결과를 보여 준다.
  document.getElementById('loading-escape').addEventListener('click', () => {
    hideLoading();
    showToast('샘플 데이터로 보여 드립니다');
    runAnalysis(true);
  });

  // 문장으로 한 번에 입력 (api/parse-query.js → OpenRouter)
  document.getElementById('ai-parse-btn').addEventListener('click', async () => {
    const text = document.getElementById('ai-parse-text').value.trim();
    const out = document.getElementById('ai-parse-result');
    if (text.length < 4) { out.textContent = '조건을 문장으로 적어 주세요.'; return; }
    const btn = document.getElementById('ai-parse-btn');
    btn.disabled = true; btn.textContent = '읽는 중…';
    out.textContent = 'AI가 문장을 읽고 있습니다…';
    try {
      await loadRefData();
      const parsed = await callApi('/api/parse-query', { text }, 40000);
      out.textContent = applyParsedQuery(parsed);
      showToast('입력칸을 채웠습니다');
    } catch (err) {
      out.textContent = `문장을 해석하지 못했습니다 (${err.message}) 아래 칸에 직접 입력해 주세요.`;
    } finally {
      btn.disabled = false; btn.textContent = '문장에서 자동으로 채우기';
    }
  });
  document.getElementById('table-more').addEventListener('click', () => {
    appState.tableShown += 20;
    renderTable(appState.result);
  });

  // 용어 설명 버튼
  document.addEventListener('click', (e) => {
    const tip = e.target.closest('.tip-btn');
    if (tip) { e.preventDefault(); showToast(tip.dataset.tip); }
  });

  // 테마 전환 (기기 설정 → 라이트 → 다크 순환)
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : cur === 'light' ? null : 'dark';
    if (next) document.documentElement.setAttribute('data-theme', next);
    else document.documentElement.removeAttribute('data-theme');
    showToast(next === 'dark' ? '다크 모드' : next === 'light' ? '라이트 모드' : '기기 설정 따름');
  });

  // 창 크기가 바뀌면 SVG를 다시 그린다 (viewBox 기반이라 비율은 유지되지만 가독성을 위해 재계산)
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!appState.result) return;
      renderDistribution(document.getElementById('dist-chart'), appState.result);
      renderRiskGauge(document.getElementById('risk-gauge'), appState.result.risk.score, appState.result.risk.tone);
    }, 180);
  });
}

/** 화면 초기화 */
async function init() {
  // 어느 버전이 돌고 있는지 바로 확인할 수 있게 남긴다
  console.log(`[방값판독기] 빌드 ${BUILD}`);
  const stamp = document.getElementById('build-stamp');
  if (stamp) stamp.textContent = `빌드 ${BUILD}`;
  renderRegionMode();
  renderContractType();
  renderHouseType();
  bindEvents();
  await loadRefData();
  renderRegionSelects(); // 지역 목록을 받은 뒤 다시 채운다
}

document.addEventListener('DOMContentLoaded', init);

// ===== 8. 자체 점검 =====

/**
 * 브라우저 콘솔에서 __selfTest()를 실행해 계산 로직이 맞는지 확인한다.
 * 테스트 도구를 쓰지 않으므로(빌드 금지) 이 함수가 단위 테스트 역할을 한다.
 * @returns {boolean} 전부 통과하면 true
 */
function __selfTest() {
  const cases = [];
  const eq = (name, got, want) => cases.push([name, got, want]);

  // 금액·면적 변환
  eq('formatManwon(0)', formatManwon(0), '0원');
  eq('formatManwon(500)', formatManwon(500), '500만원');
  eq('formatManwon(10000)', formatManwon(10000), '1억원');
  eq('formatManwon(12000)', formatManwon(12000), '1억 2,000만원');
  eq('formatManwon(123456)', formatManwon(123456), '12억 3,456만원');
  eq('pyeongToM2(10)', pyeongToM2(10), 33.06);
  eq('m2ToPyeong(33.06)', m2ToPyeong(33.06), 10);

  // 환산보증금 (PRD 3.2) — 전세는 보증금 그대로
  eq('환산보증금(전세 20000)', toJeonseEquivalent(20000, 0, 5.5), 20000);
  // 보증금 1000 + 월세 55, 전환율 5.5% → 1000 + 660/0.055 = 13000
  eq('환산보증금(1000/55 @5.5%)', toJeonseEquivalent(1000, 55, 5.5), 13000);
  // 전환율이 높을수록 환산보증금은 작아진다
  eq('환산보증금(1000/55 @11%)', toJeonseEquivalent(1000, 55, 11), 7000);

  // 통계 (PRD 3.3)
  const d = describe([100, 200, 300, 400, 500]);
  eq('describe.n', d.n, 5);
  eq('describe.min', d.min, 100);
  eq('describe.median', d.median, 300);
  eq('describe.mean', d.mean, 300);
  eq('describe.q1', d.q1, 200);
  eq('describe.q3', d.q3, 400);
  eq('describe.max', d.max, 500);
  eq('percentile 보간', Math.round(percentile([0, 10], 25)), 3);

  // 괴리율 (PRD 3.3)
  eq('괴리율(+20%)', gapRate(12000, 10000), 20);
  eq('괴리율(-10%)', gapRate(9000, 10000), -10);
  eq('괴리율(중앙값 0)', gapRate(9000, 0), 0);

  // 판정 등급 경계값 (PRD 3.3)
  eq('등급 -6% → 안심', gradeOf(-6).name, '안심');
  eq('등급 -5% → 적정', gradeOf(-5).name, '적정');
  eq('등급 0% → 적정', gradeOf(0).name, '적정');
  eq('등급 10% → 주의', gradeOf(10).name, '주의');
  eq('등급 15% → 주의', gradeOf(15).name, '주의');
  eq('등급 20% → 위험', gradeOf(20).name, '위험');
  eq('등급 25% → 위험', gradeOf(25).name, '위험');

  // 유사 면적 ±15% 추출 (PRD 3.1)
  const recs = [10, 20, 28, 30, 31, 32, 33, 34, 35, 36, 50].map((a, i) => ({
    excluUseAr: a, umdNm: '상도동', houseType: '다세대', deposit: 10000 + i * 100, monthlyRent: 0,
  }));
  const sel = selectComparables(recs, { dong: '', houseType: '전체', areaM2: 33 });
  const inRange = sel.list.every((r) => r.excluUseAr >= 33 * 0.85 && r.excluUseAr <= 33 * 1.15);
  eq('±15% 범위만 추출', inRange, true);
  eq('±15% 건수', sel.list.length, 7); // 30,31,32,33,34,35,36 (28.05~37.95)

  // 표본이 5건 미만이면 ±25%로 넓힌다 (3단계 2.1)
  const few = [20, 24, 25, 40].map((a) => ({ excluUseAr: a, umdNm: '상도동', houseType: '다세대' }));
  const sel2 = selectComparables(few, { dong: '', houseType: '전체', areaM2: 20 });
  eq('표본 부족 시 확장 플래그', sel2.expanded, true);

  // 이상치 제거
  const withOutlier = Array.from({ length: 30 }, (_, i) => ({ v: 10000 + i * 100 }));
  withOutlier.push({ v: 500000 }); // 튀는 값 1건
  const tr = trimOutliers(withOutlier, (o) => o.v);
  eq('IQR: 튀는 값 제거', tr.removed.length, 1);
  eq('IQR: 표본 20건 미만은 그대로', trimOutliers([{ v: 1 }, { v: 999999 }], (o) => o.v).removed.length, 0);

  // 동 이름 정규화 (상도동 ↔ 상도1동)
  const dongRecs = [
    { umdNm: '상도동', excluUseAr: 33, houseType: '다세대' },
    { umdNm: '상도1동', excluUseAr: 33, houseType: '다세대' },
    { umdNm: '사당동', excluUseAr: 33, houseType: '다세대' },
    { umdNm: '상도동', excluUseAr: 32, houseType: '다세대' },
    { umdNm: '상도1동', excluUseAr: 34, houseType: '다세대' },
    { umdNm: '상도동', excluUseAr: 31, houseType: '다세대' },
  ];
  eq('상도동 검색에 상도1동 포함', selectComparables(dongRecs, { dong: '상도동', houseType: '전체', areaM2: 33 }).list.length, 5);

  // 지역 검색
  eq('searchRegion("숭실대")', searchRegion('숭실대')[0].sigungu, '동작구');
  eq('searchRegion("동작구")', searchRegion('동작구')[0].code, '11590');
  eq('searchRegion("ㅁ")', searchRegion('ㅁ').length, 0);

  // 허위매물 신호: 시세의 절반 가격이면 저가 신호가 떠야 한다
  const vals = Array.from({ length: 40 }, (_, i) => 10000 + i * 200).sort((a, b) => a - b);
  const st = describe(vals);
  const risk = checkRiskSignals({
    myPrice: Math.round(st.median * 0.5), stats: st, values: vals,
    comparables: vals.map((v) => ({ excluUseAr: 33, jeonseEquivalent: v })),
    input: { areaM2: null, buildYear: null, maintenanceFee: null, addressDisclosure: '', postingAge: '', agentNumber: '', monthlyRent: 0 },
  });
  eq('저가 매물 → 신호 발생', risk.signals.some((s) => s.id === 'R1'), true);
  eq('저가 매물 → 점수 > 0', risk.score > 0, true);

  // 정상 가격이면 신호가 없어야 한다
  const risk2 = checkRiskSignals({
    myPrice: st.median, stats: st, values: vals,
    comparables: vals.map((v) => ({ excluUseAr: 33, jeonseEquivalent: v })),
    input: { areaM2: null, buildYear: null, maintenanceFee: null, addressDisclosure: '', postingAge: '', agentNumber: '', monthlyRent: 0 },
  });
  eq('정상 가격 → 정상 범위', risk2.grade, '정상 범위');

  // 표본이 적으면 점수 상한이 걸린다
  const smallVals = [10000, 11000, 12000, 13000, 14000, 15000, 16000, 17000, 18000];
  const smallSt = describe(smallVals);
  const risk3 = checkRiskSignals({
    myPrice: 3000, stats: smallSt, values: smallVals,
    comparables: [], input: { areaM2: null, buildYear: null, maintenanceFee: null, addressDisclosure: 'hidden', postingAge: '1개월 이상', agentNumber: '', monthlyRent: 0 },
  });
  eq('표본 부족 → 점수 상한 49', risk3.score <= 49, true);

  let pass = 0;
  for (const [name, got, want] of cases) {
    const ok = got === want;
    if (ok) pass += 1;
    console.log(`${ok ? '✅' : '❌'} ${name} → ${got}${ok ? '' : ` (기대: ${want})`}`);
  }
  console.log(`\n${pass}/${cases.length} 통과`);
  return pass === cases.length;
}

// 콘솔에서 바로 부를 수 있게 전역에 노출한다
window.__selfTest = __selfTest;
