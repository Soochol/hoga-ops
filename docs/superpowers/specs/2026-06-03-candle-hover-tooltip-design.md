# 캔들 호버 툴팁 (Candle Hover Tooltip)

/ live 차트에서 캔들에 마우스를 올리면, 그 봉의 OHLC·등락·거래량 정보를
커서를 따라다니는 플로팅 툴팁으로 띄운다.

## 배경 / 목적

`/live` 차트는 이미 크로스헤어(`subscribeCrosshairMove`)와, 커서 아래 값을
역참조하는 좌상단 레전드(`PaneLegendOverlay`)를 갖고 있다. 그러나 **캔들 페인의
레전드 행은 이동평균선 값만** 보여주고, 정작 그 캔들 자신의 시·고·저·종·등락·
거래량은 어디에도 표시되지 않는다. 이 빈틈을 "캔들 위에서만 뜨는 플로팅 툴팁"
으로 채운다.

레전드(항상 떠 있는 좌상단 바)가 아니라 **호버 시에만 나타났다 사라지는 툴팁**
이라는 점이 핵심 — 커서가 차트를 벗어나면 숨는다.

## 결정 사항 (brainstorming GATE)

brainstorming 대화에서 비주얼 컴패니언 목업으로 확정한 결정들:

1. **배치 = 커서 추종 플로팅 툴팁** (좌상단 레전드 확장안은 기각). 캔들 위에서만
   표시, 마우스가 차트를 벗어나면 숨김.
2. **호버 감지 범위 = 캔들(가격) 페인 한정.** 거래량·호가·투자자 페인 위에서는
   툴팁을 띄우지 않는다 (`paneIdAtY`로 페인 판정).
3. **레이아웃 = A · 세로 라벨형** (항목당 한 줄, 기존 레전드 행 스타일과 일관).
4. **타임프레임 = 분/일/주/월 전부.** D/W/M은 시각 없이 날짜만 (기존
   `timeFormatter`의 calendar-timeframe 관례와 일치).
5. **기준 = "직전 봉" 단일 규칙 (전 타임프레임 동일).** 사용자가 비교 목업
   (전일 종가 +3.19% vs 직전 분봉 +0.05%, 사이드바 불일치 가능성 포함)을 보고
   **의도적으로** 직전 봉 기준을 선택했다. 이유: 모든 타임프레임에 같은 규칙 →
   혼란이 없음.
   - 봉대비 변동률 = `(이 봉 종가 / 직전 봉 종가 − 1) × 100`
   - 봉대비 변동액 = `이 봉 종가 − 직전 봉 종가`
   - 직전봉 거래량비 = `(이 봉 거래량 / 직전 봉 거래량) × 100` ("같으면 100%" 충족)
   - **직전 봉 = 현재 타임프레임으로 그려진 캔들 배열의 바로 앞 봉**
     (`bundle.candles[index−1]` — 아래 "검증" 참고: 이 배열은 이미 타임프레임별로
     집계되어 있다). 분봉 09:00 봉의 직전 봉은 전일 마지막 분봉이므로, 날짜·
     세그먼트 경계 특수처리 없이도 그 봉 한정으로 "전일 종가 대비"가 된다.
   - 가장 이른 봉(`index===0`, 직전 봉 없음) → 봉대비 변동·거래량비 `—`.
   - **이 분기·근거·트레이드오프는 ADR-0059에 기록**(등락률/전일대비와 의도적
     으로 다름; 용어 `봉대비`는 CONTEXT.md 참조).
6. **라벨 = "직전대비"** (통일). 분봉에선 "전일대비"가 부정확하므로 "직전대비"로
   통일한다. 일/주/월봉은 직전 봉 = 전일/전주/전월이라 의미가 그대로 맞는다.
   거래량 비율 행 라벨은 "거래량비".
7. **설정 토글 (기본 ON).** `CHART_TOGGLES` 레지스트리(`frontend/src/state/chartPrefs.ts`)
   에 엔트리 하나 추가 — `candleTooltipEnabled`, default `true`, category `chart`.
   레지스트리가 단일 진실원천이라 `ChartToggleKey`·`ChartViewPrefs` 필드·기본값·
   persist(`chartPrefsPersistence.ts`의 `mergePrefs`)·`LiveSettingsModal` "차트" 행이
   모두 자동 파생된다(`auctionWindowMask`·`ratioOutlierFilterEnabled` 선례). 컴포넌트는
   `useActivePrefs((p) => p.candleTooltipEnabled)`로 게이팅 — false면 크로스헤어 구독도
   걸지 않고 `null` 반환.

### 알려진 거동 (의도된 동작, 버그 아님)

- **분봉 봉대비 변동률 열의 하루 내 불연속**: "직전 봉" 규칙이라 매일 첫 봉(09:00)은
  밤사이 갭(큰 값일 수 있음)을, 나머지 봉은 1분 단위 미세 변화를 보인다. 이는
  의도된 동작이다.
- **사이드바와의 불일치(분봉)**: 사이드바/HTS의 등락률은 전일 종가 기준이라,
  최신 분봉 호버 시 툴팁(직전 분봉 기준, ~+0.05%)과 사이드바(전일 종가 기준,
  ~+3.30%)가 다르게 보인다. 사용자가 비교 목업을 보고 직전-봉 단일 규칙을
  명시적으로 선택했다(결정 5). spec-review 게이트에서 이 구체적 결과를 한 번 더
  확인한다.

> **이전 결정의 폐기(supersession):** brainstorming 중간에 "거래량% = 당일 누적
> ÷ 전일 종일"(option ①)로 잠정 합의했으나, 5번에서 "직전 봉 기준" 단일 규칙으로
> **대체되었다.** 세그먼트 누적·전일 종일 합·일봉 프리페치는 모두 폐기. 이 문서의
> 유효 규칙은 5번뿐이다.

### 데이터 가용성 검증 (실데이터 + 코드)

워크플로 조사 + 백엔드 실측 + 코드 확인:

- **`bundle.candles`는 현재 타임프레임으로 이미 집계된 배열이다.**
  `useLiveBundle.ts:128-144`가 분봉은 `aggregateCandles`, W/M은
  `aggregateCalendar`로 집계해 `kisCandles`를 만들고, `buildLiveBundle.ts:142`가
  `candles: kisCandles`로 싣는다. 따라서 `bundle.candles[index−1]`은 현재
  타임프레임의 **직전 그려진 봉**이며, raw 1m이 아니다.
- **거래량은 집계된 봉에 합산되어 있다.** `kisBarToCandle`이 KIS volume을 vol_a로
  싣고, 집계가 `vol_a+vol_b`를 버킷 합산. 거래량 = `vol_a + vol_b`
  (`frontend/src/chart/projectors/volume.ts:31` 관례). vol_a/vol_b 개별 의미는
  schema-notes에서 TBC지만 **합은 신뢰 가능**. → 거래량 페인 토글과 무관하게
  모델이 `bundle.candles[index]`에서 직접 읽는다(`param.seriesData`는 OHLC만 싣고
  토글로 사라질 수 있으므로 의존하지 않는다).
- **OHLC**: `Candle = {ts_ms, open, high, low, close, vol_a, vol_b}`
  (`frontend/src/api/types.ts:29`).
- **직전 봉·기준값**: 전적으로 인메모리 `bundle.candles`. 외부 페치 0.

## 타입 설계 (신규)

```ts
// frontend/src/live/candleTooltipModel.ts
export interface CandleTooltipModel {
  tsMs: number;            // 호버된 봉의 ts_ms (Unix epoch ms)
  dateLabel: string;       // "06/03" (KST)
  timeLabel: string | null;// "13:45" (인트라데이) / null (D/W/M)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;          // vol_a + vol_b
  // ── 직전 봉 대비 (직전 봉이 없으면 모두 null → "—") ──
  barOverBarWon: number | null;   // 봉대비 변동액 = close − prev.close
  barOverBarPct: number | null;   // 봉대비 변동률 = (close/prev.close − 1) × 100
  volumeRatioPct: number | null;  // 직전봉 거래량비 = (volume / prevVolume) × 100, prevVolume==0 → null
}

/**
 * 인덱스 기반 순수 함수. 현재 타임프레임으로 그려진(=집계된) 캔들 배열과, 그 안의
 * 호버 인덱스만 받는다. 차트 API·axis·시각 매칭 미접근 — 테이블 테스트 가능.
 *  - candles[index]      = 호버된 봉
 *  - candles[index − 1]  = 직전 봉 (index===0 이면 봉대비/거래량비 필드 = null)
 *  - 날짜/시각 라벨은 candles[index].ts_ms 를 KST 로 포맷(별도 axis 불필요).
 */
export function buildCandleTooltip(
  candles: Candle[],
  index: number,
  timeframe: LiveTimeframe,
): CandleTooltipModel | null;  // index 범위 밖 → null
```

> **계약을 인덱스 기반으로 둔 이유**: ts_ms 시각 매칭은 `axis.toReal(param.time)`
> round-trip drift로 간헐 실패한다(이미 `LiveChartRoot.tsx:264`에서 `Math.round`로
> 처리한 그 문제). 인덱스로 읽으면 시각 매칭이 사라지고, `param.logical`(페인 간
> **공유 timeScale의 union 인덱스** — 캔들 시리즈 배열을 인덱싱하지 **않음**,
> `LiveChartRoot.tsx:216-220`)을 직전 봉 조회에 쓰는 함정도 피한다.

## 아키텍처

두 조각으로 분리한다 — 코드베이스의 "순수 커널 + 명령형 셸" 관례
(`nextHistoricalFrom`, `aggregateCandles`)를 따른다.

1. **순수 모델** `candleTooltipModel.ts`
   - `buildCandleTooltip(candles, index, timeframe)` — 위 타입 설계. 호버된 봉과
     직전 봉만으로 모델 산출. 어떤 차트/axis API도 만지지 않는다.

2. **오버레이 컴포넌트** `CandleTooltip.tsx`
   - `LiveChartRoot`의 오버레이 그룹에 마운트(`PaneLegendOverlay`·`DrawingOverlay`
     형제). `pointer-events:none`.
   - **설정 게이팅**: `useActivePrefs((p) => p.candleTooltipEnabled)`가 false면 즉시
     `null` 반환 — 크로스헤어 구독·맵 구성도 하지 않는다(결정 7).
   - **인덱스 해석(컴포넌트 책임)**: 그려진 캔들 배열 =
     `bundle.candles.filter(c => axis.contains(c.ts_ms))` (projectCandle와 동일
     필터). 이 배열로부터 `가상시각 → index` 맵을 1회 구성한다 — **키는
     projectCandle이 캔들 `time`으로 쓰는 값과 정확히 동일**해야 하므로
     `axis.toVirtual(c.ts_ms) / 1000` (**반올림하지 않음**; `candle.ts`의
     projectCandle은 `time: axis.toVirtual(c.ts_ms)/1000`을 그대로 쓴다). 같은
     float이 `param.time`으로 되돌아오므로 키로 **정확 조회**해 index를 얻는다
     (O(1)). 키 부재(봉 사이 whitespace) → 숨김. `param.logical`(페인 union
     인덱스)은 쓰지 않는다. 모델에 넘기는 `candles`도 이 filter된 그려진 배열이라
     `index−1`이 직전 그려진 봉을 가리킨다.
     - LiveSidebar의 cursor→데이터포인트 해석과 **같은 봉**을 가리켜야 한다(둘 다
       가상시각 기반 → 동일 봉 보장; 구현 시 교차 확인).
   - `chart.subscribeCrosshairMove(handler)` 직접 구독, rAF coalesce
     (`PaneLegendOverlay.tsx:229-256` 패턴 재사용).
   - 숨김 조건: `param.point == null`(차트 이탈) **또는** 커서가 캔들 페인 밖
     (`paneIdAtY(chart, paneSeries, param.point.y) !== 'candle'`) **또는** index
     부재 / 모델 `null`.
   - 표시 시 모델 값으로 렌더 + `param.point` 기준 위치(아래 "위치/충돌").

## 컴포넌트 / 툴팁 내용 (레이아웃 A)

세로 라벨형, 항목당 한 줄:

```
06/03 13:45            ← dateLabel + timeLabel (D/W/M은 날짜만)
─────────────
시        72,800        ← OHLC, 중립 --fg
고        73,600
저        72,600
종        73,400
직전대비   +600  +0.82%  ← priceDirClass (상승 빨강/하락 파랑/0 중립)
─────────────
거래량     1,284,000     ← formatKoreanInt
거래량비   118%          ← 중립 (값 없으면 —)
```

색·표기 규율 (DESIGN.md 준수):

- **OHLC 값 = 중립 `--fg`.** DESIGN.md상 방향색(`--price-up #DC2626` /
  `--price-down #2563EB`)은 **델타 전용** — 가격 절대값엔 쓰지 않는다.
- **직전대비 행만** `priceDirClass`(`frontend/src/ui/priceDir.ts`)로 색칠.
  금액·% 모두 같은 색, 부호는 색으로 전달. % 표기 = `Math.abs(pct).toFixed(2)+'%'`
  (`QuoteChange.tsx`/`ChangeCell.tsx` 관례).
- 거래량 = `formatKoreanInt`(`frontend/src/util/koreanNumber.ts`). 직전봉
  거래량비 = 정수%(`Math.round`), **상한 없음**(`1,247%`도 그대로), **중립색**
  (방향 델타가 아니므로 빨강/파랑 미적용). `prevVolume==0` → `—`.
- 폰트 = `--font-mono`, `tabular-nums`. 박스 = `--bg-card`/`--bg-subtle` +
  `--border` + `--radius-md`, `--shadow`(레전드 `boxStyle` 선례).

## 데이터 흐름

```
candleTooltipEnabled == false ?  → 컴포넌트 null (구독·맵 없음)
crosshair move
  → param.point == null ?        → 숨김
  → paneIdAtY != 'candle' ?      → 숨김
  → index = vsecToIndex.get(param.time)   (가상시각 맵, 정확 조회)
  → index == null ?              → 숨김
  → model = buildCandleTooltip(bundle.candles, index, timeframe)
  → model == null ?              → 숨김
  → 렌더 + param.point 기준 위치 (flip/clamp)
```

크로스헤어는 이미 `CrosshairMode.Normal`(스냅 없음, `chartScale.ts:50-52`)이라
커서가 봉 사이 빈 곳을 지날 수 있다 → 가상시각 맵 키 부재 시 숨김으로 가드.

## 위치 / 충돌 (positioning)

- 기준점 = `param.point.x/y` (차트 컨테이너 상대 좌표로 가정 — 구현 시 1회 검증,
  필요하면 컨테이너 `getBoundingClientRect()` 오프셋 가산: plan 이월).
- 기본 오프셋 = 커서 우하단(+14, +12px).
- **Flip**: 오른쪽 가장자리 근접 시 커서 왼쪽으로, 아래 가장자리 근접 시 위로.
- **Clamp**: 최종 위치를 컨테이너 안으로 클램프. 좌상단 레전드 영역과의 시각
  충돌도 회피(plan 이월).
- 위치 갱신은 rAF coalesce된 같은 틱에서 처리(콘텐츠와 함께).

## 엣지 / 에러

- **index===0 (가장 이른 봉)**: 직전 봉 없음 → 직전대비·거래량비 `—`. 블로킹 없음.
- **prevVolume === 0**: 거래량비 `null` → `—` (0 나눗셈 회피).
- **봉 사이 빈 위치 / 차트 밖 / whitespace**: 가상시각 맵 키 부재 또는
  `point==null` → 숨김.
- **캔들 외 페인**: 숨김(`paneIdAtY`).
- **차트 teardown**: 기존 오버레이들과 동일하게 try/catch로 graceful.

### 거동 (의도된 동작)

- **라이브 형성 중인 봉**(오늘 마지막 분봉, WS 갱신): 호버 시 OHLC·거래량·봉대비가
  실시간으로 갱신된다(직전 봉은 직전 완성봉). 매 크로스헤어 이동마다 현재 번들로
  재계산하므로 자동.
- **종가 동시호가 muted 캔들**(15:20–15:30, `projectCandle`이 회색 처리): 데이터는
  그대로이므로 툴팁 정상 표시(muting은 시각 처리일 뿐).
- **크로스헤어 구독**: cursor store(`cursorMs`)만으론 index·픽셀·pane을 못 얻으므로
  `CandleTooltip`이 독립 구독(rAF coalesce). LiveChartRoot·PaneLegendOverlay와
  합쳐 3개 구독이나 각자 가볍다.

## 테스트

- **모델 테이블 테스트** `candleTooltipModel.test.ts` (순수, 차트 불필요):
  - 상승/하락/보합(봉대비 변동 부호·반올림), `index===0` → `—`,
  - 직전 봉이 전일 마지막 분봉인 케이스(분봉 자정 경계 갭),
  - D/W/M 직전 봉, 거래량비(같음=100%, 증가/감소, prevVolume=0 → null),
  - `index` 범위 밖 → null, D/W/M은 `timeLabel===null`.
- **컴포넌트 테스트** `CandleTooltip.test.tsx`:
  - `param.point==null` → 숨김, 캔들 페인 → 표시 / 다른 페인 → 숨김,
  - 가상시각 맵 인덱스 해석(정확 조회, whitespace → 숨김),
  - 가장자리 flip, 모델 값 렌더(라벨·색 클래스), mouse-leave 후 잔상 없음,
  - `candleTooltipEnabled=false` → 구독/렌더 없음(툴팁 안 뜸), 토글 ON → 복귀.
- 게이트: `npx vitest run` + `npx tsc -b` (eslint는 변경 파일 한정 0 error).

## plan 이월 (구현 단계에서 확정)

- `param.point` 좌표계(컨테이너 상대 여부) 1회 실측 검증.
- 가상시각→index 맵 구성 위치(컴포넌트 메모) 및 `bundle.candles`/`axis` 배선.
- LiveSidebar의 cursor→candle 해석과 동일 봉을 가리키는지 교차 확인.
- `paneIdAtY` 호출에 필요한 `paneSeries`/`chart` 배선
  (`chartCoordinates.ts:143-161`).
- 라벨 최종 문구("직전대비"/"거래량비") 시안 확정 (거래량비 색은 중립으로 결정).
- 툴팁 z-index/좌상단 레전드 영역 회피 클램프.
