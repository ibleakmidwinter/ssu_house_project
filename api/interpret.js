// api/interpret.js — 2단계에서 계산한 시세 통계를 대학생이 읽을 수 있는 한국어 리포트로 바꾼다.
// 숫자는 전부 클라이언트가 계산해 넘겨준 값이며, 이 함수는 '설명'만 생성한다.

const { callOpenRouter, extractJson, collectNumbers, verifyNumbers, findBanned, allowFormattedStrings } = require('./parse-query.js');

const SYSTEM_PROMPT = `너는 한국 전월세 시세 통계를 처음 집을 구하는 대학생에게 설명해 주는 도우미다.

규칙:
- 반드시 JSON 객체 하나만 출력한다. 설명문, 코드펜스, 인사말을 쓰지 않는다.
- 금액은 입력의 "formatted" 안에 있는 문자열을 **글자 그대로 복사**한다. 숫자를 다시 쓰거나 단위를 바꾸지 않는다.
  (예: formatted.median이 "2억 2,455만원"이면 그 문장에 "2억 2,455만원"이라고 쓴다. "22,455만원"이나 "2,245만원"으로 바꾸면 안 된다.)
- formatted에 없는 금액·비율·퍼센트를 새로 만들지 않는다. 계산하지 않는다.
- 미래 가격을 예측하지 않는다. "오를 것", "투자" 같은 표현을 쓰지 않는다.
- 계약을 권유하거나 보장하지 않는다.
- 부동산 용어(환산보증금, 전용면적, 중위값, 사분위)는 쉬운 말로 풀어 쓰고 glossary에 설명을 담는다.
- 표본이 적으면 cautions에 그 사실을 적는다.
- 모든 문장은 한국어 존댓말로 쓴다.

출력 형식:
{"headline":"한 문장 요약",
"summary":"2~4문장. 이 동네 시세 수준과 가격 폭을 설명.",
"neighborhoodComparison":"1~2문장. 주변 지역과 비교한 위치.",
"budgetFit":"1~2문장. 사용자 예산이 이 동네에서 어떤 위치인지.",
"cautions":["주의할 점"],
"glossary":[{"term":"환산보증금","plain":"월세를 전세로 바꿔 계산한 금액"}]}`;

/**
 * AI 응답이 리포트 형태인지 직접 검증한다.
 * @param {any} o
 * @returns {boolean}
 */
function validateReport(o) {
  if (!o || typeof o !== 'object') return false;
  const str = (v) => typeof v === 'string' && v.trim().length > 0;
  if (!str(o.headline) || !str(o.summary)) return false;
  if (o.cautions && !Array.isArray(o.cautions)) return false;
  if (o.glossary && !Array.isArray(o.glossary)) return false;
  // 지나치게 긴 답변은 모델이 지시를 벗어난 것이다
  if (o.summary.length > 600 || o.headline.length > 200) return false;
  return true;
}

/**
 * 만원 단위 금액을 한국식 문구로 바꾼다. (예: 12000 → "1억 2,000만원")
 * 폴백 문장을 만들 때 쓴다.
 * @param {number} manwon
 * @returns {string}
 */
function fmt(manwon) {
  const n = Math.round(Number(manwon) || 0);
  const eok = Math.floor(n / 10000);
  const rest = n % 10000;
  if (eok > 0 && rest > 0) return `${eok}억 ${rest.toLocaleString('ko-KR')}만원`;
  if (eok > 0) return `${eok}억원`;
  return `${n.toLocaleString('ko-KR')}만원`;
}

/**
 * AI를 쓰지 못할 때 쓰는 결정론적 요약문.
 * 계산된 숫자만 끼워 넣으므로 항상 정확하다.
 *
 * @param {object} p 클라이언트가 보낸 통계 요약
 * @returns {object} 리포트 형태
 */
function templateReport(p) {
  const regionName = [p.region?.dong, p.region?.sigungu].filter(Boolean).join(' ') || p.region?.sigungu || '해당 지역';
  const s = p.stats || {};
  const cautions = [];
  if (p.confidence?.grade === '낮음') cautions.push('거래 표본이 적어 참고용으로만 보시는 것이 좋습니다.');
  if (p.conversion?.source !== 'estimated') cautions.push('월세를 전세로 환산할 때 지역 기본 전환율을 사용했습니다.');
  if (p.trend && !p.trend.reliable) cautions.push('최근 추세는 표본이 부족해 표시하지 않았습니다.');
  if (cautions.length === 0) cautions.push('실거래가는 신고 시차가 있어 최근 1~2개월 자료가 적을 수 있습니다.');

  return {
    headline: `${regionName} 전세 환산 기준 중간값은 ${fmt(s.median)}입니다`,
    // 클라이언트는 사분위를 q1/q3로 보내고, 옛 호출부는 p25/p75로 보낸다. 둘 다 받는다.
    summary: `최근 거래 ${s.n}건을 기준으로, 이 동네에서 보통 거래되는 금액대는 ${fmt(s.q1 ?? s.p25)}에서 ${fmt(s.q3 ?? s.p75)} 사이입니다. `
      + `가장 가운데 값(중간값)은 ${fmt(s.median)}이고, 가장 낮은 거래는 ${fmt(s.min ?? s.p10)}, 가장 높은 거래는 ${fmt(s.max ?? s.p90)}이었습니다.`,
    neighborhoodComparison: p.neighborhood?.relativeLabel
      ? `주변 동네와 비교하면 이 지역은 ${p.neighborhood.relativeLabel} 편입니다.`
      : '주변 지역 비교 자료를 함께 확인해 보세요.',
    budgetFit: p.budget?.percentile !== undefined && p.budget?.percentile !== null
      ? `입력하신 예산 ${fmt(p.budget.jeonseEquivalent)}은 이 동네 거래의 약 ${Math.round(p.budget.percentile)}% 지점에 해당합니다.`
      : '예산을 입력하시면 시세 내 위치를 알려드립니다.',
    cautions,
    glossary: [
      { term: '환산보증금', plain: '월세를 전세로 바꿔 계산한 금액입니다. 전세 매물과 월세 매물을 같은 기준으로 비교할 수 있습니다.' },
      { term: '중간값(중위값)', plain: '거래를 금액순으로 줄 세웠을 때 정확히 가운데 있는 값입니다. 비싼 집 몇 채에 휘둘리지 않아 평균보다 체감 시세에 가깝습니다.' },
      { term: '전용면적', plain: '현관문 안쪽, 실제로 쓰는 공간의 면적입니다. 복도나 계단은 빠집니다.' },
    ],
    source: 'template',
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST만 허용합니다' } });
  }

  let payload = {};
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch {
    return res.status(400).json({ ok: false, error: { code: 'BAD_INPUT', message: '요청 형식이 올바르지 않습니다' } });
  }

  // AI가 쓸 수 있는 숫자 집합. 이 밖의 숫자가 답변에 등장하면 폐기한다.
  // 완성된 금액 문자열(formatted) 안의 숫자도 허용한다.
  const allowed = allowFormattedStrings(payload.formatted, collectNumbers(payload));

  try {
    // callOpenRouter가 이미 모든 무료 모델 후보를 순회하므로 재시도는 1회만 더 한다
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { text, model } = await callOpenRouter({
        system: SYSTEM_PROMPT,
        user: `아래는 계산이 끝난 시세 통계입니다. 이 숫자만 사용해 설명해 주세요.\n\n${JSON.stringify(payload)}`,
        maxTokens: 900,
        temperature: 0.2,
      });

      const obj = extractJson(text);
      if (!validateReport(obj)) continue;

      // 검증 1) 금칙어 2) 우리가 주지 않은 숫자
      const joined = [obj.headline, obj.summary, obj.neighborhoodComparison, obj.budgetFit,
        ...(obj.cautions || [])].filter(Boolean).join(' ');
      if (findBanned(joined).length > 0) continue;
      const num = verifyNumbers(joined, allowed);
      if (!num.ok) continue;

      obj.source = 'ai';
      obj.model = model;
      return res.status(200).json({ ok: true, data: obj });
    }
  } catch {
    // 아래 폴백으로 내려간다
  }

  // AI가 실패해도 결과 화면은 항상 채워져야 한다
  return res.status(200).json({ ok: true, data: templateReport(payload) });
};
