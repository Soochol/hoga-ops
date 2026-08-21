/**
 * 초기 로드 가드의 **순수 규칙** — 파싱·판정·상수. **Node 내장 import 가 없다.**
 *
 * ## 이 파일이 따로 있는 이유 (지우고 합치지 말 것)
 *
 * 같은 파일에 `node:zlib`/`node:fs` 를 두면 이 모듈을 import 하는 **테스트 프로젝트가
 * 통째로 오염된다.** `tsconfig.test.json` 은 `src` 를 함께 include 하는데, 테스트가
 * Node 내장을 쓰는 모듈을 끌어오면 `@types/node` 가 프로그램에 들어오고, 그 순간
 * `src` 의 `setTimeout` 반환형이 `number` → `NodeJS.Timeout` 으로 바뀌어 **없던 오류가
 * 생긴다**(실측: `SignalAlertToastHost.tsx(77,5) TS2322`).
 *
 * 그 함정은 `tsconfig.test.json` 주석이 이미 경고하고 있었지만, 거기서 막은 것은
 * `types: ["node"]` 를 **직접 넣는** 경로였다. `types` 는 **자동 포함만** 제한하고
 * 명시적 import 로 끌려온 타입은 못 막는다 — 그래서 같은 함정에 새 경로로 도달했다.
 *
 * 규칙: **테스트가 import 하는 쪽에는 Node 내장을 두지 않는다.** I/O 는 `initialLoadBudget.ts`.
 */

/**
 * 초기 로드 상한. **측정 정의: `dist/index.html` 이 첫 화면에 요구하는 것 전부** —
 * entry script + `modulepreload` + stylesheet. **CSS 를 포함한다** — 종전 기준선
 * 「1071 KB」가 JS 전용이었고 나중 측정은 JS+CSS 라, 그 혼용이 「+159 KB 회귀」라는
 * 없는 사고를 만들었다(`initialLoadBudget.ts` 머리말 ②).
 *
 * 현재값(2026-08-17 실측): raw 1,253.6 KB / gzip 374.2 KB.
 * 헤드룸 약 3% — 기능 하나 추가에 바로 터지지 않으면서, 눈에 안 띄는 누적은 잡는 폭이다.
 *
 * **올릴 때는 이유를 한 줄 적는다.** 조용히 올리면 이 장치가 애초에 막으려던 것
 * (초기 로드가 아무도 모르게 커지는 것)을 그대로 재현한다.
 */
export const INITIAL_LOAD_BUDGET = {
  rawBytes: 1_290 * 1024,
  // 385 → 387 KB (2026-08-21): 고저 극값 **수평선 4종**(극값 고/저 · 이전일 고/저)과
  // 그 색·두께 설정(`CHART_LINE_STYLES` + `LineStyleRow`). 실측 +1.0 KB gzip 으로
  // 384.3 → 385.3 이 되어 종전 상한을 0.3 KB 넘겼다. 설정 화면은 초기 로드 청크라
  // 새 행이 곧 초기 바이트다. 문자열 중복(네 엔트리의 같은 설명 문장)을 조립으로
  // 걷어 raw 를 0.3 KB 줄여 봤지만 **gzip 은 그 반복을 이미 압축하고 있어 변화가
  // 없었다** — 남은 증가분은 기능 자체의 몫이라 판단해 상한을 올린다. 헤드룸을 다시
  // 약 0.4% 로 두어 다음 누적이 곧바로 잡히게 한다.
  gzipBytes: 387 * 1024,
} as const;

/**
 * 청크 소속 규칙. **크기가 아니라 소속을 잰다** — 위 ③ 의 판별식이 크기였다면
 * "184 B 짜리 react 청크" 를 정상으로 읽었을 것이다(작아진 건 좋은 일처럼 보인다).
 *
 * 마커는 각 라이브러리의 **프로덕션 빌드에 실제로 남는 문자열**이다. 라이브러리를
 * 올리다 마커가 사라지면 `missing` 위반으로 잡히니, 조용히 무력화되지 않는다.
 */
export const ATTRIBUTION_RULES: readonly AttributionRule[] = [
  { marker: 'Minified React error', chunk: 'react', label: 'react-dom' },
  { marker: 'useHref() may be used only in the context', chunk: 'router', label: 'react-router' },
];

export interface AttributionRule {
  /** 프로덕션 번들에 남는 라이브러리 고유 문자열. */
  marker: string;
  /** 이 마커가 있어야 하는 청크의 파일명 접두(해시 앞부분). */
  chunk: string;
  /** 실패 메시지용 이름. */
  label: string;
}

/**
 * `index.html` 에서 **초기 로드 자산 경로**를 뽑는다(순수 — 빌드 없이 테스트된다).
 *
 * 대상은 셋이다: `<script src>`, `<link rel=modulepreload href>`, `<link rel=stylesheet href>`.
 * `rel` 을 보지 않고 `/assets/` 로 시작하는 href 를 전부 걷는 이유는, 첫 화면이
 * 실제로 요구하는 것이 그것이기 때문이다 — prefetch(있다면)는 첫 화면 비용이 아니지만
 * 이 앱은 쓰지 않는다. 쓰게 되면 여기서 갈라야 한다.
 */
export function parseInitialLoadAssets(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/(?:href|src)="\/(assets\/[^"]+)"/g)) {
    out.add(m[1]);
  }
  return [...out].sort();
}

/**
 * 마커가 **기대한 청크에만** 있는지. 위반 목록을 돌려준다(빈 배열 = 통과).
 *
 * 두 방향을 다 본다:
 *   - 기대 청크에 **없음** → 규칙이 죽었거나 라이브러리 마커가 바뀌었다.
 *   - 다른 청크에 **있음** → 분할이 무너져 벤더가 앱 청크로 흘렀다.
 * 한쪽만 보면 ③ 을 놓친다(react 청크가 비고 dnd 청크에 들어간 것이 정확히 그 모양).
 */
export function checkAttribution(
  files: readonly { file: string; text: string }[],
  rules: readonly AttributionRule[],
): string[] {
  const violations: string[] = [];
  for (const rule of rules) {
    const hits = files.filter((f) => f.text.includes(rule.marker)).map((f) => f.file);
    const expected = hits.filter((f) => chunkNameOf(f) === rule.chunk);
    const strays = hits.filter((f) => chunkNameOf(f) !== rule.chunk);
    if (expected.length === 0) {
      violations.push(
        `${rule.label}: '${rule.chunk}' 청크에 없다`
        + (hits.length ? ` (대신 ${hits.join(', ')})` : ' — 마커가 사라졌거나 분할 규칙이 죽었다'),
      );
    }
    if (strays.length > 0) {
      violations.push(`${rule.label}: '${rule.chunk}' 밖에도 있다 — ${strays.join(', ')}`);
    }
  }
  return violations;
}

/** `assets/react-CvBZlOBd.js` → `react`. 해시는 `-` 뒤 마지막 조각이다. */
export function chunkNameOf(file: string): string {
  const base = file.split('/').pop() ?? file;
  return base.replace(/\.js$/, '').replace(/-[^-]+$/, '');
}
