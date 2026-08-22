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
  // raw 1,290 → 1,293 KB (2026-08-21): 상단바 실시간 시계(`ClockLabel` +
  // `useWallClockSecond`). 실측 **raw +1.3 KB / gzip +0.4 KB**(시계만 빼고 빌드해
  // 대조: 1,289.8 → 1,291.1 KB). **gzip 은 그대로 389 KB** 로 둔다 — 388.8 로 아직
  // 안쪽이라 올릴 이유가 없고, 필요도 없는데 올리면 가드가 그만큼 눈이 먼다.
  // 넘긴 쪽이 raw 뿐인 이유는 직전 #1473(설정·보조지표 모달)이 raw 여유를 0.2 KB
  // 까지 써 버렸기 때문이다(시계 없이도 1,289.8/1,290). 새 헤드룸은 1.9 KB —
  // gzip 쪽과 같은 절대 여유다.
  //
  // raw 1,293 → 1,295 KB (2026-08-22): 당일 최대벽의 **이동평균선 필터**(매도는 MA 위,
  // 매수는 MA 아래 · `peakWallMaFilter` + 옵션 4개 + 소비처 셋의 배선). 실측 **raw
  // +2.2 KB / gzip +0.5 KB**(origin/main 단독 1,291.8 → 1,294.0). 설명문을 먼저 조여
  // 0.4 KB 를 걷었고(1,294.4 → 1,294.0), 남은 몫은 필터 판정과 pref 레지스트리 자체다.
  // **gzip 은 389 KB 안쪽(389.6/390)이라 올리지 않는다** — 필요 없는데 올리면 가드가
  // 그만큼 눈이 먼다. 그리고 **이 앱은 gzip 서빙을 하지 않는다**(`GZipMiddleware` 를
  // ADR-0154 에서 의도적으로 제거 — 단일 이벤트 루프라 압축이 도는 동안 앱 전체가
  // 멈춘다: 실측 압축 813ms 로 전송 9.3ms 를 아껴 87배 손해). 아래 `gzipBytes` 는
  // 「압축된다면」의 대리 지표이고 **사용자가 실제로 받는 것은 이 `rawBytes` 쪽**이라,
  // 둘 중 신중해야 하는 것은 raw 다. 지연 로드로 뺄 수 없다: 필터는 훅(`usePeakMaFilter`)이라 조건부
  // import 가 훅 규칙 위반이고, 판정은 차트 창이 뜨는 순간 필요하다.
  // 새 헤드룸 1.0 KB — 종전(main 1,291.8 / 예산 1,293)의 1.2 KB 와 같은 자릿수다.
  //
  // raw 1,295 → 1,297 KB (2026-08-22): 연필의 **서브-봉 해상도**(`Pencil.subX` +
  // `barPitchPx` + coalesced 포인터 캡처). 실측 **raw +1.2 KB / gzip +0.5 KB**
  // (이 브랜치 base 단독 1,293.9 / 389.6 → 1,295.1 / 390.1). 종전 헤드룸이 1.0 KB
  // 라 raw·gzip 이 함께 넘었다. **지연 로드로 뺄 수 없다** — 투영 보정은 렌더·
  // 히트테스트의 매 프레임 경로이고, 캡처는 pointerdown 즉시 필요하다. 깎아 볼
  // 여지도 없었다: 늘어난 것이 문자열이나 설정 표가 아니라 좌표 보정 산술과
  // 배열 하나라, 앞선 두 항목이 썼던 「설명문 조이기」 수법이 걸릴 데가 없다.
  // 새 헤드룸 1.9 KB.
  // raw 1,295 → 1,296 KB (2026-08-22): 최대벽 **분 극값 맵 증분 유지**(`touchesByWindow`
  // + 축출 시 닿은 분만 재계산)와 **MA 필터 SMA 메모**(WeakMap). 실측 내 몫 **raw +0.6 KB**
  // (detached origin/main 1,294.3 → 1,294.9). 성능 변경이라 코드가 느는 방향이고, 되받는
  // 것은 바이트가 아니라 틱 경로 시간이다 — 터치 22.5k 기준 1.21 → 0.72 ms/flush,
  // 90k 기준 2.56 → 0.73(터치 수와 무관하게 평평해진다).
  // 종전 상한은 여유가 0.1 KB 밖에 남지 않아 다음 PR 이 곧바로 막힌다. 새 헤드룸 1.1 KB —
  // 종전(main 1,291.8 / 예산 1,293)의 1.2 KB 와 같은 자릿수다.
  // ⚠ **gzip 은 389.9/390 으로 여유가 0.1 KB 뿐이다**(올리지 않았다 — 통과하므로).
  // 다음에 프론트를 늘리는 쪽은 gzip 에서 먼저 막힐 수 있다.
  //
  // **합류 (2026-08-22)**: 위 두 갈래(#1488 연필 서브-봉 · #1486 최대벽 증분화)가 각자
  // 자기 base 에서 통과한 뒤 합쳐졌다. 합류본 실측 **raw 1,296.7 / gzip 390.7** — 상한을
  // 올릴 필요는 없지만 **여유가 0.3 KB 로 좁다.** 파일이 겹치지 않아도 크기는 겹친다.
  // raw 1,296 → 1,298 KB (2026-08-22): 당일 최대벽의 **일봉 이동평균선 필터**
  // (`peakWallDailyMaFilter` + 옵션 4개 + 소비처 셋 배선). 실측 내 몫 **raw +2.5 KB**
  // (스택 base = #1486 head 1,294.9 → 1,297.4). 설명문을 먼저 조여 0.1 KB 를 걷었고,
  // 남은 몫은 필터·훅과 pref 레지스트리 자체다. 지연 로드로 뺄 수 없다(훅이고, 판정은
  // 차트 창이 뜨는 순간 필요하다). 새 헤드룸 0.6 KB.
  //
  // **합류 (2026-08-22)**: #1488(연필) · #1486(최대벽 증분화) · #1487(일봉 MA 필터)
  // 세 갈래가 합쳐졌다. 합류본 실측 **raw 1,299.2 / gzip 391.2**. 각자는 자기 base 에서
  // 통과했고 그 상한들(1,297·1,298) 은 **셋 다 합류본에 못 미친다** — 파일이 겹치지
  // 않아도 크기는 겹친다는 것이 이 파일의 요점이다. 헤드룸 0.8 KB.
  rawBytes: 1_300 * 1024,
  // 385 → 387 KB (2026-08-21): 고저 극값 **수평선 4종**(극값 고/저 · 이전일 고/저)과
  // 그 색·두께 설정(`CHART_LINE_STYLES` + `LineStyleRow`). 실측 +1.0 KB gzip 으로
  // 384.3 → 385.3 이 되어 종전 상한을 0.3 KB 넘겼다. 설정 화면은 초기 로드 청크라
  // 새 행이 곧 초기 바이트다. 문자열 중복(네 엔트리의 같은 설명 문장)을 조립으로
  // 걷어 raw 를 0.3 KB 줄여 봤지만 **gzip 은 그 반복을 이미 압축하고 있어 변화가
  // 없었다** — 남은 증가분은 기능 자체의 몫이라 판단해 상한을 올린다. 헤드룸을 다시
  // 약 0.4% 로 두어 다음 누적이 곧바로 잡히게 한다.
  //
  // 387 → 389 KB (2026-08-21): 얼린 저장뷰의 **분봉 구멍 보충**(`minuteGapFillPlan` +
  // `useMinuteGapFill`, #1468). 실측 gzip **+1.9 KB**(main 단독 385.3 → 387.2).
  // **지연 로드로 뺄 수 없다** — 보충은 훅이라 조건부 import 가 훅 규칙 위반이고,
  // 게이트(얼린 저장뷰 · 분봉 · KRX)는 런타임 값이라 정적 분할선이 안 된다.
  // 헤드룸을 다시 약 0.5% 로 둔다.
  //
  // 389 → 390 KB (2026-08-21): 같은 봉 창끼리의 **기간·줌 peer 동기화**
  // (`syncModeFor` + `replicatedRange` + 소비 훅의 모드 분기). 실측 gzip **+0.1 KB**
  // 로 종전 상한을 아슬하게 넘겼다 — 설정 설명문을 먼저 조여 0.2 → 0.1 KB 로 줄였고
  // (raw 는 1,291.9 → 1,291.6), 남은 몫은 판정 코드 자체라 더 깎을 여지가 없다.
  // 동기화 판정은 차트 창이 뜨는 순간 필요해 **지연 로드로 뺄 수 없다.**
  //
  // 390 → 391 KB (2026-08-22): 위 raw 항목과 같은 변경(연필 서브-봉 해상도).
  // 실측 gzip **+0.5 KB**(389.6 → 390.1). 새 헤드룸 0.9 KB.
  // 390 → 391 KB (2026-08-22): 같은 변경. 실측 gzip **+0.5 KB**(389.9 → 390.4). 종전
  // 상한의 여유가 0.1 KB 뿐이라 raw 를 올리는 것만으로는 통과하지 못한다 — 직전 PR 이
  // 그 사실을 같은 자리에 적어 두었고, 예고대로 gzip 에서 먼저 막혔다.
  //
  // 391 → 392 KB (2026-08-22): 위 raw 와 같은 합류. gzip 391.2 로 **양쪽 상한(391)을
  // 둘 다 넘었다** — raw 는 안쪽인데 gzip 만 넘는 것이 이 리포의 최근 반복 패턴이다.
  gzipBytes: 392 * 1024,
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
