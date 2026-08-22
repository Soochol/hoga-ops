/**
 * 창 간 크로스헤어 동기화의 **판정을 한 번만** 하고 둘이 나눠 쓴다.
 *
 * 소비 창에서 이 값을 필요로 하는 곳이 둘이다 — 크로스헤어를 그리는
 * `CursorSyncCrosshair` 와, **그 봉의 OHLC 를 읽어야 하는 레전드**
 * (`PaneLegendOverlay`). 각자 판정하면 게이트가 갈릴 수 있고(종목 토글·창번호),
 * 그 어긋남은 "선은 여기 있는데 숫자는 다른 봉" 으로 화면에 나타난다.
 *
 * ── 레전드가 왜 이걸 필요로 하는가 ───────────────────────────────────────
 * lwc 는 `setCrosshairPosition` 으로 그린 크로스헤어에 대해 그 차트의
 * `subscribeCrosshairMove` 를 **발화시키지 않는다**(`CursorSyncCrosshair` 헤더의
 * 실측). 레전드는 그 콜백이 준 `param.time` 으로 봉을 찾고 없으면 **최신 봉으로
 * 폴백**하므로, 동기화로 그린 크로스헤어에서는 언제나 폴백이 걸렸다.
 *
 * 실측(2026-08-21): 호버 창 레전드는 `시작 276,000 · 종가 260,500`(크로스헤어 봉)인데
 * 동기화 창은 `시작 267,000 · 종가 281,500`(오늘 봉)이었다. 선은 같은 자리인데
 * 읽히는 값이 달라 "다른 차트" 로 보인다 — 눈이 먼저 가는 것이 캔들 위치가 아니라
 * 헤더 숫자이기 때문이다.
 */
import { useContext, useMemo } from 'react';
import { useLiveCursorStore } from './useLiveCursorStore';
import { WindowViewContext } from './workspace/windowView';
import { useActivePrefs } from '../state/chartPrefs';
import { isMinuteTimeframe, type LiveTimeframe } from '../state/livePage';
import {
  indexCandlesByKstDate,
  resolveSyncTarget,
  type SyncCandle,
  type SyncResolution,
  type SyncTargetSource,
} from '../chart/cursorSync';

export function useCursorSyncResolution(params: {
  /** 이 창이 그리고 있는 캔들. **ts 오름차순**이어야 한다(분봉 다리가 이진 탐색). */
  candles: readonly SyncCandle[];
  /** 이 창의 봉 — 다리와 받아 주는 발행 집합을 이것이 정한다. */
  timeframe: LiveTimeframe;
  /** 이 창의 종목 — 발행 origin 과 대조한다. */
  code: string | null;
}): SyncResolution {
  const { candles, timeframe, code } = params;
  const syncCursorMs = useLiveCursorStore((s) => s.syncCursorMs);
  const syncCursorOrigin = useLiveCursorStore((s) => s.syncCursorOrigin);
  const winCtx = useContext(WindowViewContext);
  const myWindowId = winCtx?.windowId ?? null;
  const myGroup = winCtx?.group ?? null;
  const allowCrossSymbol = useActivePrefs((p) => p.cursorSyncCrossSymbol);

  // 다리는 **내 봉**이 고른다. 분봉이면 인덱스를 만들지 않는다 — 분봉 번들은 틱마다
  // 갱신되므로 그때마다 캔들 전량을 훑게 된다(`snapToInstant` 가 이진 탐색을 쓰는 이유).
  const minuteConsumer = isMinuteTimeframe(timeframe);
  const byDate = useMemo(
    () => (minuteConsumer ? null : indexCandlesByKstDate(candles)),
    [candles, minuteConsumer],
  );
  const source = useMemo<SyncTargetSource>(
    () => (byDate ? { axis: 'date', byDate, candles } : { axis: 'instant', candles }),
    [byDate, candles],
  );

  return useMemo(
    () => resolveSyncTarget({
      cursor: syncCursorMs !== null && syncCursorOrigin !== null
        ? { tsMs: syncCursorMs, origin: syncCursorOrigin }
        : null,
      myWindowId,
      myGroup,
      myCode: code,
      source,
      allowCrossSymbol,
    }),
    [syncCursorMs, syncCursorOrigin, myWindowId, myGroup, code, source, allowCrossSymbol],
  );
}
