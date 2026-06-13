import type { Candle } from '../../api/types';
import type { LiveMAConfig } from '../../state/livePage';
import { unixMsToKSTDate } from '../../util/time';
import { subtractDaysKst, PAST_CANDLES_MAX_DAYS } from '../liveDateTime';

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

/** 일봉 fetch 창 너비(캘린더일). today 앵커 + 분봉 팬 클램프(PAST_CANDLES_MAX_DAYS) +
 *  maxEnabledPeriod 거래일을 캘린더일로 보수 환산 + 휴장 슬랙. */
export function dailyMaLookbackDays(maxEnabledPeriodDays: number): number {
  return PAST_CANDLES_MAX_DAYS + Math.ceil(maxEnabledPeriodDays * DAILY_MA_TRADING_TO_CALENDAR) + 15;
}

/** 활성 슬롯들의 최대 period. 비활성/빈 배열이면 기본 20(최소 창 확보). */
export function maxEnabledPeriod(configs: readonly LiveMAConfig[]): number {
  return configs.reduce((mx, c) => (c.enabled ? Math.max(mx, c.period) : mx), 20);
}

/** 일봉 fetch 창 `{from, to}` (YYYYMMDD KST). `to`=오늘, `from`=오늘−lookback.
 *  today 앵커라 좌측 팬에 불변 → react-query 키 안정 → 재fetch 없이 lockstep(ADR-0073). */
export function dailyMaFetchWindow(
  todayKst: string,
  configs: readonly LiveMAConfig[],
): { from: string; to: string } {
  return {
    from: subtractDaysKst(todayKst, dailyMaLookbackDays(maxEnabledPeriod(configs))),
    to: todayKst,
  };
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
