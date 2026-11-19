// api/parse-query.js — 사용자가 쓴 문장에서 지역·예산·조건을 뽑아낸다. (OpenRouter 무료 모델)
// OpenRouter 호출 공통 함수도 여기서 정의해 interpret.js / appraise.js가 함께 쓴다.

// ===== OpenRouter 공통 =====

const API_KEY = () => process.env.OPENROUTER_API_KEY;
// 모델 이름은 환경변수로 교체 가능하게 하고, 없으면 무료 기본 모델을 쓴다
const MODEL = () => process.env.OPENROUTER_MODEL || 'google/gemma-4-26b-a4b-it:free';

// 1순위 모델이 막혔을 때 쓸 무료 후보. 무료 라인업은 수시로 바뀌므로 여러 개를 둔다.
// 2026-11 기준 실제로 응답이 확인된 무료 모델 후보.
// 무료 모델은 공유 풀을 쓰므로 429(rate limit)가 흔하다. 모델이 막히거나 사라져도
// 다음 후보로 넘어가도록 여러 개를 둔다.
const FALLBACK_MODELS = [
  'cohere/north-mini-code:free',
  'inclusionai/ling-3.2-flash:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'google/gemma-4-31b-it:free',
  'baidu/ernie-5.5-flash-preview:free',
];

const TIMEOUT_MS = 20000;

/**
 * 무료 모델 상당수가 추론(reasoning) 모델이어서 max_tokens를 추론에 먼저 쓴다.
 * 한도가 작으면 content가 빈 채로 돌아오므로, 실제 필요량의 3배 이상을 잡고
 * 추론 강도를 낮춰 요청한다.
 * @param {number} want 실제로 필요한 출력 토큰 수
 * @returns {number}
 */
function tokenBudget(want) {
  return Math.max(1200, want * 3);
}

/**
 * OpenRouter 채팅 완성을 호출한다. 모델이 막히면 무료 후보로 차례로 넘어간다.
 *
 * @param {object} opts
 * @param {string} opts.system 시스템 프롬프트
 * @param {string} opts.user 사용자 메시지
 * @param {number} [opts.maxTokens=800]
 * @param {number} [opts.temperature=0.2] 숫자를 다루므로 낮게 고정한다
 * @returns {Promise<{text:string, model:string}>}
 * @throws {Error} 모든 후보가 실패하면 예외
 */
async function callOpenRouter({ system, user, maxTokens = 800, temperature = 0.2 }) {
  const key = API_KEY();
  if (!key) {
    const e = new Error('OPENROUTER_API_KEY가 설정되지 않았습니다');
    e.code = 'NO_API_KEY';
    throw e;
  }

  const candidates = [MODEL(), ...FALLBACK_MODELS.filter((m) => m !== MODEL())];
  let lastErr = null;

  for (const model of candidates) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`, // 키는 서버에서만 붙인다
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature,
          max_tokens: tokenBudget(maxTokens),
          // 추론에 토큰을 덜 쓰도록 낮춰 달라고 요청한다 (지원하지 않는 모델은 이 항목을 무시한다)
          reasoning: { effort: 'low' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: ac.signal,
      });

      if (!res.ok) {
        // 429(무료 공유 풀 혼잡)·404(모델 없음)·5xx는 기다리지 않고 다음 후보로 넘어간다
        lastErr = new Error(`OpenRouter ${res.status} (${model})`);
        continue;
      }
      const json = await res.json();
      const msg = json?.choices?.[0]?.message || {};
      // 추론 모델이 content를 비우고 reasoning에만 답을 담는 경우가 있어 둘 다 본다
      const text = (msg.content && msg.content.trim()) ? msg.content : (msg.reasoning || '');
      if (!text.trim()) {
        lastErr = new Error(`빈 응답 (${model}, finish=${json?.choices?.[0]?.finish_reason})`);
        continue;
      }
      return { text, model };
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('모든 모델 후보가 실패했습니다');
}

/**
 * 모델 답변에서 JSON 객체만 꺼낸다.
 * 무료 모델은 코드펜스나 설명문을 덧붙이는 일이 흔해 중괄호 구간을 직접 잘라낸다.
 *
 * @param {string} text 모델 원문
 * @returns {object|null} 파싱된 객체, 실패 시 null
 */
function extractJson(text) {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 객체 안의 모든 숫자를 모은다. AI가 없는 숫자를 만들어 냈는지 검사할 때 쓴다.
 * @param {any} v 임의 값
 * @param {Set<number>} [acc]
 * @returns {Set<number>}
 */
function collectNumbers(v, acc = new Set()) {
  if (typeof v === 'number' && Number.isFinite(v)) acc.add(v);
  else if (Array.isArray(v)) v.forEach((x) => collectNumbers(x, acc));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => collectNumbers(x, acc));
  return acc;
}

/**
 * 서술에 자연스럽게 등장하는 구조적 숫자. 사분위·백분율 라벨 등이다.
 * 금액을 지어내는 것과 구분하기 위해 화이트리스트로 좁게 둔다.
 */
const STRUCTURAL_NUMBERS = new Set([25, 50, 75, 90, 100]);

/**
 * AI가 쓴 문장 속 숫자가 모두 '우리가 계산해 준 숫자'인지 검사한다.
 * 모델이 금액을 잘못 옮겨 쓰거나 비율을 멋대로 만들어 내는 것을 막기 위한 장치다.
 * (실제로 22,455를 2,245로 잘못 쓰는 사례가 있어 반드시 필요하다)
 *
 * @param {string} text 검사할 문장들을 이어 붙인 문자열
 * @param {Set<number>} allowed 허용 숫자 집합
 * @returns {{ok:boolean, unknown:number[]}}
 */
function verifyNumbers(text, allowed) {
  const found = (text.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) || [])
    .map((s) => Number(s.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));
  const unknown = [];
  for (const n of found) {
    // 작은 정수(개수·문장 수·개월 수)와 사분위 라벨은 서술상 필요하므로 통과시킨다
    if (Number.isInteger(n) && n <= 12) continue;
    if (STRUCTURAL_NUMBERS.has(n)) continue;
    const ok = [...allowed].some((a) => {
      if (a === 0) return n === 0;
      return Math.abs(n - a) <= Math.max(Math.abs(a) * 0.01, 0.5);
    });
    if (!ok) unknown.push(n);
  }
  return { ok: unknown.length === 0, unknown: [...new Set(unknown)] };
}

/**
 * 완성된 금액 문자열("2억 2,455만원")에 들어 있는 숫자들을 허용 집합에 더한다.
 * AI에게 금액 서식을 맡기지 않고 문자열을 그대로 복사하게 하면
 * 그 문자열 안의 숫자(2, 2455 …)도 정당한 값이 된다.
 *
 * @param {object} formatted { key: '2억 2,455만원' } 형태
 * @param {Set<number>} allowed 허용 집합 (여기에 추가된다)
 * @returns {Set<number>} 같은 집합
 */
function allowFormattedStrings(formatted, allowed) {
  for (const v of Object.values(formatted || {})) {
    for (const tok of String(v).match(/\d+(?:,\d{3})*(?:\.\d+)?/g) || []) {
      allowed.add(Number(tok.replace(/,/g, '')));
    }
  }
  return allowed;
}

/** 단정·권유 표현 금칙어. 허위매물 판정에서 특히 위험하다. */
const BANNED_WORDS = ['허위매물입니다', '사기입니다', '사기다', '확실히', '100% ', '반드시 오를', '투자하', '계약하세요', '보장합니다'];

/**
 * 금칙어가 들어 있는지 본다.
 * @param {string} text
 * @returns {string[]} 발견된 금칙어
 */
function findBanned(text) {
  return BANNED_WORDS.filter((w) => text.includes(w));
}

// ===== 규칙 기반 폴백 파서 =====

/**
 * AI 없이 정규식으로 문장에서 금액과 지역 키워드를 뽑는다.
 * AI가 실패해도 입력 파싱이 완전히 막히지 않게 하는 안전망이다.
 *
 * @param {string} text 사용자 문장
 * @returns {object} ParsedQuery 형태
 */
function fallbackParse(text) {
  const t = String(text || '');
  const parsed = {
    region: { sido: null, sigungu: null, dong: null, keyword: null, confidence: 0.3 },
    budget: { contractType: '전세', deposit: null, monthlyRent: 0 },
    filters: { buildingTypes: [], areaMinM2: null, areaMaxM2: null },
    ambiguities: ['AI 파싱을 쓰지 못해 간단 규칙으로 해석했습니다'],
    source: 'fallback',
  };

  // '월세'가 들어 있으면 월세 계약으로 본다
  if (/월세/.test(t)) parsed.budget.contractType = '월세';

  // "보증금 1000", "1000에 월세 60", "전세 1억 2천"
  const eok = t.match(/(\d+)\s*억/);
  const man = t.match(/억\s*(\d{1,4})\s*(?:천|만)?/);
  if (eok) {
    parsed.budget.deposit = Number(eok[1]) * 10000 + (man ? Number(man[1]) * (/천/.test(man[0]) ? 1000 : 1) : 0);
  } else {
    const dep = t.match(/(?:보증금|전세)\s*(\d{3,6})/) || t.match(/(\d{3,6})\s*(?:에|\/)/);
    if (dep) parsed.budget.deposit = Number(dep[1]);
  }
  const rent = t.match(/월세\s*(\d{1,4})/) || t.match(/\/\s*(\d{1,3})\s*만?/);
  if (rent) {
    parsed.budget.monthlyRent = Number(rent[1]);
    parsed.budget.contractType = '월세';
  }

  // 지역 키워드: '동/구/시/대/역'으로 끝나는 토큰을 후보로 본다
  const kw = t.match(/([가-힣]{2,10}(?:동|구|시|군|대|역))/);
  if (kw) { parsed.region.keyword = kw[1]; parsed.region.confidence = 0.5; }

  if (/원룸|빌라|연립|다세대/.test(t)) parsed.filters.buildingTypes.push('연립다세대');
  if (/오피스텔/.test(t)) parsed.filters.buildingTypes.push('오피스텔');
  if (/아파트/.test(t)) parsed.filters.buildingTypes.push('아파트');
  if (/단독|다가구|하숙/.test(t)) parsed.filters.buildingTypes.push('단독다가구');

  return parsed;
}

// ===== 프롬프트 =====

const SYSTEM_PROMPT = `너는 한국 부동산 임차 검색어를 구조화하는 도구다.
사용자 문장에서 지역, 예산, 집 조건을 뽑아 JSON만 출력한다.

규칙:
- 반드시 아래 형식의 JSON 객체 하나만 출력한다. 설명, 인사, 코드펜스를 쓰지 않는다.
- 문장에 없는 값은 null로 둔다. 추측해서 채우지 않는다.
- 금액 단위는 모두 '만원'이다. "1억 2천" → 12000, "보증금 1000" → 1000, "월세 60" → 60.
- 지역은 행정구역 이름(sido/sigungu/dong)으로 분해하고, 대학·역 같은 랜드마크는 keyword에 원문 그대로 넣는다.
  랜드마크가 어느 행정구역인지 확실하지 않으면 sigungu를 null로 두고 keyword만 채운다. 지리 지식을 추측하지 않는다.
- buildingTypes는 "아파트","오피스텔","연립다세대","단독다가구" 중에서만 고른다. 원룸·빌라는 "연립다세대"로 본다.
- confidence는 0~1 사이 숫자로, 지역 해석의 확신도를 넣는다.

출력 형식:
{"region":{"sido":null,"sigungu":null,"dong":null,"keyword":null,"confidence":0},
"budget":{"contractType":"전세","deposit":null,"monthlyRent":0},
"filters":{"buildingTypes":[],"areaMinM2":null,"areaMaxM2":null},
"ambiguities":[]}`;

/**
 * AI 응답이 ParsedQuery 형태인지 직접 검증한다. (검증 라이브러리 금지)
 * @param {any} o 파싱된 객체
 * @returns {boolean}
 */
function validateParsed(o) {
  if (!o || typeof o !== 'object') return false;
  if (!o.region || typeof o.region !== 'object') return false;
  if (!o.budget || typeof o.budget !== 'object') return false;
  if (!['전세', '월세'].includes(o.budget.contractType)) return false;
  const numOrNull = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
  if (!numOrNull(o.budget.deposit)) return false;
  if (!numOrNull(o.budget.monthlyRent)) return false;
  // 금액 상한을 넘으면 모델이 단위를 잘못 이해한 것이다 (만원 단위 기준 100억 초과)
  if (o.budget.deposit && o.budget.deposit > 1000000) return false;
  if (o.budget.monthlyRent && o.budget.monthlyRent > 10000) return false;
  // 월세 금액이 있는데 '전세'로 답하는 모순이 실제로 관찰됐다. 모델을 믿지 않고 바로잡는다.
  if (o.budget.monthlyRent > 0 && o.budget.contractType !== '월세') o.budget.contractType = '월세';
  if (o.budget.contractType === '전세') o.budget.monthlyRent = 0;
  if (!o.filters || !Array.isArray(o.filters.buildingTypes)) return false;
  const allowed = ['아파트', '오피스텔', '연립다세대', '단독다가구'];
  if (!o.filters.buildingTypes.every((t) => allowed.includes(t))) return false;
  return true;
}

// ===== 핸들러 =====

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST만 허용합니다' } });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const text = String(body.text || '').slice(0, 500); // 과도한 입력은 자른다
    if (text.trim().length < 2) {
      return res.status(400).json({ ok: false, error: { code: 'BAD_INPUT', message: '검색할 문장을 입력해 주세요' } });
    }

    // 키가 없으면 AI를 건너뛰고 규칙 파서로 답한다 (AI 실패가 기능을 막지 않는다)
    if (!API_KEY()) {
      return res.status(200).json({ ok: true, data: fallbackParse(text) });
    }

    // 사용자 입력은 user 메시지로만 전달해 시스템 지시와 섞이지 않게 한다 (프롬프트 인젝션 방지)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { text: out, model } = await callOpenRouter({
          system: SYSTEM_PROMPT,
          user: text,
          maxTokens: 400,
          temperature: 0.1,
        });
        const parsed = extractJson(out);
        if (validateParsed(parsed)) {
          parsed.source = 'ai';
          parsed.model = model;
          if (!Array.isArray(parsed.ambiguities)) parsed.ambiguities = [];
          return res.status(200).json({ ok: true, data: parsed });
        }
      } catch (err) {
        if (err.code === 'NO_API_KEY') break;
      }
    }

    // 두 번 시도해도 형식이 맞지 않으면 규칙 파서로 내려간다
    return res.status(200).json({ ok: true, data: fallbackParse(text) });
  } catch (err) {
    return res.status(200).json({ ok: true, data: fallbackParse(String((req.body && req.body.text) || '')) });
  }
};

// interpret.js / appraise.js가 함께 쓰는 공통 함수들을 내보낸다
module.exports.callOpenRouter = callOpenRouter;
module.exports.extractJson = extractJson;
module.exports.collectNumbers = collectNumbers;
module.exports.verifyNumbers = verifyNumbers;
module.exports.allowFormattedStrings = allowFormattedStrings;
module.exports.findBanned = findBanned;
