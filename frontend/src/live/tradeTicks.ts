/**
 * 체결 틱 표시 어댑터 — WS 체결 스냅샷 버퍼 → 체결창 행 목록.
 *
 * 데이터 출처의 결정적 사실(2026-07-20 확인): `/live` 표시 경로는 다운샘플러를
 * 타지 않는다. stream.on_tick 이 raw WsTick 을 그대로 buffer.publish 하므로
 * (hoga/live/stream.py) 프론트가 받는 trade 스냅샷은 **키움 0B 체결 1건 = 스냅샷
 * 1개**다(kiwoom_frames._parse_trade → payload.trades 길이 1). snapshot.py 의
 * "trade 는 10초 (price, side) 집계" 주석은 **parquet 저장 경로 전용**이다.
 *
 * 다만 어댑터는 길이 1을 가정하지 않는다 — 초기 REST hydrate(/api/live/series)나
 * 구경로가 복수 원소를 실어와도 배열 순서대로 평탄화한다.
 *
 * ## 정렬하지 않는다 (핵심 계약)
 * 키움 CNT_TIME 은 **초 단위**라 같은 t_ms 에 수십 건이 몰린다. t_ms 로 정렬하면
 * 같은 초 안의 체결 순서가 뒤섞여 "무엇이 먼저 체결됐는가"라는 체결창의 존재
 * 이유가 무너진다. 버퍼의 push 순서가 유일한 진실이므로 그 순서만 뒤집는다.
 */
import type { TradeSnapshot } from './bucketHogaSeries';

/** 체결창 한 행. side 는 키움 CNT_QTY 부호: +1 매수 / -1 매도 / 0 동시호가·장전. */
export interface TradeTick {
  tMs: number;
  price: number;
  qty: number;
  side: number;
  /** React key — 값에서 결정론적으로 유도(인덱스 기반이 아니라 새 체결 유입에 불변). */
  key: string;
}

export interface TradeTickView {
  /** 최신이 index 0 (체결창은 최신이 위). */
  ticks: TradeTick[];
  /** 체결가 색 기준선(전일 종가). 0B payload 최상위 prev_close — 없으면 null. */
  prevClose: number | null;
}

const EMPTY_VIEW: TradeTickView = { ticks: [], prevClose: null };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 버퍼의 체결 스냅샷을 최신순 행 목록으로 평탄화한다.
 *
 * 역순 순회로 `limit` 건을 채우면 즉시 중단하므로, 15분 버퍼에 수천 건이 쌓여도
 * 비용은 표시 건수에 비례한다(150ms flush 마다 전량 평탄화하는 낭비 회피).
 */
export function buildTradeTickView(
  snapshots: readonly TradeSnapshot[],
  limit: number,
): TradeTickView {
  if (limit <= 0 || snapshots.length === 0) return EMPTY_VIEW;

  const ticks: TradeTick[] = [];
  let prevClose: number | null = null;
  // 동일 (t_ms, price, qty, side) 체결이 실제로 중복될 수 있어(같은 초·같은 호가·같은
  // 수량) 값만으로는 key 가 충돌한다. 등장 순번을 붙여 유일하게 만든다.
  const dupCount = new Map<string, number>();

  outer: for (let i = snapshots.length - 1; i >= 0; i--) {
    const snap = snapshots[i];
    if (prevClose === null) prevClose = finiteNumber(snap.prev_close);
    const trades = snap.trades;
    if (!Array.isArray(trades)) continue;
    // 스냅샷 **안**도 역순 — 배열 뒤쪽이 나중 체결이다.
    for (let j = trades.length - 1; j >= 0; j--) {
      const raw: unknown = trades[j];
      if (!isRecord(raw)) continue;
      const price = finiteNumber(raw.price);
      const qty = finiteNumber(raw.qty);
      if (price === null || qty === null || price <= 0 || qty <= 0) continue;
      const side = finiteNumber(raw.side) ?? 0;
      // 체결 시각은 체결 레코드 우선(0B 원본), 없으면 스냅샷 시각으로 폴백.
      const tMs = finiteNumber(raw.t_ms) ?? snap.t_ms;
      const base = `${tMs}-${price}-${qty}-${side}`;
      const seq = dupCount.get(base) ?? 0;
      dupCount.set(base, seq + 1);
      ticks.push({ tMs, price, qty, side, key: `${base}-${seq}` });
      if (ticks.length >= limit) break outer;
    }
  }

  return { ticks, prevClose };
}
