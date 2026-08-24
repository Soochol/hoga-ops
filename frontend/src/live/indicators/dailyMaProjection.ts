import type { Candle } from '../../api/types';
import type { LiveMAConfig } from '../../state/livePage';
import { unixMsToKSTDate } from '../../util/time';
import { subtractDaysKst, daysBetweenKst, PAST_CANDLES_MAX_DAYS } from '../liveDateTime';

/**
 * 일봉 이동평균선(Daily MA) 투영의 **순수 입력 계산** — `DailyMovingAverageOverlay`
 * 본문에서 분리한 deep seam. 오버레이 본문에 묻혀 있던 lookback 산식은 fetch mock
 * 뒤라 테스트가 닿지 못했고(그래서 period>190 미달 버그가 통과했다), 여기로 빼면
 * Interface로 직접 검증된다. ADR-0073.
 */

/**
 * 거래일 → 캘린더일 **보수적** 환산 계수. KRX 실측 평균은 ≈1.48(휴장 포함)이지만
 * lookback은 분봉 가시 전 범위를 *반드시* 덮어야 하므로 1.5로 상향(over-cover).
 *
 * ⚠️ `liveDateTime.TRADING_DAYS_PER_CALENDAR_DAYS`(=5/7≈1.4)와 **의도가 다르다** —
 * 저건 backfill 범위의 *현실 평균* 추정, 이건 coverage *상한*. 둘을 "일치"시키려고
 * 이 값을 1.4로 내리면 대형 period에서 좌측 끝 일봉MA가 다시 null이 된다. 건드리지 말 것.
 */
export const DAILY_MA_TRADING_TO_CALENDAR = 1.5;

/**
 * 표시 하한을 따라 창을 넓힐 때의 **계단 크기**(캘린더일).
 *
 * 하한을 날것 그대로 쓰면 좌측 팬 한 스텝마다 `from` 이 움직여 react-query 키가 매번
 * 갈리고, 그때마다 일봉을 다시 받는다(ADR-0073 이 today 앵커로 피하려던 바로 그것).
 * 계단으로 내리면 키가 90일에 한 번만 바뀐다 — 팬을 아무리 잘게 해도 재fetch 는
 * 계단을 넘을 때 1회다.
 *
 * 90일인 이유: 계단이 작으면 재fetch 가 잦고, 크면 안 쓸 과거를 크게 당겨온다.
 * 일봉은 하루 1행이라 90일 ≈ 62행으로 한 계단의 낭비가 작다.
 *
 * ⚠ 계단은 **`quantizeDailyMaFloorDate` 한 곳에만** 있다. 창 산식(`dailyMaFetchWindow`)
 * 은 받은 하한을 그대로 덮을 뿐이라, 계단이 두 군데로 갈려 서로를 상쇄하는 일이 없다.
 */
export const DAILY_MA_FLOOR_STEP_DAYS = 90;

/** 일봉 fetch 창 너비(캘린더일)의 **기본선**. today 앵커 + 분봉 팬 클램프
 *  (PAST_CANDLES_MAX_DAYS) + maxEnabledPeriod 거래일을 캘린더일로 보수 환산 + 휴장 슬랙.
 *
 *  ⚠ 이 기본선이 덮는 것은 **벤더 모드의 하한**(오늘−249)뿐이다. 디스크 모드
 *  (hogaplay 토글 · 저장뷰 얼림 · 전역 우회)에는 250일 벽이 없어 화면이 이보다
 *  과거로 간다 — 그 축은 `dailyMaFetchWindow` 의 `displayFloorDate` 가 맡는다. */
export function dailyMaLookbackDays(maxEnabledPeriodDays: number): number {
  return PAST_CANDLES_MAX_DAYS + Math.ceil(maxEnabledPeriodDays * DAILY_MA_TRADING_TO_CALENDAR) + 15;
}

/** 활성 슬롯들의 최대 period. 비활성/빈 배열이면 기본 20(최소 창 확보). */
export function maxEnabledPeriod(configs: readonly LiveMAConfig[]): number {
  return configs.reduce((mx, c) => (c.enabled ? Math.max(mx, c.period) : mx), 20);
}

/**
 * 표시 하한을 계단으로 **내린** 날짜 — 소비처 넷에 내려보낼 값의 유일 생산자.
 *
 * 두 가지를 동시에 산다:
 *  ① **쿼리 키 안정** — 팬 스텝마다 창이 갈리지 않는다(위 상수 도크스트링).
 *  ② **재렌더 억제** — 이 값은 `LiveChartRoot` 의 prop 이 된다. 그 컴포넌트는 훅이
 *     수백 개라 팬 프레임마다 재렌더하면 실측으로 비싸서, ADR-0119 C2c-2a 가
 *     `historicalFromDate` 의 반응형 읽기를 일부러 끊어 놓았다. **날것 하한을 prop 으로
 *     넘기면 그 절단이 무의미해진다** — 반드시 이 함수를 통과시킨 값만 넘길 것.
 *
 * 하한이 오늘 이후(또는 오늘)면 오늘을 돌려준다 — 창 산식이 기본선을 쓰게 된다.
 */
export function quantizeDailyMaFloorDate(todayKst: string, floorDate: string): string {
  const span = daysBetweenKst(floorDate, todayKst);
  if (span <= 0) return todayKst;
  return subtractDaysKst(todayKst, Math.ceil(span / DAILY_MA_FLOOR_STEP_DAYS) * DAILY_MA_FLOOR_STEP_DAYS);
}

/**
 * 표시 하한 `floorDate` 를 **MA 값이 실제로 나오는 상태로** 덮는 lookback(캘린더일).
 * 하한이 기본선 안이면 기본선을 그대로 돌려준다 — 반환값은 항상 기본선 이상이다.
 *
 * ⚠ `floorDate` 까지만 받아오면 안 된다 — SMA 는 창 시작 뒤 period 거래일이 지나야
 * 첫 값이 나오므로(`computeDailyMaByDate`: period 미달 구간은 맵에 없음), 하한에
 * 딱 맞춘 창은 **같은 구멍을 왼쪽으로 옮길 뿐**이다. 그래서 warmup 몫
 * (`period × 1.5` + 휴장 슬랙)을 하한보다 더 과거로 얹는다. 이 항을 빼면 원래 버그가
 * 새 경계에서 그대로 재현된다.
 *
 * 하한이 기본선 안이면 기본선을 그대로 쓴다. 이 하한은 **벤더 모드에서도 넘어온다** —
 * 그쪽 하한은 오늘−249 라 필요량 294 < 기본선 295 로 창이 한 톨도 안 움직인다(회귀
 * 테스트로 고정). 그래서 호출부가 모드를 알 필요가 없다.
 */
export function dailyMaFloorLookbackDays(
  todayKst: string,
  floorDate: string,
  maxEnabledPeriodDays: number,
): number {
  const base = dailyMaLookbackDays(maxEnabledPeriodDays);
  const spanToFloor = daysBetweenKst(floorDate, todayKst);
  const needed = spanToFloor + Math.ceil(maxEnabledPeriodDays * DAILY_MA_TRADING_TO_CALENDAR) + 15;
  return Math.max(base, needed);
}

/**
 * 일봉 fetch 창 `{from, to}` (YYYYMMDD KST). `to`=오늘, `from`=오늘−lookback.
 * today 앵커라 좌측 팬에 불변 → react-query 키 안정 → 재fetch 없이 lockstep(ADR-0073).
 *
 * `displayFloorDate` = 이 창이 실제로 보여줄 수 있는 가장 이른 거래일(모르면 생략).
 * **`quantizeDailyMaFloorDate` 를 통과한 값을 넘길 것** — 계단은 그쪽이 소유하고,
 * 여기서는 받은 하한을 덮기만 한다. **모드 플래그가 필요 없는 이유**: 벤더 모드의
 * 하한은 오늘−249 이고 기본선이 그것을 이미 덮으므로, 벤더 모드가 자기 하한을 그대로
 * 넘겨도 창은 한 톨도 안 움직인다(회귀 테스트로 고정).
 */
export function dailyMaFetchWindow(
  todayKst: string,
  configs: readonly LiveMAConfig[],
  displayFloorDate?: string | null,
): { from: string; to: string } {
  const period = maxEnabledPeriod(configs);
  const lookback = displayFloorDate
    ? dailyMaFloorLookbackDays(todayKst, displayFloorDate, period)
    : dailyMaLookbackDays(period);
  return { from: subtractDaysKst(todayKst, lookback), to: todayKst };
}

/** 오늘 현재가 프록시 — 마지막 in-session 캔들의 거래일이 오늘이면 그 close, 아니면
 *  null(주말·장전·휴장엔 오늘 캔들이 없어 clean degrade). 일봉 종가 미확정인 오늘 봉을
 *  현재가로 override하는 데 쓴다. */
export function pickTodayLiveClose(
  candles: readonly Candle[],
  todayKst: string,
): number | null {
  const last = candles.length ? candles[candles.length - 1] : null;
  return last && unixMsToKSTDate(last.ts_ms) === todayKst ? last.close : null;
}
