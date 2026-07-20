"""LiveStream — WS 수집 오케스트레이터 (spec §6·§7).

per-tick: LiveBuffer.publish (표시, sub-second / ADR-0053 다운스트림 무변경)
10초:    TickDownsampler.flush → LiveWriter.append (저장; ADR-0038 hot-path
         invariant — JSONL만 쓴다)
게이팅:  session_gate.ws_capture_window(09:00–15:30, advisor B) — 밖에선
         flush 안 함 + WS (재)연결 보류. 장후 시간외는 의도적 회귀(spec §11).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

from .ask_peak_state import TodayAskPeakState, TodayBidPeakState
from .buffer import LiveBuffer
from .downsampler import TickDownsampler
from .lifecycle import get_signal_alert_monitor
from . import program_trade_latch
from .session_gate import market_phase, ws_capture_window_async
from .snapshot import LiveSnapshot, SnapshotKind
from .ticks import WsTick
from .writer import LiveWriter

_log = logging.getLogger(__name__)

FLUSH_INTERVAL_S = 10.0
IDLE_INTERVAL_S = 1.0  # 게이트 밖 폴링 주기 — 테스트에서 monkeypatch(리뷰 R3)
AUCTION_BOOK_DEPTH = 3


def _now_ms() -> int:
    return int(time.time() * 1000)


def _is_continuous_book(
    asks: Sequence[Mapping[str, object]],
    bids: Sequence[Mapping[str, object]],
) -> bool:
    return _has_deep_qty(asks) and _has_deep_qty(bids)


def _has_deep_qty(levels: Sequence[Mapping[str, object]]) -> bool:
    for level in levels[AUCTION_BOOK_DEPTH:]:
        qty = level.get("qty")
        if type(qty) is int and qty > 0:
            return True
    return False


def _next_window_delay_s(now_s: float, interval_s: float) -> float:
    """다음 벽시계 윈도 경계까지의 지연(초) — 리뷰 #5.

    flush 윈도를 벽시계 경계(k·interval)에 정렬해 fills.py의 '10초는 모든
    bucket_ms(60s~1800s)에 정확히 중첩' 전제를 실제로 보장한다. 고정 주기
    sleep은 게이트 개방 시각에 위상이 박혀 분 경계를 걸치는 윈도를 만든다.
    경계 정각이면 한 윈도 전체를 기다린다(0 sleep 재진입 방지)."""
    return interval_s - (now_s % interval_s)


class LiveStream:
    def __init__(
        self,
        *,
        buffer: LiveBuffer,
        writer: LiveWriter,
        date_fn: Callable[[], str],
        phase_fn: Callable[[], str] | None = None,
    ) -> None:
        self._buffer = buffer
        self._writer = writer
        self._date_fn = date_fn
        self._phase_fn = phase_fn or (lambda: market_phase(_now_ms()))
        self._ds = TickDownsampler()
        # 리뷰 #6: on_tick 입구 필터용 활성 집합. None = 미설정(무필터 —
        # set_active_codes 전 부분 조립·단위 테스트 호환); 실경로는
        # start(_start_live_stream_locked)와 refresh가 항상 설정한다.
        self._active_codes: set[str] | None = None
        self.last_flush_ms: int | None = None
        self._last_flush_date: str | None = None  # R1: 미관측 일경계 백스톱
        # R2: 게이트 판정은 flush 루프가 1Hz로 유지 — on_tick은 이 플래그만 읽는다
        # (per-tick 달력 평가는 fetch 실패 모드에서 틱당 동기 네트워크 콜이 됨).
        self._gate_open: bool = False
        self._ask_peak_by_code: dict[str, TodayAskPeakState] = {}
        self._bid_peak_by_code: dict[str, TodayBidPeakState] = {}
        self._ask_peak_date: str | None = None

    def set_active_codes(self, codes: set[str]) -> None:
        """Live Set 변경 위임 — start/refresh_live_stream이 호출(advisor C)."""
        self._active_codes = set(codes)
        self._ds.set_active_codes(codes)
        for code in set(self._ask_peak_by_code) - self._active_codes:
            del self._ask_peak_by_code[code]
        for code in set(self._bid_peak_by_code) - self._active_codes:
            del self._bid_peak_by_code[code]

    def _reset_ask_peak_if_date_changed(self) -> None:
        date = self._date_fn()
        if self._ask_peak_date is None:
            self._ask_peak_date = date
            return
        if date != self._ask_peak_date:
            self._ask_peak_by_code.clear()
            self._bid_peak_by_code.clear()
            self._ask_peak_date = date

    def _ask_peak_state(self, code: str) -> TodayAskPeakState:
        self._reset_ask_peak_if_date_changed()
        return self._ask_peak_by_code.setdefault(code, TodayAskPeakState())

    def _bid_peak_state(self, code: str) -> TodayBidPeakState:
        self._reset_ask_peak_if_date_changed()
        return self._bid_peak_by_code.setdefault(code, TodayBidPeakState())

    def ask_peak_snapshot(self, code: str) -> dict | None:
        self._reset_ask_peak_if_date_changed()
        state = self._ask_peak_by_code.get(code)
        if state is None:
            return None
        snap = state.snapshot()
        if snap is None:
            return None
        return {"date": self._ask_peak_date, **snap}

    def bid_peak_snapshot(self, code: str) -> dict | None:
        self._reset_ask_peak_if_date_changed()
        state = self._bid_peak_by_code.get(code)
        if state is None:
            return None
        snap = state.snapshot()
        if snap is None:
            return None
        return {"date": self._ask_peak_date, **snap}

    def seed_ask_peak_from_live_file(self, *, code: str, date: str, live_root: Path) -> None:
        """Replay today's persisted JSONL into this stream's ask-peak state."""
        path = live_root / date / f"{code}.jsonl"
        if not path.exists():
            return
        state = self._ask_peak_state(code)
        loaded = False

        try:
            with path.open("r", encoding="utf-8") as f:
                for raw in f:
                    row = raw.rstrip("\n")
                    if not row:
                        continue
                    try:
                        payload = json.loads(row)
                    except json.JSONDecodeError:
                        continue

                    try:
                        tick_kind = SnapshotKind(payload.get("kind"))
                    except ValueError:
                        continue
                    t_ms = payload.get("t_ms")
                    if type(t_ms) is not int:
                        continue
                    loaded = True
                    self._ingest_ask_peak(
                        WsTick(code=code, t_ms=t_ms, kind=tick_kind, payload=payload.get("payload") or {}),
                    )
        except OSError:
            return

        if loaded:
            state.coverage = "full"

    def seed_bid_peak_from_live_file(self, *, code: str, date: str, live_root: Path) -> None:
        """Replay today's persisted JSONL into this stream's bid-peak state."""
        path = live_root / date / f"{code}.jsonl"
        if not path.exists():
            return
        state = self._bid_peak_state(code)
        loaded = False

        try:
            with path.open("r", encoding="utf-8") as f:
                for raw in f:
                    row = raw.rstrip("\n")
                    if not row:
                        continue
                    try:
                        payload = json.loads(row)
                    except json.JSONDecodeError:
                        continue

                    try:
                        tick_kind = SnapshotKind(payload.get("kind"))
                    except ValueError:
                        continue
                    t_ms = payload.get("t_ms")
                    if type(t_ms) is not int:
                        continue
                    loaded = True
                    self._ingest_bid_peak(
                        WsTick(code=code, t_ms=t_ms, kind=tick_kind, payload=payload.get("payload") or {}),
                    )
        except OSError:
            return

        if loaded:
            state.coverage = "full"

    def _ingest_ask_peak(self, tick: WsTick) -> None:
        if tick.kind is SnapshotKind.TRADE:
            state: TodayAskPeakState | None = None
            trades = tick.payload.get("trades")
            if not isinstance(trades, Sequence) or isinstance(trades, (str, bytes)):
                return
            for trade in trades:
                if not isinstance(trade, Mapping):
                    continue
                try:
                    price = int(trade["price"])
                    side = int(trade["side"])
                except (KeyError, TypeError, ValueError):
                    continue
                if state is None:
                    state = self._ask_peak_state(tick.code)
                trade_t_ms = trade.get("t_ms")
                trade_seq = trade.get("seq")
                state.ingest_trade(
                    price=price,
                    side=side,
                    t_ms=trade_t_ms if type(trade_t_ms) is int else tick.t_ms,
                    seq=trade_seq if type(trade_seq) is int else None,
                )
            return

        if tick.kind is SnapshotKind.OB:
            if market_phase(tick.t_ms) != "regular":
                return
            asks = tick.payload.get("asks")
            if not isinstance(asks, Sequence) or isinstance(asks, (str, bytes)):
                return
            valid_asks = [ask for ask in asks if isinstance(ask, Mapping)]
            if not valid_asks:
                return
            bids = tick.payload.get("bids")
            valid_bids = (
                [bid for bid in bids if isinstance(bid, Mapping)]
                if isinstance(bids, Sequence) and not isinstance(bids, (str, bytes))
                else []
            )
            if not _is_continuous_book(valid_asks, valid_bids):
                return
            self._ask_peak_state(tick.code).ingest_orderbook(
                t_ms=tick.t_ms,
                asks=valid_asks,
            )

    def _ingest_bid_peak(self, tick: WsTick) -> None:
        if tick.kind is SnapshotKind.TRADE:
            state: TodayBidPeakState | None = None
            trades = tick.payload.get("trades")
            if not isinstance(trades, Sequence) or isinstance(trades, (str, bytes)):
                return
            for trade in trades:
                if not isinstance(trade, Mapping):
                    continue
                try:
                    price = int(trade["price"])
                    side = int(trade["side"])
                except (KeyError, TypeError, ValueError):
                    continue
                if state is None:
                    state = self._bid_peak_state(tick.code)
                trade_t_ms = trade.get("t_ms")
                trade_seq = trade.get("seq")
                state.ingest_trade(
                    price=price,
                    side=side,
                    t_ms=trade_t_ms if type(trade_t_ms) is int else tick.t_ms,
                    seq=trade_seq if type(trade_seq) is int else None,
                )
            return

        if tick.kind is SnapshotKind.OB:
            if market_phase(tick.t_ms) != "regular":
                return
            asks = tick.payload.get("asks")
            valid_asks = (
                [ask for ask in asks if isinstance(ask, Mapping)]
                if isinstance(asks, Sequence) and not isinstance(asks, (str, bytes))
                else []
            )
            bids = tick.payload.get("bids")
            if not isinstance(bids, Sequence) or isinstance(bids, (str, bytes)):
                return
            valid_bids = [bid for bid in bids if isinstance(bid, Mapping)]
            if not valid_bids:
                return
            if not _is_continuous_book(valid_asks, valid_bids):
                return
            self._bid_peak_state(tick.code).ingest_orderbook(
                t_ms=tick.t_ms,
                bids=valid_bids,
            )

    async def on_tick(self, tick: WsTick) -> None:
        """ws_client 콜백 — 표시 경로(즉시·무게이트) + 저장 경로(누적·게이트)."""
        # 활성 집합 필터(리뷰 #6): unsubscribe 직후 도착한 in-flight 잔여
        # 프레임이 ingest의 setdefault로 퇴출 코드 상태를 부활시키면, 매 10초
        # flush가 게이트 마감까지 유령 carry/zero-fill을 쓰고 promote가
        # parquet으로 영구화한다. 표시 ring(buffer)도 drop_codes_except 후
        # 재생성되므로 표시·저장 모두 입구에서 드롭.
        if self._active_codes is not None and tick.code not in self._active_codes:
            return
        # 프로그램매매(0w, PR-F4)는 표시 버퍼·JSONL 저장을 타지 않는다 — 최신값
        # latch 에만 남기고 종료(ProgramTradeCollector 가 30초 주기로 drain →
        # program_trade_store 병합). KRX 한정: 프로그램 수급은 KRX 집계 데이터다.
        if tick.kind is SnapshotKind.PROGRAM:
            if tick.venue == "KRX":
                program_trade_latch.update(tick.code, dict(tick.payload))
            return
        # phase 이중 스탬프(M1): 여기 phase는 **표시 스냅샷 전용** — 수신 벽시계
        # 기준 위상을 buffer 스냅에 박는다(tick.t_ms 거래소 시각이 아니라 도착
        # 시점). 저장 경로의 위상은 별개로 flush 시점에 _ds.flush(phase=...)가
        # 박는다(M2 참고) — ingest는 raw tick만 받으므로 이 phase를 안 본다.
        phase = self._phase_fn()
        # venue 태그를 표시 스냅샷에 실어 프론트가 KRX/NXT를 구분(#524). 추가 키라
        # 하위호환(구프론트 무시); 저장 스키마는 아래 KRX 격리로 무영향.
        snap = LiveSnapshot(t_ms=tick.t_ms, kind=tick.kind,
                            payload={**tick.payload, "phase": phase, "venue": tick.venue})
        # 표시 경로는 §11에 따라 무게이트 — KRX/NXT 모두 항상 publish. 시분할 스왑이
        # KRX를 정규장에만 구독하므로 KRX 틱이 장전에 도착해 유령 캔들을 만들 일은 없다.
        await self._buffer.publish(tick.code, [snap], now_ms=_now_ms())
        # ── 성역 격리(#524): 저장·집계·피크·시그널은 KRX 전용 ──────────────────
        # NXT 틱은 표시(위 publish)만 하고 여기서 리턴 — KRX 정규장 캡처 경로를
        # byte-for-byte 불변으로 유지한다(정규장엔 KRX만 구독되므로 이 가드는
        # 방어적이며, 경계 스왑 타이밍 오차에도 NXT가 저장에 새지 않게 봉인).
        if tick.venue != "KRX":
            return
        self._ingest_ask_peak(tick)
        self._ingest_bid_peak(tick)
        if tick.kind is SnapshotKind.OB:
            asks = tick.payload.get("asks")
            valid_asks = (
                [ask for ask in asks if isinstance(ask, Mapping)]
                if isinstance(asks, Sequence) and not isinstance(asks, (str, bytes))
                else []
            )
            bids = tick.payload.get("bids")
            valid_bids = (
                [bid for bid in bids if isinstance(bid, Mapping)]
                if isinstance(bids, Sequence) and not isinstance(bids, (str, bytes))
                else []
            )
            total_ask = tick.payload.get("total_ask_qty")
            if (
                market_phase(tick.t_ms) == "regular"
                and _is_continuous_book(valid_asks, valid_bids)
                and type(total_ask) is int
            ):
                monitor = get_signal_alert_monitor()
                if monitor is not None:
                    monitor.ingest_orderbook(
                        code=tick.code,
                        name=tick.code,
                        t_ms=tick.t_ms,
                        total_ask_qty=total_ask,
                        source="ws",
                    )
        # 저장 경로만 게이트 — 15:30 이후 잔여 틱이 다운샘플러에 누적돼 밤을
        # 넘기는 것을 차단(리뷰 C1 벡터 1). 판정은 flush 루프가 유지하는
        # 플래그(리뷰 R2 — per-tick 달력 평가 금지); 닫힘 직후 ≤10s의 잔여
        # ingest는 전환 drain이 마감 당일로 귀속한다.
        if self._gate_open:
            self._ds.ingest(tick)

    async def flush_once(self, *, now_ms: int | None = None) -> None:
        now_ms = now_ms if now_ms is not None else _now_ms()
        # date/phase는 flush 호출 시점의 샘플 — 윈도 내 틱들이 아니라 마감 순간의
        # 날짜·위상으로 귀속된다(M2). 게이트 닫힘 전환 drain은 15:30:0x 수 초 내라
        # date_fn이 아직 당일이어서 마지막 부분 윈도가 올바른 날짜로 기록된다.
        date = self._date_fn()
        if self._last_flush_date is not None and date != self._last_flush_date:
            # 미관측 일경계(suspend/시계 점프 — 리뷰 R1): 어제 잔여 상태가
            # 오늘 날짜로 기록되는 것을 차단. KRX 세션은 자정을 넘지 않으므로
            # 날짜 변화 시 reset은 항상 안전하다(정상 경로에선 drain이 이미 비움).
            self._ds.reset()
            _log.warning("live.stream.stale_state_reset prev=%s now=%s",
                         self._last_flush_date, date)
        self._last_flush_date = date
        # fill 윈도 시작 라벨(리뷰 #5): 직전 flush 시각이 곧 이번 윈도의 시작.
        # 첫 flush는 직전 시각이 없어 now − FLUSH_INTERVAL 폴백(루프 첫 회는
        # 다운샘플러가 비어 있어 라벨이 행에 붙을 일도 없다).
        fill_t_ms = (self.last_flush_ms if self.last_flush_ms is not None
                     else now_ms - int(FLUSH_INTERVAL_S * 1000))
        flushed = self._ds.flush(now_ms=now_ms, phase=self._phase_fn(),
                                 fill_t_ms=fill_t_ms)
        # per-code 격리 + subtract-on-commit(spec 2026-06-08 flush-durability):
        # append 성공한 코드만 commit_code로 '본 흐름 합'을 빼고, 실패한 코드는
        # commit을 건너뛰어 합이 다음 윈도로 롤된다(데이터 보존). 한 코드의
        # 디스크 오류가 다른 코드의 윈도를 폐기하지 않는다(현재는 첫 실패가
        # flush_once 전체를 중단). flush는 더 이상 리셋하지 않으므로 commit이
        # 유일한 합 차감 경로다.
        for code, snaps in flushed.items():
            try:
                await self._writer.append(date, code, snaps)
            except OSError:
                _log.exception("live.stream.append_failed code=%s", code)
                continue  # commit 안 함 → 합 보존 → 다음 윈도 롤
            fill = next((s for s in snaps if s.kind is SnapshotKind.FILL), None)
            trade = next((s for s in snaps if s.kind is SnapshotKind.TRADE), None)
            if fill is not None:
                self._ds.commit_code(
                    code, buy_qty=fill.payload["buy_qty"],
                    sell_qty=fill.payload["sell_qty"],
                    trades=trade.payload["trades"] if trade is not None else None,
                )
        await self._writer.fsync_all()
        self.last_flush_ms = now_ms

    async def run_flush_loop(self) -> None:
        """10초 flush 루프 — lifecycle이 task로 돌린다. 게이트 밖(장외·15:30 이후)엔
        1초 idle — advisor B: 15:30 이후 쓰기를 막아 유령 carry를 차단한다.

        게이트가 닫히는 전환 순간 drain flush 1회(마지막 부분 윈도를 **마감 당일**
        날짜로 기록) 후 다운샘플러를 reset — 흐름 합·carry가 밤을 넘겨 다음
        거래일 JSONL을 오염시키지 않게 한다(리뷰 C1)."""
        was_open = False
        while True:
            # 캘린더 게이트는 콜드/네거티브 캐시에서 동기 KIS HTTP(timeout 15s)를
            # 부른다 — async 진입점이 to_thread 격리를 봉인(blocking 계약이 시그니처에).
            open_now = await ws_capture_window_async(_now_ms())
            self._gate_open = open_now  # R2: on_tick의 ingest 게이트 플래그 갱신
            if open_now:
                try:
                    await self.flush_once()
                except Exception:  # noqa: BLE001
                    _log.exception("live.stream.flush_failed")
                # 벽시계 경계 정렬(리뷰 #5) — 고정 주기 드리프트 제거: 윈도
                # [k·10s, (k+1)·10s)가 분봉 경계에 정확히 중첩되게 한다.
                await asyncio.sleep(
                    _next_window_delay_s(time.time(), FLUSH_INTERVAL_S)
                )
            else:
                if was_open:  # open→closed 전환: drain + 상태 초기화
                    try:
                        await self.flush_once()
                    except Exception:  # noqa: BLE001
                        _log.exception("live.stream.drain_flush_failed")
                    self._ds.reset()
                    # 일경계 상태 리셋(spec 2026-06-08 §2.4): _last_flush_date를
                    # None으로 둬 다음 개장 첫 flush가 어제 날짜와 비교해 R1
                    # 경고를 내지 않게(#15), last_flush_ms도 None으로 둬 재개방
                    # 첫 윈도 fill 라벨이 now−FLUSH_INTERVAL로 폴백(ship 스킵분).
                    # R1 백스톱은 보존: drain 없이 날짜가 바뀌는 진짜 케이스
                    # (suspend/시계점프)에선 _last_flush_date가 남아 경고가 정상 발화.
                    self._last_flush_date = None
                    self.last_flush_ms = None
                    _log.info("live.stream.gate_closed_drained")
                await asyncio.sleep(IDLE_INTERVAL_S)
            was_open = open_now
