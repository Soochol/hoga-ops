/**
 * 사이드바 체결분포의 틱-증분화.
 *
 * 배경(2026-07-11 스캔): 차트 쪽은 SSE 틱 증분화(IncrementalHogaBucketer,
 * past-projector)가 들어갔지만 사이드바 체결분포만 남아 — 체결 틱(~6-7Hz)마다
 * 15분 버퍼 전체를 flatMap(수천~수만 객체)하고 오늘 분포를 처음부터 재계산했다.
 * 심지어 기능 OFF여도 flatMap은 돌았다.
 *
 * 원칙: 스냅샷은 SSE 프레임이라 append-only + 앞쪽 축출(15분 보존)만 일어나고
 * 각 스냅샷 객체는 불변이다 → **객체 참조가 곧 커서**다. 엔진 훅이 마지막으로
 * 처리한 tail 스냅샷 참조를 기억해 두고, 렌더마다 그 뒤에 붙은 스냅샷만
 * flatten해 (전체 flat, 신규 델타)를 함께 내놓는다. 신규 델타는 오늘-분포
 * fold의 입력이 되므로 "축출로 인덱스가 밀리는" 문제와 무관하게 정확하다.
 * tail 참조를 못 찾으면(종목 전환·버퍼 리셋·15분 초과 공백) 전체 재구축으로
 * 폴백하고 generation을 올린다 — 하류 fold도 그 신호로 전체 재구축한다.
 *
 * 정확성 계약: 어떤 틱 시퀀스에서도 결과는 "매 렌더 전체 재계산"과 동일해야
 * 하며 useLiveVolumeDistribution.test.ts가 패리티로 고정한다. render-time ref
 * 갱신은 전부 멱등이라 StrictMode 이중 렌더에도 안전하다(두 번째 패스는
 * appended=[]로 no-op).
 */
import { useRef } from 'react';

import type { Candle, DayVolumeDistribution, RangeSegment } from '../api/types';
import type { TradeSnapshot } from './bucketHogaSeries';
import {
  computeContinuousTradeVolumeDistribution,
  foldTradesIntoVolumeDistribution,
  mergeVolumeDistributionTail,
  type ContinuousTradeLike,
} from './continuousTradeVolumeDistribution';

const EMPTY_TRADES: ContinuousTradeLike[] = [];

function flattenSnapshots(snapshots: readonly TradeSnapshot[]): ContinuousTradeLike[] {
  const out: ContinuousTradeLike[] = [];
  for (const snapshot of snapshots) {
    for (const trade of snapshot.trades) {
      out.push({
        t_ms: trade.t_ms ?? snapshot.t_ms,
        price: trade.price ?? NaN,
        qty: trade.qty,
        side: trade.side,
      });
    }
  }
  return out;
}

export type LiveDistributionTradesResult = {
  /** 버퍼 전체의 flatten (hover-cutoff 등 전량 소비자용). */
  trades: ContinuousTradeLike[];
  /** 직전 렌더 이후 신규 스냅샷의 체결만 (증분 fold 입력). */
  fresh: ContinuousTradeLike[];
  /** 전체 재구축이 일어날 때마다 증가 — 하류 증분 캐시의 무효화 신호. */
  generation: number;
};

type EngineCursor = {
  snapshotRefs: TradeSnapshot[];   // flat을 구성하는 스냅샷 참조 (앞=오래됨)
  lens: number[];                  // 각 스냅샷이 flat에 기여한 체결 수
  flat: ContinuousTradeLike[];
  generation: number;
};

const EMPTY_RESULT: LiveDistributionTradesResult = {
  trades: EMPTY_TRADES, fresh: EMPTY_TRADES, generation: 0,
};

/**
 * 15분 체결 버퍼의 증분 flatten 엔진.
 *
 * enabled=false면 stable EMPTY(틱마다의 순수 낭비 제거). enabled면 이전 flat을
 * 재사용해 축출분은 앞에서 slice, 신규 스냅샷만 flatten해 뒤에 concat한다 —
 * 틱당 비용 O(신규+축출) (기존 O(버퍼 전체)).
 */
export function useLiveDistributionTrades(
  snapshots: readonly TradeSnapshot[],
  enabled: boolean,
): LiveDistributionTradesResult {
  const ref = useRef<EngineCursor | null>(null);

  const rebuild = (generation: number): LiveDistributionTradesResult => {
    const flat = flattenSnapshots(snapshots);
    ref.current = {
      snapshotRefs: [...snapshots],
      lens: snapshots.map((s) => s.trades.length),
      flat,
      generation,
    };
    // 재구축에서는 flat 전체가 "신규"다 — fold 소비자는 generation 신호로
    // 어차피 전체 재구축하므로 fresh는 참고용으로만 flat을 미러.
    return { trades: flat, fresh: flat, generation };
  };

  if (!enabled) {
    ref.current = null;
    return EMPTY_RESULT;
  }
  const prev = ref.current;
  if (prev === null) return rebuild(1);
  if (prev.snapshotRefs.length === 0) {
    return snapshots.length === 0
      ? { trades: prev.flat, fresh: EMPTY_TRADES, generation: prev.generation }
      : rebuild(prev.generation + 1);
  }

  // 신규 경계: 이전 tail 참조를 현 버퍼의 뒤에서부터 탐색 (신규는 소수).
  const prevTail = prev.snapshotRefs[prev.snapshotRefs.length - 1];
  let tailIdx = -1;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (snapshots[i] === prevTail) {
      tailIdx = i;
      break;
    }
  }
  if (tailIdx === -1) {
    // 이전 tail이 통째로 축출됐거나 버퍼 리셋(종목 전환) → 전체 재구축.
    return rebuild(prev.generation + 1);
  }

  // 축출: 이전 head들 중 현 버퍼 head와 일치할 때까지 앞에서 제거.
  let evicted = 0;
  let evictedTrades = 0;
  const currentHead = snapshots[0];
  while (
    evicted < prev.snapshotRefs.length &&
    prev.snapshotRefs[evicted] !== currentHead
  ) {
    evictedTrades += prev.lens[evicted];
    evicted += 1;
  }

  const appended = snapshots.slice(tailIdx + 1);
  if (evicted === 0 && appended.length === 0) {
    return { trades: prev.flat, fresh: EMPTY_TRADES, generation: prev.generation };
  }

  const fresh = flattenSnapshots(appended);
  const cursor: EngineCursor = {
    snapshotRefs: prev.snapshotRefs.slice(evicted).concat(appended),
    lens: prev.lens.slice(evicted).concat(appended.map((s) => s.trades.length)),
    flat: (evictedTrades ? prev.flat.slice(evictedTrades) : prev.flat).concat(fresh),
    generation: prev.generation,
  };
  ref.current = cursor;
  return { trades: cursor.flat, fresh, generation: cursor.generation };
}

type TodayCursor = {
  baseKey: string;
  generation: number;
  profile: DayVolumeDistribution | null;
};

/**
 * 오늘 체결분포의 증분 유지.
 *
 * 전체 재구축은 "베이스"가 바뀔 때만: persisted 프로필 갱신(승격), 오늘 캔들
 * 고저(그리드) 변동, rangeCount·세션 경계·동시호가 컷 변경, 종목/날짜 전환,
 * 엔진 generation 증가(버퍼 리셋). 그 외 틱은 엔진의 fresh 델타만 fold —
 * 결과는 전체 재계산과 동일(패리티 테스트 고정), 신규가 없으면 동일 참조 반환.
 *
 * 의미론 보존: persisted 베이스일 때 fold에 baselineMs(persisted
 * last_trade_ms)를 넘겨 구 mergeVolumeDistributionTail의 "persisted 이전
 * 체결 드롭"과 동일하게 동작한다. isMinute은 recompute 베이스(캔들 그리드)에만
 * 필요 — persisted 병합은 timeframe 무관(구 selectVolumeDistributionProfile
 * 의미론).
 */
export function useLiveTodayVolumeDistribution(args: {
  enabled: boolean;
  stockCode: string | null;
  todayKst: string | null;
  isMinute: boolean;
  rangeCount: number;
  todayCandles: readonly Candle[];
  todaySegment: RangeSegment | null;
  persistedToday: DayVolumeDistribution | null;
  liveTrades: LiveDistributionTradesResult;
  continuousBeforeMs: number | null;
}): DayVolumeDistribution | null {
  const cursorRef = useRef<TodayCursor | null>(null);
  const {
    enabled, stockCode, todayKst, isMinute, rangeCount,
    todayCandles, todaySegment, persistedToday, liveTrades, continuousBeforeMs,
  } = args;

  if (!enabled || !stockCode || !todayKst || !todaySegment) {
    cursorRef.current = null;
    return null;
  }

  // persisted 유효성: 구 selectVolumeDistributionProfile의 폴백 규칙 그대로 —
  // 비어 있거나 rangeCount 불일치면 recompute 베이스로 간다.
  const persistedUsable = !!(
    persistedToday &&
    persistedToday.bins.length === rangeCount &&
    !(persistedToday.last_trade_ms == null && persistedToday.bins.every((b) => b.qty === 0))
  );

  let priceMin = Infinity;
  let priceMax = -Infinity;
  for (const candle of todayCandles) {
    if (Number.isFinite(candle.low)) priceMin = Math.min(priceMin, candle.low);
    if (Number.isFinite(candle.high)) priceMax = Math.max(priceMax, candle.high);
  }

  const baseKey = JSON.stringify([
    stockCode, todayKst, rangeCount,
    persistedUsable, persistedToday?.last_trade_ms ?? null,
    persistedUsable ? null : `${isMinute}:${priceMin}:${priceMax}`,
    todaySegment.session_open_ms, todaySegment.session_close_ms,
    continuousBeforeMs,
  ]);

  const prev = cursorRef.current;
  if (prev !== null && prev.baseKey === baseKey && prev.generation === liveTrades.generation) {
    if (liveTrades.fresh.length === 0 || prev.profile === null) return prev.profile;
    const next = foldTradesIntoVolumeDistribution(
      prev.profile, liveTrades.fresh, continuousBeforeMs,
      persistedUsable ? (persistedToday?.last_trade_ms ?? null) : null,
    );
    cursorRef.current = { baseKey, generation: liveTrades.generation, profile: next };
    return next;
  }

  // 전체 재구축 (베이스 변경/버퍼 리셋 시에만) — 구 경로와 동일한 계산.
  let profile: DayVolumeDistribution | null;
  if (persistedUsable && persistedToday) {
    profile = mergeVolumeDistributionTail(
      persistedToday, liveTrades.trades, null, continuousBeforeMs,
    );
  } else {
    profile = isMinute && todayCandles.length
      ? computeContinuousTradeVolumeDistribution({
          date: todayKst,
          candles: todayCandles,
          trades: liveTrades.trades,
          rangeCount,
          segment: todaySegment,
          continuousBeforeMs,
        })
      : null;
  }
  cursorRef.current = { baseKey, generation: liveTrades.generation, profile };
  return profile;
}
