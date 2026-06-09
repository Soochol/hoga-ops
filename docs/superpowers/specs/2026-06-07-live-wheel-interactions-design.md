# /live 차트 휠 인터랙션 (Modifier-Aware Zoom & Pan 배선) — Design

**Date**: 2026-06-07
**Status**: Approved
**Scope**: `frontend/src/live/useWheelInteractions.ts` (신규), `frontend/src/live/useWheelInteractions.test.tsx` (신규), `frontend/src/live/LiveChartRoot.tsx`, `frontend/src/live/LiveChartRoot.test.tsx` (배선 회귀 추가), `frontend/src/util/wheelInteractions.ts` (무변경 재사용)

## Problem

`/live` 차트의 마우스 휠 동작은 `lightweight-charts` 기본값 그대로다: 휠은 항상
마우스 위치 고정 줌이고, 휠로 팬할 방법이 없다. 사용자 요청:

> 1. 마우스 휠 + - → 현재 가장 최근 캔들(차트 오른쪽)을 고정으로 두고 줌인 줌아웃
> 2. ctrl + 마우스 휠 + - → 현재 마우스 커서 위치를 고정으로 줌인 줌아웃
> 3. shift + 마우스 휠 + - → 줌인 줌아웃하지 말고, x축 이동

이 세 분기는 리플레이 차트 시절 두 스펙
([2026-05-24-replay-mouse-interactions-design.md](2026-05-24-replay-mouse-interactions-design.md),
[2026-05-24-replay-wheel-right-wall-design.md](2026-05-24-replay-wheel-right-wall-design.md))으로
설계·구현·필드테스트까지 끝났고, 순수 함수
[`computeWheelOutcome`](../../../frontend/src/util/wheelInteractions.ts)와 단위 테스트
22케이스가 그대로 남아 있다. 그러나 호스트였던 `ChartStage.tsx`(리플레이 차트)가
삭제되면서 **호출처가 0곳인 고아 코드**가 됐다. 이 spec은 그 검증된 로직을
`/live`의 `LiveChartRoot`에 배선한다. 동작 수식은 재설계하지 않는다.

## 결정 사항 (brainstorming GATE)

brainstorming 대화에서 확정한 결정들:

1. **plain wheel 앵커 = 뷰포트 오른쪽 끝(`range.to`)** ("항상 최신 캔들" 안 기각).
   라이브 엣지에 있을 때는 최신 캔들 고정과 사실상 동일하고(최신 캔들은
   rightOffset 패딩 안에 있어 줌마다 패딩 픽셀 폭이 변하는 ±수 px 이동은 정상),
   과거 구간으로 스크롤한
   상태에서는 보던 구간의 오른쪽 끝이 고정된다 — 뷰가 "지금"으로 끌려가지 않음.
   기존 스펙(2026-05-24)과 같은 해석.
   **개정 (2026-06-08, v0.7.0.1 — 결정 #11 참조)**: "±수 px"는 사실 ±수십 px이었다.
   줌인 시 패딩(rightOffset 15칸)이 화면에서 차지하는 픽셀이 커지며 최신 캔들이
   왼쪽으로 눈에 띄게 밀렸다(사용자 보고: "줌인하면 마지막 캔들 앵커가 풀려").
   plain wheel 앵커를 `min(to, lastBarIndex)`로 변경 — 라이브 엣지에서는 마지막
   캔들 고정(줌인·줌아웃 양쪽 픽셀 고정), 과거 스크롤 시에는 여전히 `to` 고정
   (이 결정의 원래 의도 유지). 브라우저 검증: 마지막 캔들 픽셀 407→404.9(서브픽셀).
2. **오른쪽 벽 = 마지막 캔들에서 타이트** (`maxTo = bundle.candles.length - 1`).
   "/live 기본 뷰의 rightOffset 15칸 패딩 위치까지(+15)" 안은 기각 — 리플레이 때
   사용자가 직접 요청했던 동작("마지막 캔들이 보일때까지")이자 현재 헬퍼
   코드·테스트가 검증하는 상태를 그대로 쓴다.
   **개정 (2026-06-08, v0.6.5.1)**: v0.6.4.0 필드 사용 후 사용자가 +15 버퍼안으로
   전환 결정 — `maxTo = candles.length - 1 + rightOffset`. shift 팬으로 라이브
   엣지에 복귀하면 기본 뷰(우측 여백 포함)와 정확히 같은 화면에서 멈추고, 첫
   틱의 패딩 스냅 회수도 사라진다. right-wall 스펙(2026-05-24)이 예고했던 바로
   그 한 줄 전환.
   **재개정 (2026-06-08, v0.7.0.1 — 결정 #11)**: 인덱스 공급원을
   `candles.length - 1`에서 이벤트 시점 `ts.timeToIndex(마지막 캔들 virtual time)`로
   교체. `candles.length - 1`은 공유 timeScale의 합집합 인덱스보다 ~273칸 작아
   (호가 페인 skew) shift 벽이 마지막 캔들 한참 오른쪽 빈 공간에서 멈추던 것을
   정상화. `maxTo = trueLast + rightOffset` (정의: 마지막 *캔들* + 여백; 장 마감 후
   호가 꼬리가 캔들 뒤로 이어지면 벽이 기본 뷰보다 꼬리 길이만큼 오른쪽 — 라이브
   중엔 0, 빈 공간이라 무해).
3. **배선 = 전용 훅 `useWheelInteractions`** (LiveChartRoot 인라인 effect 안 기각).
   `useViewportBackfill`·`useLiveKeyboard`와 같은 훅 분리 패턴을 따르고, 576줄짜리
   `LiveChartRoot`를 더 키우지 않는다.
4. **`maxTo`는 ref로 관리, 휠 리스너는 chart당 1회 부착** (리플레이 스펙의
   `[chart, bundle]` 의존 재부착 안은 /live에 부적합 — /live는 SSE 푸시마다
   bundle이 교체되므로 초 단위 리스너 churn이 생긴다).

grill 리뷰(스펙 심문)에서 추가 확정:

5. **줌인 UX 캡 없음** — lwc 5.2가 줌인을 내장 `maxBarSpacing` 상한(옵션 미설정
   시 차트 폭의 절반)으로 이미 클램프하므로 발산 위험이 없고, "캔들 최대 50px"
   류의 UX 캡(`timeScale: { maxBarSpacing: 50 }` 한 줄)은 달지 않는다 — 현행
   /live 동작과의 파리티 우선.
6. **D/W/M 파리티 수용** — 백필 분봉 한정·초기 일봉 확장의 fitContent 1회 스냅
   특성(아래 엣지 케이스)을 이번 범위에서 고치지 않는다.
7. **Live Edge·Right Wall 용어를 CONTEXT.md에 등재** — 스펙 3건과 코드 주석에서
   반복 사용되는 개념의 정식화.

/ship 적대 리뷰(2026-06-08)에서 추가 확정:

8. **deltaMode 정규화 추가** — lwc의 휠 핸들러는 Firefox의 LINE 단위
   deltaY(노치당 ±3)를 ×32로, PAGE를 ×120으로 환산한다
   (`_determineWheelSpeedAdjustment` — 1차 소스 확인). 이를 끄고 raw deltaY를
   쓰면 Firefox에서 줌이 ~35배 약해지는 회귀이므로 훅에서 동일 환산표를
   적용한다. lwc의 Windows-Chromium DPR 보정(해당 플랫폼 한정 버그
   워크어라운드)과 per-event 캡(승인된 exp 커브와 다른 느낌)은 채택하지 않음.
9. **휠 핸들러 try/catch 가드** — 현재는 effect 선언 순서상 리스너가
   `c.remove()`보다 먼저 해제되어 도달 불가지만, 레포의 다른 lwc viewport
   호출부 컨벤션과 정합하도록 핸들러 본문을 try/catch로 감싼다(향후 훅 순서
   리팩토링 내성).

/diagnose(2026-06-08, v0.6.5.3)에서 추가 확정:

10. **줌아웃 플로어 maxSpan 클램프** — lwc는 `barSpacing < minBarSpacing`이
    되는 줌 요청의 span을 거부하면서 오른쪽 끝(rightOffset)만 적용한다.
    무클램프 ctrl 줌아웃이 플로어에 도달하면 요청이 **우측 팬으로 변질**되어
    커서 앵커가 풀리는 버그가 필드에서 발견됨(브라우저 루프로 재현: 틱당
    +18바 드리프트, span 고정, dTo=0 — 플로어 수학 `width()/minBarSpacing`과
    정확히 일치). 수정: 헬퍼에 `maxSpan` 선택 입력을 추가하고, 줌 분기 결과
    span이 maxSpan을 넘으면 **앵커 비율을 보존한 채** span을 클램프(ctrl:
    앵커 기준 재계산, plain: `to` 고정 유지). 훅은 이벤트 시점에
    `ts.width() / options().timeScale.minBarSpacing`을 전달(리사이즈 대응).
    플로어에서 줌아웃은 깨끗한 no-op이 된다. shift 팬은 span 불변이라 무관.

추가 개선(2026-06-08, v0.7.0.1):

11. **plain wheel 마지막 캔들 앵커 + trueLast(timeToIndex) 인덱스 공급** — 두 건을
    한 번에. ① plain wheel 앵커를 `range.to`(우측 패딩 끝)에서
    `min(to, lastBarIndex)`로 변경 — 줌인 시 패딩 픽셀 확대로 마지막 캔들이
    왼쪽으로 밀리던 회귀(사용자 보고) 해소, 라이브 엣지에서 줌인·줌아웃 모두
    마지막 캔들 픽셀 고정(브라우저: 407→404.9 서브픽셀), 과거 스크롤 시 `to` 고정은
    유지(결정 #1). ② 마지막 캔들 인덱스를 `candles.length - 1`이 아니라 이벤트 시점
    `ts.timeToIndex(axis.toVirtual(마지막 캔들 ts_ms)/1000, true)`로 구함 —
    공유 timeScale 합집합 인덱스가 호가 페인 때문에 candles 배열보다 ~273칸 크던
    skew(결정 #2 재개정·아래 엣지 케이스의 backlog 항목)를 닫음. 이 trueLast를
    plain 앵커와 shift 벽(`maxTo`) 양쪽에 공급. useViewportBackfill의 변환과 동일
    패턴, staleness-free. 헬퍼는 `lastBarIndex?` 선택 입력만 추가(분기 수식 불변).

## Invariants

- **Mouse-anchor ratio preservation (ctrl/cmd 줌)**: 줌 전후로 앵커의 화면 비율
  `p = (anchor − from)/(to − from)`이 보존된다 — 마우스 아래 캔들이 같은 픽셀에
  머무른다. 근거: [wheelInteractions.ts](../../../frontend/src/util/wheelInteractions.ts)
  ctrl 분기(클램프 없음 — 2026-05-28 right-wall spec 업데이트에서 확정).
- **Latest-candle pin (plain wheel)**: plain wheel 줌은 라이브 엣지에서 마지막
  캔들의 화면 픽셀을 고정한다(앵커 = `min(to, lastBarIndex)`). 과거 스크롤
  상태(`to < lastBarIndex`)에서는 `to`(우측 끝)를 고정한다. 근거: 같은 파일
  default 분기(결정 #11 — 이전에는 무조건 `to` 고정이었고 줌인 시 캔들이 밀렸다).
- **Pan span preservation (shift)**: shift 팬은 `to − from`을 바꾸지 않는다 — 벽에
  막혀도 스팬은 유지(`{ from: maxTo - span, to: maxTo }`). 근거: 같은 파일 shift 분기.
- **Right wall (shift 한정)**: shift 오른쪽 팬은 `to`를 `maxTo`(마지막 캔들
  인덱스 + rightOffset — 기본 라이브 뷰의 우측 여백 위치, 결정 #2 개정) 너머로
  밀지 않는다. shift+휠이 `deltaY`로 도착하는 플랫폼 기준 — 검증된 환경은
  전부 해당하며, `deltaX`로 스왑하는 플랫폼에서는 라이브러리 deltaX 팬(벽 없음)이
  이벤트를 소유한다(Risks 참조). 근거: [2026-05-24-replay-wheel-right-wall-design.md](2026-05-24-replay-wheel-right-wall-design.md).
- **초기 뷰 1회 적용**: 분봉 300-bar 윈도우 + `scrollToPosition(0)`은
  (code, timeframe)당 1회만 실행된다(`lastAppliedCountRef` 게이트) — SSE 푸시가
  사용자 스크롤을 스냅하지 않는다. 근거:
  [LiveChartRoot.tsx](../../../frontend/src/live/LiveChartRoot.tsx) 초기 뷰 effect.
- **백필 트리거·repositioner 계약**: 뷰포트의 `from < 0` 진입이
  `subscribeVisibleLogicalRangeChange` 경유로 과거 청크 fetch를 트리거하고,
  repositioner는 `historicalFromDate !== null`이고 실제 leftward prepend가 일어난
  commit에서만 뷰포트를 소유한다. 근거:
  [useViewportBackfill.ts](../../../frontend/src/live/useViewportBackfill.ts).
- **데이터가 로드된 차트 위 휠은 페이지를 스크롤하지 않는다**: 현재도 라이브러리
  휠 핸들러가 이벤트를 소비한다. 근거: lightweight-charts 기본
  `handleScale.mouseWheel: true`. 로드 전 빈 차트는 invariant 범위 밖(엣지 케이스
  참조 — 의도적으로 페이지 스크롤을 허용).

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| Mouse-anchor ratio preservation | preserves | ctrl 분기 무클램프 (단 maxSpan 플로어에서는 비율 보존 클램프 — 결정 #10) |
| Latest-candle pin (plain wheel) | intentionally changes | 결정 #11 — `to`-고정 → `min(to, lastBarIndex)`. 줌인 캔들 드리프트(사용자 보고) 해소; 과거 스크롤 시 `to` 고정은 유지 |
| Pan span preservation (shift) | preserves | 헬퍼 shift 분기 수식 무변경 |
| Right wall (shift 한정) | preserves | `maxTo` 공급원이 `candles.length-1`→`timeToIndex` trueLast로 정밀화(결정 #11). deltaY 도착 플랫폼 조건부(위 invariant 정의 참조) |
| 초기 뷰 1회 적용 | preserves | 휠은 `lastAppliedCountRef`를 건드리지 않음 — 초기 뷰 effect 재실행 조건과 무관 |
| 백필 트리거·repositioner 계약 | preserves | 휠의 `setVisibleLogicalRange`는 현재 라이브러리 휠 줌과 같은 구독 경로를 탄다 — 동작 동등성, 새 경로 없음 |
| 데이터 로드된 차트 위 휠 페이지 스크롤 차단 | preserves | 라이브러리 핸들러 대신 우리 핸들러가 `preventDefault()`. 로드 전 구간은 invariant 정의상 범위 밖 — 빈 차트가 페이지 스크롤을 막지 않는 것이 의도된 UX |

## Goals

- 세 가지 휠 동작이 `/live` 차트(전 페인 공유 timeScale)에서 동작한다.
- `computeWheelOutcome`과 그 테스트 22케이스를 무변경 재사용한다.
  *(개정 v0.6.5.3·v0.7.0.1: 헬퍼에 선택 입력 `maxSpan`(#10)·`lastBarIndex`(#11)가
  추가됨. "무변경 재사용"은 최초 출하 시점의 목표였고, 이후 헬퍼는 이 기능의
  살아있는 소유 코드로서 진화한다. 분기 수식과 기존 22케이스는 여전히 무변경.)*
- 휠 리스너는 chart 인스턴스당 1회 부착 — SSE 푸시(bundle 교체)에 재부착하지 않는다.
- 기존 뷰포트 시스템(초기 뷰, 백필, repositioner)과 새 경로 없이 통합된다.
- 데이터가 로드된 차트 위에서 휠·shift+휠이 페이지를 스크롤시키지 않는다
  (로드 전 빈 차트는 의도적 예외 — 엣지 케이스 참조).

## Non-Goals

- **동작 수식 변경 없음** — 줌 커브(`Math.exp(deltaY * 0.001)`), 팬 스텝(스팬의
  10%/notch), 분기 우선순위(shift > ctrl)는 이전 스펙 그대로.
- 터치/핀치 제스처 변경 없음 — `handleScale.pinch` 기본값 유지.
- 드래그 팬 변경 없음 — `handleScroll` 기본값 유지(트랙패드 가로 스와이프 deltaX
  팬 포함).
- 수직(가격축) 휠 스크롤 없음.
- modifier 매핑 사용자 설정 없음.
- 줌인 캡(barSpacing 상한) 추가 없음 — 리플레이 ChartStage에 있던 `barSpacing > 50`
  캡은 /live에 원래 없고, 이번 범위에도 넣지 않는다(grill 결정 #5). 극단 줌은
  양방향 모두 라이브러리가 받친다: 줌아웃은 `minBarSpacing`, 줌인은 내장
  `maxBarSpacing` 상한(옵션 미설정 시 차트 폭의 절반)으로 클램프되어 발산하지
  않는다 (lwc 5.2 `_private__correctBarSpacing` 확인).
- `useViewportBackfill`·초기 뷰 effect 로직 변경 없음.

## Design

### 동작 명세 (이전 스펙 승계)

| 입력 | 동작 | 오른쪽 벽 |
|---|---|---|
| 휠 | `min(to, lastBarIndex)` 고정 줌 (라이브 엣지=마지막 캔들, 과거=`to`; 결정 #11) | 없음 (앵커 불변식 우선) |
| Shift+휠 | 스팬 유지 팬 (스팬의 10% × `sign(deltaY)`) | `to ≤ maxTo`(마지막 캔들 + rightOffset) 클램프, 스팬 보존 |
| Ctrl/Cmd+휠 | `coordinateToLogical(mouseX)` 고정 줌 (null이면 `to` 폴백) | 없음 (앵커 불변식 우선) |

`factor = Math.exp(deltaY * 0.001)`. Shift+Ctrl 동시 입력은 shift 우선(팬).
트랙패드 핀치는 브라우저가 `ctrlKey: true`인 wheel 이벤트로 합성하므로 자동으로
ctrl 분기(커서 고정 줌)를 탄다 — 의도된 동작.

### 신규 훅 — `frontend/src/live/useWheelInteractions.ts`

```ts
export function useWheelInteractions(
  chart: IChartApi | null,
  containerRef: RefObject<HTMLDivElement | null>,
  bundle: RangeBundle | null,
  axis: VirtualAxis,
): void;
```

내부 구조:

```ts
// 1. 마지막 캔들 ms + 현재 axis를 ref로 — 이벤트 시점에 합집합 논리 인덱스
//    (trueLast)로 변환한다(결정 #11). candles.length-1은 호가 페인 skew로
//    실제 인덱스보다 작다. ref인 이유: bundle/axis를 리스너 deps에 넣으면
//    SSE 푸시마다 리스너가 재부착됨.
const lastMsRef = useRef<number | undefined>(undefined);
const axisRef = useRef<VirtualAxis>(axis);
useEffect(() => {
  lastMsRef.current =
    bundle && bundle.candles.length > 0
      ? bundle.candles[bundle.candles.length - 1].ts_ms
      : undefined;
}, [bundle]);
useEffect(() => { axisRef.current = axis; }, [axis]);

// 이벤트 시점:
//   const lastMs = lastMsRef.current, ax = axisRef.current;
//   let lastBarIndex; // undefined면 헬퍼가 plain=to-고정, shift=Infinity로 폴백
//   if (lastMs != null && ax.segments.length > 0) {
//     const vt = Math.round(ax.toVirtual(lastMs) / 1000);
//     const idx = ts.timeToIndex(vt, true);
//     if (Number.isFinite(idx)) lastBarIndex = idx;       // = trueLast
//   }
//   const maxTo = lastBarIndex != null
//     ? lastBarIndex + (CHART_TIMESCALE_OPTIONS.rightOffset ?? 0)
//     : Number.POSITIVE_INFINITY;

// 2. 휠 리스너 — chart당 1회 부착
useEffect(() => {
  const container = containerRef.current;
  if (!chart || !container) return;
  const ts = chart.timeScale();

  const onWheel = (e: WheelEvent) => {
    try {                          // 결정 #9 — teardown 경합 관례 가드
      const range = ts.getVisibleLogicalRange();
      if (!range) return;          // 데이터 로드 전 — 페이지 스크롤 방해 금지
      e.preventDefault();          // 페이지 스크롤/브라우저 줌 차단
      // 결정 #8 — deltaMode 정규화 (Firefox LINE ×32, PAGE ×120)
      const unit =
        e.deltaMode === e.DOM_DELTA_LINE ? 32
        : e.deltaMode === e.DOM_DELTA_PAGE ? 120
        : 1;
      const rect = container.getBoundingClientRect();
      // maxSpan(결정 #10): 줌아웃 플로어 = width()/minBarSpacing.
      // lastBarIndex·maxTo(결정 #11): 위 "이벤트 시점" 블록의 trueLast 변환.
      const outcome = computeWheelOutcome({
        range,
        deltaY: e.deltaY * unit,
        shiftKey: e.shiftKey,
        ctrlOrMetaKey: e.ctrlKey || e.metaKey,
        mouseX: e.clientX - rect.left,
        coordinateToLogical: (x) => ts.coordinateToLogical(x),
        maxTo,                 // trueLast + rightOffset (또는 Infinity)
        lastBarIndex,          // trueLast (또는 undefined → to-고정 폴백)
        maxSpan: ts.width() > 0 && minBarSpacing > 0
          ? ts.width() / minBarSpacing : Number.POSITIVE_INFINITY,
      });
      if (outcome) ts.setVisibleLogicalRange(outcome);
    } catch {
      // chart torn down between effect runs — 무시
    }
  };

  container.addEventListener('wheel', onWheel, { passive: false });
  return () => container.removeEventListener('wheel', onWheel);
}, [chart, containerRef]);
```

- `{ passive: false }` 필수 — shift+휠을 브라우저가 가로 페이지 스크롤로
  처리하는 것을 `preventDefault()`로 막아야 한다.
- 이벤트 시점에 `lastMsRef`/`axisRef`를 읽어 trueLast를 계산하므로 stale-closure
  없음(prepend 후에도 현재 axis로 재변환). 리플레이 스펙의 `[chart, bundle]`
  재부착과 결과는 동등하고, /live의 초 단위 bundle 교체에서 리스너 churn만
  제거된다.
- `containerRef.current`는 effect 실행 시점 캡처 — `LiveChartRoot`의 container
  `<div>`는 컴포넌트 수명 동안 동일 엘리먼트이고, chart 생성 effect(빈 deps)와
  같은 수명이므로 안전.
- deps의 `containerRef`는 `react-hooks/exhaustive-deps` 충족용(prop으로 받은
  ref는 룰이 ref로 인식하지 못함; 레포 선례 `useDrawingHost`) — ref identity가
  안정적이라 재부착을 유발하지 않으며 "chart당 1회 부착" 결정은 그대로 성립.

### `LiveChartRoot.tsx` 변경 (2곳)

1. `createChartEx` 옵션에 추가:

   ```ts
   handleScale: { mouseWheel: false },
   ```

   라이브러리 내장 휠 줌 제거 — 이전 스펙이 기각한 "이중 소유권"(우리 핸들러와
   라이브러리 핸들러가 같은 이벤트에서 visible range를 다투는 레이스) 방지.
   `handleScale`의 나머지 sub-option(`pinch`, `axisPressedMouseMove`,
   `axisDoubleClickReset`)과 `handleScroll` 전체는 기본값 유지.

2. 컴포넌트 본문에 훅 호출 추가:

   ```ts
   useWheelInteractions(chart, containerRef, bundle);
   ```

### 기존 시스템과의 통합

- **뷰포트 백필**: 줌아웃/좌측 팬으로 `from < 0` 진입 시 기존
  `subscribeVisibleLogicalRangeChange` 구독(150ms 디바운스)이 그대로 발화해 과거
  청크를 fetch한다. 현재 라이브러리 휠 줌도 정확히 같은 경로를 타므로 **동작
  동등성** — 새 위험 계층이 없다. prepend 직후 repositioner가 스냅샷 기반으로
  뷰포트를 재고정하는 한 프레임과 연속 휠 입력이 겹칠 수 있으나, 이는 현재
  라이브러리 줌에서도 동일한 기존 특성이다 (브라우저 수동 검증 항목 #5).
- **초기 뷰 effect**: 분봉은 `lastAppliedCountRef` 게이트로 (code, timeframe)당
  1회, D/W/M은 bar-count가 직전 적용 시점보다 늘어날 때만 `fitContent()` 재적용 —
  어느 쪽도 휠 입력으로는 재트리거되지 않는다(휠은 캔들 수를 바꾸지 않음).
- **키보드 단축키**(`useLiveKeyboard`): modifier가 눌리면 bail
  (`if (e.metaKey || e.ctrlKey || e.altKey) return`) — ctrl+휠과 충돌 없음.
  shift는 bail 목록에 없지만 j/k/w/Esc는 wheel 이벤트와 무관.
- **크로스헤어·커서 스토어**: `subscribeCrosshairMove`(마우스 이동) 구독 — 휠과
  무관, 변경 없음.
- **멀티 페인**: 캔들·거래량·호가 페인 전부 단일 chart의 공유 timeScale을 쓰므로
  `setVisibleLogicalRange` 한 번에 전 페인이 동기 이동 — 별도 동기화 불필요.

### 엣지 케이스

- **빈 bundle / 로드 전**: `maxTo = Infinity`(벽 비활성),
  `getVisibleLogicalRange() === null`이면 `preventDefault` 없이 무시 — 페이지
  스크롤 정상 동작.
- **차트 위 ctrl+휠 = 브라우저 페이지 줌 차단**: `preventDefault()`가 막는다.
  현재 라이브러리 동작과 동일하며 의도됨 (차트 줌이 페이지 줌보다 우선).
- **`deltaY === 0`** (가로 전용 트랙패드 스와이프 등): plain 분기는
  `factor = 1`로 범위 무변경 반환, shift 분기는 `null` — 어느 쪽도 시각적 변화
  없음. deltaX 팬은 라이브러리 `handleScroll.mouseWheel`(기본 on)이 처리.
- **~~`maxTo` 인덱스 오차 (양방향)~~ — 해결됨 (v0.7.0.1, 결정 #11)**: 공유
  timeScale의 논리 인덱스는 전 페인 시리즈 time point의 합집합 기준이라
  `candles.length − 1`이 실제 마지막 캔들 인덱스와 어긋났다(관측: 호가 페인이
  캔들 없는 분에 점을 추가해 ~273칸). 이 skew가 plain 앵커(마지막 캔들이 화면
  왼쪽으로 밀림)에서 크게 드러나 backlog를 앞당겨 닫음 — 인덱스를 이벤트 시점
  `ts.timeToIndex(axis.toVirtual(마지막 캔들 ts_ms)/1000, true)`로 구해 plain
  앵커·shift 벽 양쪽에 공급. 잔여: 장 마감 후 호가 꼬리가 마지막 캔들 뒤로
  이어지면 wall(=캔들+rightOffset)이 기본 뷰보다 꼬리 길이만큼 오른쪽 — 빈
  공간이라 무해하고 라이브 중엔 0.
- **가격축 스트립 위 ctrl+휠**: 커서가 오른쪽 가격축 위에 있으면
  `coordinateToLogical`이 페인 폭 밖 x를 선형 외삽해 앵커가 `range.to`보다 몇 칸
  바깥에 잡힌다(라이브러리 내장 줌은 페인 안으로 클램프했음). 필드테스트된
  리플레이 ChartStage와 동일 배선에서 허용된 오차 — 클램프를 추가하지 않는다.
- **deltaMode 정규화 (Firefox 등)**: 훅이 LINE(×32)/PAGE(×120) 단위 deltaY를
  픽셀 상당으로 환산한다 — 우리가 끈 lwc 핸들러와 동일 환산표 (결정 #8).
  Windows-Chromium의 DPR 과대 deltaY(Chromium 버그 1001735)는 보정하지 않음 —
  해당 플랫폼에서 줌이 DPR배 빠르게 느껴지면 후속으로 lwc의
  `1/devicePixelRatio` 보정을 이식한다.
- **shift+휠이 `deltaX`로 오는 플랫폼**: 이전 스펙의 결정 승계 — `deltaY` 단일
  소스를 유지하고, 특정 플랫폼에서 shift+휠이 죽는 것이 확인되면 그때 `deltaX`
  폴백을 추가한다(선제 대응 안 함). 해당 케이스에서도 라이브러리 deltaX 팬(벽
  없음)이 동작하므로 완전히 죽지는 않는다. 폴백 추가 시의 제약은 Risks 참조.
- **D/W/M (캘린더 타임프레임)**: 휠 세 분기는 동일하게 동작한다. 기존 특성 두
  가지(grill 결정 #6 — 파리티 수용, 이번 범위에서 고치지 않음): ① 백필의 from<0
  트리거는 D/W/M에서도 발화하지만(one-shot, D=350일/W=840일/M=3720일 청크 —
  `useViewportBackfill.ts` 3b), 다단계 진행 루프(스텝 2..N 자가 dispatch)는 분봉
  한정이다(같은 파일 3a의 `isMinuteTimeframe` 게이트). ② `historicalFromDate`가
  아직 null인 초기 구간에서 일봉 확장(14→~250개)이 도착하면 D/W/M 분기의
  `fitContent()` 재적용이 그 사이 휠로 만든 뷰포트를 1회 스냅할 수 있다 — 사용자가
  왼쪽 끝을 넘어 `historicalFromDate`가 non-null이 되면 초기 뷰 effect가
  short-circuit하므로 그 이후에는 스냅이 없다. 둘 다 현재 라이브러리 줌과 동일한
  기존 특성이다.
- **오버레이 위 휠**: 차트 위 오버레이는 기본 `pointer-events: none`이고
  DrawingOverlay만 도구 활성/드로잉 히트 시 `auto`로 전환되는데, 그 순간의 휠은
  우리 리스너와 라이브러리 리스너(둘 다 `containerRef` 내부)를 **동등하게**
  비켜간다 — 정확한 파리티, 별도 처리 없음.

## Testing

### Unit tests

**기존**: `frontend/src/util/wheelInteractions.test.ts` 22케이스 — 무변경으로 전부
통과해야 한다 (헬퍼를 건드리지 않았다는 증거).

**신규**: `frontend/src/live/useWheelInteractions.test.tsx` —
`LiveChartRoot.test.tsx`의 lightweight-charts mock 패턴 재사용.

공통 Setup: range mock `{0,100}`, `bundle = null`(→ `maxTo = Infinity`, shift
클램프 미발동), 이벤트는 `new WheelEvent('wheel', { cancelable: true, ... })`로
dispatch(기본 `cancelable: false`면 `preventDefault()`가 no-op이라 단언 불가).
행별 Setup은 공통과의 차이만 적는다.

| Case | Setup | Expected |
|------|-------|----------|
| plain wheel 줌 | `deltaY=100` | `setVisibleLogicalRange` 호출, `to=100` 유지·`from<0` |
| ctrl wheel 줌 | `deltaY=100, ctrlKey`, anchor mock=50 | 양변이 50 기준 확장 |
| shift wheel 팬 | `deltaY=100, shiftKey` | `{from:10, to:110}` (스팬 유지) |
| preventDefault | range 존재 | `e.defaultPrevented === true` |
| 로드 전 no-op | `getVisibleLogicalRange → null` | `setVisibleLogicalRange` 미호출, `defaultPrevented === false` |
| 리스너 해제 | unmount | `removeEventListener` 호출 |
| maxTo ref 갱신 | candles 100개 bundle로 rerender 후 50개 bundle로 교체, `deltaY=100, shiftKey` dispatch | `setVisibleLogicalRange({from:-36, to:64})` — `to=64`(=49+rightOffset 15; 교체 전 114가 스테일하면 클램프 미발동 {10,110}으로 실패), `addEventListener`는 rerender 전후 합산 1회 |

**Invariant 회귀 테스트**: anchor ratio·right-edge pin·span preservation은 기존
22케이스가 이미 검증한다(예: `'ctrl zoom preserves the anchor ratio'` 류). 신규
훅 테스트는 배선 계약(이벤트 → 헬퍼 입력 → timeScale 호출)만 검증하고 수식
회귀는 기존 스위트에 위임한다.

### Manual verification — `/live`

dev 서버(:5173) + `/browse` 스킬로 확인:

1. **plain wheel**: 라이브 엣지에서 줌인/아웃 — 뷰포트 오른쪽 끝이 고정되어
   왼쪽으로만 캔들이 늘고 줄어든다. 최신 캔들은 우측 패딩 안에서 사실상 제자리
   (줌마다 패딩 픽셀 폭이 변하는 ±수 px 이동은 정상이며 실패 아님). 과거
   구간으로 스크롤한 뒤에도 뷰포트 오른쪽 끝이 고정(뷰가 "지금"으로 끌려가지
   않음).
2. **ctrl+wheel**: 커서 아래 캔들이 줌 중 같은 픽셀에 머무른다.
3. **shift+wheel**: 스팬 불변으로 좌우 이동. 오른쪽으로는 기본 라이브 뷰
   위치(마지막 캔들 + rightOffset 15칸 여백)에서 멈춤 — 라이브 엣지의 기본
   화면과 동일한 모습으로 복귀(결정 #2 개정). 페이지가 스크롤되지 않는다.
4. **전 페인 동기**: 캔들·거래량·호가 페인이 함께 줌/팬된다.
5. **백필 연동**: 줌아웃/좌측 팬으로 가장 왼쪽 캔들을 넘어가면 과거 데이터가
   로드되고, 로드 후 보던 구간이 유지된다(텔레포트 없음). 연속 휠 중에도 시각적
   튐이 현재(라이브러리 줌) 대비 악화되지 않는다.
6. **타임프레임/종목 전환**: 전환 후 초기 뷰(300-bar + 우측 패딩)가 정상 적용되고
   휠 동작이 새 bundle 기준으로 동작한다 (`maxTo` 갱신 확인).
7. **사이드바 영역**: 차트 밖(사이드바) 휠은 평소처럼 페이지/리스트를 스크롤한다.

## Risks / Open questions

- **연속 휠 + prepend 레이스**: repositioner가 뷰포트를 재고정하는 commit과 휠
  입력 사이의 한 프레임 경합 — 현재 라이브러리 줌과 동일 특성이라 회귀는
  아니지만, 수동 검증 #5에서 체감 확인. 문제 시 후속 스펙으로 다룬다.
- **shift+휠 deltaX 플랫폼**: 위 엣지 케이스 참고. 단, 확인되더라도 구제책은
  우리 핸들러에 `deltaX` 폴백 한 줄을 넣는 것이 **아니다** — lwc 5.2.0의 휠
  리스너는 컨테이너의 자손인 내부 `div.tv-lightweight-charts`에 붙어 우리 버블
  리스너보다 먼저 실행되고, 컨테이너의 `preventDefault()`로 억제되지 않으며,
  `handleScroll.mouseWheel`(기본 on)이 `deltaX ≠ 0`이면 자체 팬을 수행한다
  (lwc 소스 + 헤드리스 브라우저 실증). 폴백을 넣으면 이벤트당 이중 팬이 된다.
  실제 구제책: `handleScroll: { mouseWheel: false }`로 라이브러리 deltaX 경로
  소유권까지 가져와 `useWheelInteractions`에서 deltaX 팬을 직접 처리(트랙패드
  가로 스와이프 포함), 또는 capture phase 리스너 + shift 이벤트 한정
  `stopPropagation()`.
- **수동 검증의 deltaY 한정**: `/browse`(CDP)의 휠 주입은 deltaY 경로로
  도착함을 실증했다 — deltaX-스왑 플랫폼 동작은 이 검증으로 커버되지 않는다.

## Out of Scope (Backlog)

- 줌인 UX 캡 — 원하면 lwc 옵션 한 줄(`timeScale: { maxBarSpacing: 50 }`)로 충분
  (리플레이 ChartStage의 커스텀 구독 캡 이식 불필요 — lwc 5.2 내장 클램프 확인).
- 터치(모바일) 제스처 정책.
- modifier 매핑 사용자 설정.
- ~~`maxTo` 공급원을 timeToIndex로 교체~~ — 완료(v0.7.0.1, 결정 #11).
