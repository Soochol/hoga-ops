from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from hoga.api.models import SellTotalRenewalSettings, SignalAlertEvent, SignalAlertSource
from hoga.live.signal_alerts import append_signal_alert, load_signal_alert_settings

_KST = timezone(timedelta(hours=9))
_REARM_RATIO = 0.85
_EPOCH_MS_THRESHOLD = 10_000_000_000


def _is_epoch_ms(t_ms: int) -> bool:
    return t_ms >= _EPOCH_MS_THRESHOLD


def _hhmm_from_ms(t_ms: int) -> int:
    if _is_epoch_ms(t_ms):
        dt = datetime.fromtimestamp(t_ms / 1000, tz=_KST)
        return dt.hour * 100 + dt.minute
    return t_ms // 100


def _date_from_ms(t_ms: int) -> str:
    return datetime.fromtimestamp(t_ms / 1000, tz=_KST).strftime("%Y%m%d")


def _minute_bucket(t_ms: int) -> int:
    if _is_epoch_ms(t_ms):
        return t_ms // 60_000
    return t_ms // 100


@dataclass
class _CodeState:
    date: str
    baseline: int = 0
    armed: bool = True
    minute_bucket: int | None = None
    minute_max: int = 0


class SignalAlertMonitor:
    def __init__(
        self,
        data_dir: Path,
        publish: Callable[[dict], None],
        date_fn: Callable[[int], str] | None = None,
    ) -> None:
        self._data_dir = data_dir
        self._publish = publish
        self._date_fn = date_fn or _date_from_ms
        self._settings = load_signal_alert_settings(data_dir).sell_total_renewal
        self._targets: set[str] = set()
        self._target_names: dict[str, str] = {}
        self._state: dict[str, _CodeState] = {}

    def refresh_settings(self) -> SellTotalRenewalSettings:
        self._settings = load_signal_alert_settings(self._data_dir).sell_total_renewal
        return self._settings

    def set_targets(self, targets: set[str] | Mapping[str, str]) -> None:
        if isinstance(targets, Mapping):
            self._targets = set(targets)
            self._target_names = {code: name or code for code, name in targets.items()}
        else:
            self._targets = set(targets)
            self._target_names = {code: self._target_names.get(code, code) for code in targets}
        self._state = {
            code: state for code, state in self._state.items() if code in self._targets
        }

    def ingest_orderbook(
        self,
        code: str,
        name: str,
        t_ms: int,
        total_ask_qty: int,
        source: SignalAlertSource,
    ) -> SignalAlertEvent | None:
        if code not in self._targets or total_ask_qty <= 0:
            return None

        settings = self._settings
        if not settings.enabled:
            return None

        date = self._date_fn(t_ms)
        state = self._state.get(code)
        if state is None or state.date != date:
            state = _CodeState(date=date)
            self._state[code] = state

        hhmm = _hhmm_from_ms(t_ms)
        candidate = int(total_ask_qty)
        if hhmm < settings.start_hhmm:
            state.baseline = max(state.baseline, candidate)
            return None
        if state.baseline <= 0:
            return None

        if settings.use_intra_minute_max:
            bucket = _minute_bucket(t_ms)
            if state.minute_bucket != bucket:
                state.minute_bucket = bucket
                state.minute_max = candidate
            else:
                state.minute_max = max(state.minute_max, candidate)
            candidate = state.minute_max

        if candidate < state.baseline * _REARM_RATIO:
            state.armed = True
        elif state.armed and candidate >= (state.baseline * settings.threshold_pct / 100):
            event = append_signal_alert(
                self._data_dir,
                SignalAlertEvent(
                    id=f"{date}:{code}:sell_total_renewal:0:{source}",
                    signal="sell_total_renewal",
                    seq=0,
                    code=code,
                    name=self._target_names.get(code, name),
                    t_ms=t_ms,
                    date=date,
                    source=source,
                    value=candidate,
                    baseline=state.baseline,
                    ratio_pct=round(candidate / state.baseline * 100, 1),
                    use_intra_minute_max=settings.use_intra_minute_max,
                ),
            )
            self._publish(event.model_dump(mode="json"))
            state.armed = False
            return event
        return None
