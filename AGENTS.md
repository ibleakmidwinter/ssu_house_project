# AGENTS.md — `ssu_re_app` 작업 규칙

이 저장소에서 작업하는 모든 에이전트는 아래 규칙을 **예외 없이** 따른다.
기획 문서: [PRD_step1.md](PRD_step1.md) · [PRD_step2.md](PRD_step2.md) · [PRD_step3.md](PRD_step3.md)

## 0. 프로젝트 한 줄 요약

대학생·사회초년생이 **지역과 예산**을 입력하면, 국토교통부 실거래가 공공데이터로 **그 지역 전월세 시세 범위**를 계산하고, 사용자가 찾은 매물의 **적정가격 범위와 허위매물 가능성**을 판정해 주는 반응형 웹앱.

---

## 1. 기술 제약 (절대 규칙)

**순수 HTML / CSS / JavaScript + Vercel 서버리스 함수만 사용한다. 프레임워크와 빌드 도구는 금지한다.**

### 파일 구조 (이 구조를 벗어나지 않는다)

```
/
├── index.html      # 모든 화면 (1~3단계 섹션) — JS로 전환
├── style.css       # 모든 스타일
├── script.js       # 모든 클라이언트 로직
├── api/            # Vercel 서버리스 함수 (여기서만 외부 API 호출)
│   ├── parse-query.js
│   ├── transactions.js
│   ├── analyze.js
│   ├── interpret.js
│   └── appraise.js
├── data/           # 정적 JSON (법정동코드, 보정계수, 리스크 규칙 등)
├── .env.local      # 비밀 키 (git 제외)
├── .gitignore
└── AGENTS.md, PRD_step*.md
```

### 금지

| 금지 항목 | 비고 |
|---|---|
| React, Vue, Svelte, Next.js 등 프레임워크 | DOM은 `document.createElement` / `innerHTML`로 직접 조작 |
| webpack, vite, esbuild, rollup, parcel 등 번들러 | 빌드 단계 자체를 두지 않는다 |
| TypeScript 컴파일 | 타입이 필요하면 **JSDoc 주석**으로 기술 |
| Tailwind, Sass, PostCSS | `style.css`에 일반 CSS + CSS 변수 |
| Chart.js, Recharts, D3 등 차트 라이브러리 | 차트는 **인라인 SVG**를 직접 생성 |
| Zod, Joi 등 검증 라이브러리 | 검증 함수를 직접 작성 |
| jQuery, lodash, axios, dayjs | 표준 `fetch`, `Intl`, `Date` 사용 |
| `package.json`에 런타임 의존성 추가 | 의존성 0을 유지한다 |
| 새 소스 파일 추가 (`js/`, `components/` 등) | `script.js` 하나에 **섹션 주석**으로 구획 |

### 허용

- `api/*.js` 안에서 Node.js 내장 모듈과 전역 `fetch`
- `data/*.json` 정적 데이터 파일
- `npx vercel dev`, `npx vercel` (개발·배포 CLI — 설치형 의존성이 아님)

### `script.js` 섹션 순서 (고정)

```js
// ===== 1. 상태 =====
// ===== 2. 유틸(금액·면적·포맷) =====
// ===== 3. 통계 =====
// ===== 4. API 호출 =====
// ===== 5. SVG 차트 =====
// ===== 6. 렌더링 =====
// ===== 7. 이벤트 바인딩 =====
```

### 실행 가능성

**언제나 `index.html`을 열면 첫 화면이 보여야 한다.** 빌드·설치·서버 없이 파일을 열어도 화면이 깨지지 않아야 하고, 서버 함수가 필요한 기능만 비활성 상태로 표시한다.

---

## 2. OpenRouter 호출 규칙

### 호출 위치

**OpenRouter 호출은 `api/` 폴더 안에서만 한다.**
`script.js`에서 `openrouter.ai`를 직접 호출하면 **API 키가 브라우저에 노출**되므로 절대 금지한다. 프런트엔드는 항상 자기 서버의 `/api/*` 경로만 호출한다.

```
script.js  ──fetch('/api/parse-query')──▶  api/parse-query.js  ──▶  openrouter.ai
   (키 없음)                                   (키 있음)
```

### 키와 모델 이름

```js
// api/ 안의 모든 OpenRouter 호출은 이 두 환경변수를 사용한다
const API_KEY = process.env.OPENROUTER_API_KEY;                              // 비밀 키
const MODEL   = process.env.OPENROUTER_MODEL || 'google/gemma-4-26b-a4b-it:free'; // 기본 무료 모델
```

- **API 키**: `process.env.OPENROUTER_API_KEY` — 코드에 하드코딩 금지
- **모델 이름**: `process.env.OPENROUTER_MODEL`, 기본값 **`google/gemma-4-26b-a4b-it:free`**
- 무료 모델만 사용한다 (`:free` 접미사). 유료 모델로 바꾸는 코드를 쓰지 않는다.

### 호출 표준 형태

```js
// OpenRouter 채팅 완성 호출 — api/ 안에서만 사용한다
const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${API_KEY}`,   // 키는 서버에서만 붙인다
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: MODEL,
    temperature: 0.2,          // 숫자를 다루므로 낮게 고정
    max_tokens: 800,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userText },
    ],
  }),
});
```

### AI 결과 취급 원칙

1. **숫자 계산은 AI에게 맡기지 않는다.** 평균·중위값·점수는 결정론적 JS 코드로 계산하고, AI는 **이미 계산된 숫자를 설명**만 한다.
2. 모든 AI 응답은 **직접 작성한 검증 함수**를 통과해야 채택한다. 실패하면 1회 재시도, 그래도 실패하면 **규칙 기반 템플릿 폴백**으로 응답한다.
3. **AI 실패가 기능을 막지 않는다.** AI 없이도 핵심 플로우가 동작해야 한다.

---

## 3. 작업 방식 — 한 번에 한 기능만

- **한 번에 한 기능만 만든다.** 여러 기능을 한 번에 묶어서 구현하지 않는다.
- "한 기능"의 기준은 **사용자가 눈으로 확인할 수 있는 최소 단위**다. (예: "첫 화면이 보인다", "지역 자동완성이 동작한다", "실거래가가 수집된다")
- 기능을 만든 뒤에는 **반드시 확인 방법을 알려 준다.** 아래 4가지를 포함한다.

```
1) 실행 명령      — 예: npx vercel dev
2) 접속 위치      — 예: http://localhost:3000
3) 해야 할 조작   — 예: 지역에 "상도동" 입력 → "시세 분석하기" 클릭
4) 기대 결과      — 예: 결론 카드에 중위 보증금과 p25~p75 범위가 표시됨
```

- 다음 기능으로 넘어가기 전에 **"여기까지 확인되면 알려 주세요"** 라고 멈춘다.

---

## 4. 주석은 모두 한국어로

**모든 코드에 한국어 주석을 단다.**

| 위치 | 필수 주석 |
|---|---|
| 파일 맨 위 | 이 파일의 역할 한 줄 |
| 모든 함수 | 목적 / 입력 / 출력 (JSDoc 권장) |
| 자명하지 않은 로직 | **왜** 그렇게 했는지 (what이 아니라 why) |
| 상수·임계값 | 그 값을 고른 근거 |
| CSS | 섹션 구분 주석 + 미디어 쿼리 의도 |

```js
/**
 * 월세를 전세로 환산한 금액(환산보증금)을 구한다.
 * 전세와 월세 매물을 같은 축에서 비교하기 위해 필요하다.
 *
 * @param {number} deposit       보증금 (만원)
 * @param {number} monthlyRent   월세 (만원)
 * @param {number} conversionRate 전월세 전환율 (%)
 * @returns {number} 환산보증금 (만원)
 */
function toJeonseEquivalent(deposit, monthlyRent, conversionRate) {
  // 연간 월세를 전환율로 나누면 같은 가치의 보증금이 된다
  return deposit + (monthlyRent * 12) / (conversionRate / 100);
}
```

---

## 5. 환경변수와 비밀 관리

- 모든 키는 **`.env.local`** 에 넣는다.
- **`.env.local`은 `.gitignore`에 등록**한다. 커밋하지 않는다.
- 키를 코드·PRD·커밋 메시지·로그에 평문으로 쓰지 않는다.
- Vercel에 배포할 때는 대시보드의 **Environment Variables**에 같은 이름으로 등록한다.

`.env.local` 형식:

```
OPENROUTER_API_KEY=여기에_OpenRouter_키
OPENROUTER_MODEL=google/gemma-4-26b-a4b-it:free
DATA_GO_KR_SERVICE_KEY=여기에_공공데이터포털_인증키
```

키 노출 점검:

```bash
grep -rn "sk-or-\|DATA_GO_KR_SERVICE_KEY=" index.html style.css script.js   # 결과가 0건이어야 한다
```

---

## 6. 터미널 명령은 에이전트가 직접 실행한다

- **필요한 터미널 명령은 에이전트가 직접 실행하고, 결과를 사용자에게 설명한다.** 명령만 알려 주고 사용자에게 떠넘기지 않는다.
- 실행 후에는 **무엇을 했고, 출력이 무슨 뜻이며, 다음에 무엇을 하면 되는지** 한국어로 설명한다.
- 되돌리기 어려운 명령(`rm -rf`, `git push`, `vercel --prod`, 파일 덮어쓰기)은 **먼저 확인을 받는다.**

자주 쓰는 명령:

```bash
python3 -m http.server 3000    # 첫 화면만 빠르게 확인 (서버 함수 없음)
npx vercel dev                 # 서버리스 함수까지 포함해 로컬 실행
npx vercel                     # 프리뷰 배포
```

---

## 7. 코딩 컨벤션

- 들여쓰기 2칸, 세미콜론 사용, `const`/`let` (`var` 금지)
- 통계·판정 함수는 **순수 함수**로 작성하고 DOM을 만지지 않는다. DOM 조작은 렌더링 섹션에서만 한다.
- 임계값·보정계수는 코드에 흩지 말고 `data/*.json` 또는 파일 상단 상수 블록에 모은다.
- 서버 함수는 CommonJS 핸들러 형태로 작성한다.

```js
// api/example.js — 이 함수가 하는 일 한 줄
module.exports = async (req, res) => {
  // POST 외 메서드는 받지 않는다
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST만 허용합니다' } });
  }
  try {
    // ... 처리 ...
    return res.status(200).json({ ok: true, data: result });
  } catch (err) {
    // 에러 메시지는 사용자가 읽을 한국어로 돌려준다
    return res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: '처리 중 오류가 발생했습니다' } });
  }
};
```

- 응답 형식: 성공 `{ ok: true, data }` / 실패 `{ ok: false, error: { code, message } }`
- 자체 점검은 `script.js` 끝의 `__selfTest()` 함수에 케이스를 추가하고, 브라우저 콘솔에서 실행해 확인한다.

---

## 8. 사용자 대상 문구 규칙

- 대상은 **부동산 경험이 없는 대학생·사회초년생**이다. 전문 용어는 풀어 쓰고 툴팁을 붙인다.
- 금액은 한국식 단위로 표기한다 (`12000` → `1억 2,000만원`).
- 허위매물 판정에 **단정형을 쓰지 않는다.** "허위매물입니다"(✗) → "확인이 필요한 신호가 3개 있습니다"(○)
- 공포를 유발하는 문구를 쓰지 않고, 대신 **다음에 할 행동**을 제시한다.
- 모든 판정 화면에 면책 문구를 표시한다 (PRD_step3 §7).

---

## 9. 구현 순서

| 순서 | 기능 | 확인 기준 |
|---|---|---|
| 1 | **첫 화면 (입력 홈)** | `index.html`을 열면 지역·예산 입력 폼과 CTA가 보인다 |
| 2 | 지역 검색·자동완성 | `data/legal-dong-codes.json`으로 시군구코드가 매핑된다 |
| 3 | 공공데이터 수집 (`api/transactions.js`) | 실거래 레코드가 정규화되어 반환된다 |
| 4 | 자연어 입력 파싱 (`api/parse-query.js`) | 문장 입력이 지역·예산으로 분해된다 |
| 5 | 통계 분석 + 결과 화면 | 중위값과 p25~p75 범위, 분포 차트가 보인다 |
| 6 | 주변지역 비교 + 예산 적합 지역 추천 | 인접 지역 시세 범위가 비교된다 |
| 7 | 매물 판정 화면 + 적정가 산출 | 적정가 범위와 매물 퍼센타일이 보인다 |
| 8 | 허위매물 리스크 스코어링 | 신호별 근거와 등급이 표시된다 |
| 9 | AI 설명·확인 질문 생성 | 쉬운 설명과 질문 리스트가 채워진다 |

**현재 위치: 1번(첫 화면)** — 이 단계가 사용자에게 확인될 때까지 2번으로 넘어가지 않는다.
