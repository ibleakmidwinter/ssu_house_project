// api/appraise.js — 3단계 판정 결과(적정가·허위매물 점수)를 쉬운 말로 설명하고 확인 질문을 만든다.
// 점수와 등급은 script.js의 규칙 엔진이 이미 계산했다. AI는 그 값을 바꿀 수 없고 설명만 한다.

const { callOpenRouter, extractJson, collectNumbers, verifyNumbers, findBanned, allowFormattedStrings } = require('./parse-query.js');

const SYSTEM_PROMPT = `너는 처음 집을 구하는 대학생에게 매물 점검 결과를 설명해 주는 도우미다.

규칙:
- 반드시 JSON 객체 하나만 출력한다. 설명문, 코드펜스, 인사말을 쓰지 않는다.
- 금액은 입력의 "formatted" 안에 있는 문자열을 **글자 그대로 복사**한다. 숫자를 다시 쓰지 않는다.
- formatted에 없는 금액·비율을 새로 만들지 않는다. 계산하지 않는다.
- "허위매물입니다", "사기입니다" 같은 단정적 표현을 절대 쓰지 않는다.
  대신 "확인이 필요한 신호가 N개 있습니다"처럼 신호의 개수와 성질을 말한다.
- 주어진 등급(risk.grade)을 그대로 설명한다. 점수나 등급을 바꾸거나 다르게 해석하지 않는다.
- 특정 중개사나 플랫폼을 비난하지 않는다.
- 공포를 유발하지 않고, 다음에 할 행동을 알려 준다.
- 부동산 용어는 풀어 쓴다. 모든 문장은 한국어 존댓말로 쓴다.

출력 형식:
{"verdict_plain":"한 문장 결론. 단정 금지.",
"price_explanation":"적정가 범위와 이 매물의 위치를 2~3문장으로 쉽게 설명.",
"signal_explanations":[{"id":"R1","plain":"쉬운 설명","why_risky":"왜 확인이 필요한지"}],
"questions_to_ask":["중개사에게 물어볼 질문"],
"next_actions":["다음에 할 일"]}`;

/**
 * AI 응답이 설명 형태인지 직접 검증한다.
 * @param {any} o
 * @returns {boolean}
 */
function validateExplanation(o) {
  if (!o || typeof o !== 'object') return false;
  const str = (v) => typeof v === 'string' && v.trim().length > 0;
  if (!str(o.verdict_plain) || !str(o.price_explanation)) return false;
  if (o.signal_explanations && !Array.isArray(o.signal_explanations)) return false;
  if (!Array.isArray(o.questions_to_ask) || o.questions_to_ask.length === 0) return false;
  if (!Array.isArray(o.next_actions) || o.next_actions.length === 0) return false;
  if (o.verdict_plain.length > 250 || o.price_explanation.length > 600) return false;
  return true;
}

/**
 * AI 설명이 규칙 엔진의 등급과 모순되지 않는지 본다.
 * 예: 등급이 '정상 범위'인데 "위험"이라고 쓰면 사용자가 잘못 판단하게 된다.
 *
 * @param {string} text 검사할 문장
 * @param {string} grade 규칙 엔진 등급
 * @returns {boolean} 일관성이 있으면 true
 */
function gradeConsistent(text, grade) {
  const alarming = /위험|허위|사기|의심스럽습니다/;
  const reassuring = /안전합니다|문제없습니다|문제가 없습니다|걱정하지/;
  if (grade === '정상 범위' && alarming.test(text)) return false;
  if (grade === '높은 주의' && reassuring.test(text)) return false;
  return true;
}

/**
 * 만원 단위 금액을 한국식 문구로 바꾼다.
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
 * AI를 쓰지 못할 때의 결정론적 설명문.
 * @param {object} p 판정 결과
 * @returns {object}
 */
function templateExplanation(p) {
  const fp = p.fairPrice || {};
  const risk = p.risk || {};
  const signals = risk.triggeredSignals || [];
  const count = signals.filter((s) => (s.points || 0) > 0).length;

  const verdict = count === 0
    ? '확인이 필요한 특이 신호는 발견되지 않았습니다. 다만 현장 확인은 꼭 하시는 것이 좋습니다.'
    : `확인이 필요한 신호가 ${count}개 발견되었습니다. 아래 근거를 보시고 중개사에게 직접 확인해 보세요.`;

  const range = Array.isArray(fp.jeonseEquivalentRange) ? fp.jeonseEquivalentRange : [0, 0];
  const price = `이 조건에서 보통 거래되는 금액대는 ${fmt(range[0])}에서 ${fmt(range[1])} 사이입니다. `
    + (fp.listingPercentile !== undefined && fp.listingPercentile !== null
      ? `입력하신 매물은 이 동네 거래의 약 ${Math.round(fp.listingPercentile)}% 지점으로, '${fp.grade}'에 해당합니다.`
      : '');

  return {
    verdict_plain: verdict,
    price_explanation: price,
    signal_explanations: signals.map((s) => ({
      id: s.id,
      plain: s.name,
      why_risky: s.reason || '시세 분포에서 벗어난 조건입니다.',
    })),
    questions_to_ask: [
      '이 매물 지금도 계약 가능한 상태인가요? 지번 주소를 알려주실 수 있나요?',
      '관리비에 어떤 항목이 포함되나요? 별도로 내는 비용이 또 있나요?',
      '집주인이 등기부등본상 소유자와 같은 분인가요?',
      '근저당이 설정되어 있나요? 보증금보다 큰 금액인가요?',
      '전세보증금 반환보증 가입이 가능한 집인가요?',
    ],
    next_actions: [
      '방문 전 전화로 매물이 실제로 남아 있는지 확인하기',
      '인터넷등기소에서 등기부등본을 떼어 소유자와 근저당 확인하기',
      '정부24에서 건축물대장을 열람해 불법 건축물·근린생활시설 여부 확인하기',
      '중개사무소 등록번호를 조회해 정식 등록 업소인지 확인하기',
      '계약 후 즉시 확정일자 받기와 전입신고 하기',
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

  const grade = payload?.risk?.grade || '정상 범위';
  const allowed = allowFormattedStrings(payload.formatted, collectNumbers(payload));

  try {
    // callOpenRouter가 이미 모든 무료 모델 후보를 순회하므로 재시도는 1회만 더 한다
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { text, model } = await callOpenRouter({
        system: SYSTEM_PROMPT,
        user: `아래는 규칙 엔진이 이미 계산한 판정 결과입니다. 점수와 등급은 바꾸지 말고 설명만 해 주세요.\n\n${JSON.stringify(payload)}`,
        maxTokens: 1100,
        temperature: 0.2,
      });

      const obj = extractJson(text);
      if (!validateExplanation(obj)) continue;

      const joined = [obj.verdict_plain, obj.price_explanation,
        ...(obj.signal_explanations || []).map((s) => `${s.plain} ${s.why_risky}`),
        ...obj.questions_to_ask, ...obj.next_actions].join(' ');

      // 검증 1) 금칙어 2) 등급 모순 3) 우리가 주지 않은 숫자
      if (findBanned(joined).length > 0) continue;
      if (!gradeConsistent(joined, grade)) continue;
      const num = verifyNumbers(joined, allowed);
      if (!num.ok) continue;

      obj.source = 'ai';
      obj.model = model;
      return res.status(200).json({ ok: true, data: obj });
    }
  } catch {
    // 아래 폴백으로 내려간다
  }

  // 판정 자체는 이미 끝나 있으므로, 설명만 템플릿으로 대체해 항상 결과를 보여 준다
  return res.status(200).json({ ok: true, data: templateExplanation(payload) });
};
