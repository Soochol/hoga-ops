"""야간 선물 세션 기록 — 낮에 "어젯밤" 을 보여줄 수 있는 **유일한** 경로.

**벤더는 야간을 소급해 주지 않는다.** 2026-08-08 실측:

    분봉 F 20260807 154500 앵커 → 83봉 15:45→08:45   (주간 전 구간)
    분봉 F 20260807 235500 앵커 → 83봉 15:45→08:45   ← 앵커를 야간으로 줘도 같다
    분봉 F 20260808 045500 앵커 →  0봉   ← 존재하지 않는 코드(ZZ9999)와 응답이 동일
    분봉 MF(야간 분류코드 후보)  → OPSQ2001 ERROR INVALID
    일봉 D 20260807             → 종가 978.75 = 그날 15:45 주간 마감값

`MF` 가 **명시적으로 거부당한 것**이 가장 강한 증거다. 이 API 의 다른 실패는 전부
`rt_cd=0` + 빈 데이터라 미지원과 파라미터 오류가 구분되지 않는데(fail-open), 거기서만
벤더가 대놓고 아니라고 했다.

따라서 **저장하지 않은 야간은 영영 없다.** 소급 백필이 원리적으로 불가능하므로,
이 모듈이 쓰지 않은 밤은 복구 경로가 0이다. 그 점에서 여기 저장은 편의가 아니라
`market_routes` 모듈 docstring 이 세운 기준 — "결손이 영구 구멍인가" — 의 정확한
해당 사례다.

**읽기는 아직 어느 라우트에도 연결돼 있지 않다.** 낮에 전날 야간을 표시하는 화면이
다음 단계이고, 그 화면은 이 모듈이 **하룻밤 돌아야** 검증할 데이터가 생긴다. 지금
읽기까지 두는 것은 포맷을 왕복으로 고정해 두기 위해서다 — 쓰기만 있으면 다음 단계에서
포맷이 틀렸다는 것을 하룻밤 뒤에야 알게 된다.

파일 부재는 **정상 상태**다(그 밤에 틱이 없었거나 프로세스가 안 떠 있었다). 리더가
막고, 호출자는 `None` 을 "모른다" 로 읽어야 한다 — 0 으로 채우면 "야간에 0원" 이 된다.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

#: 저장 포맷 버전. 모르는 버전은 읽지 않는다(조용히 잘못 해석하느니 없다고 답한다).
_FORMAT_VERSION = 1

_DIR_NAME = "futures_night"


@dataclass(frozen=True)
class NightQuoteRecord:
    """야간 세션이 끝난 시점의 한 종목 — 카드가 그리는 데 필요한 것 전부.

    필드가 `NightTick` 과 거의 같은 것은 우연이 아니다. 다만 **`bars` 가 추가**된다 —
    값만 남기면 다음 날 카드에 숫자는 뜨는데 스파크라인이 빈다. 그 그림도 소급
    불가라 같이 저장하지 않으면 같은 이유로 영영 없다.
    """
    code: str
    price: float
    change: float
    change_rate: float
    volume: int
    open_interest: int
    oi_change: int
    market_basis: float | None
    disparity: float | None
    #: 마지막 체결의 벤더 시각 `HHMMSS`. 수신 시각이 아니다.
    bsop_hour: str
    t_ms: int
    #: 5분봉 `{버킷 인덱스: 종가}`. 원점은 **18:00** 이다(`kis_futures_ws._bucket_of`) —
    #: 자정을 넘는 세션이라 시계 그대로 정렬하면 새벽이 저녁 앞에 온다.
    bars: dict[int, float]


@dataclass(frozen=True)
class NightSessionRecord:
    """야간장 하루치. `session_day` 는 그 야간장이 속한 **거래일**이다.

    새벽 02:00 은 전날 야간장이므로 `spark_date` 와 같은 규칙으로 정해야 한다 —
    벽시계 날짜를 쓰면 한 세션이 두 파일로 쪼개진다.
    """
    session_day: str
    updated_ms: int
    #: 카드 id(`KOSPI200_F`) → 기록. **종목코드가 아니라 카드 id 로 키잉한다** —
    #: 롤오버로 근월물 코드가 바뀌면(3개월마다) 코드 키는 어제 기록을 못 찾는다.
    quotes: dict[str, NightQuoteRecord]


def session_dir(data_dir: Path) -> Path:
    return data_dir / _DIR_NAME


def session_path(data_dir: Path, session_day: str) -> Path:
    return session_dir(data_dir) / f"{session_day}.json"


def save_session(data_dir: Path, record: NightSessionRecord) -> None:
    """세션 기록을 원자적으로 쓴다. **빈 기록은 쓰지 않는다.**

    빈 파일을 남기면 "그 밤에 거래가 없었다" 와 "우리가 못 봤다" 가 디스크에서
    같아진다 — 야간 무음은 저유동성 상품에서 정상이라 이 둘의 구분이 곧 데이터의
    신뢰도다. 파일이 없으면 후자로 읽는 편이 안전하다.

    세션이 진행되는 동안 **같은 파일을 계속 덮어쓴다**. 마지막 쓰기가 곧 그날의
    최종 상태이고, 중간에 프로세스가 죽어도 그때까지가 남는다.
    """
    if not record.quotes:
        return
    path = session_path(data_dir, record.session_day)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "v": _FORMAT_VERSION,
        "session_day": record.session_day,
        "updated_ms": record.updated_ms,
        "quotes": {
            card_id: {
                "code": q.code,
                "price": q.price,
                "change": q.change,
                "change_rate": q.change_rate,
                "volume": q.volume,
                "open_interest": q.open_interest,
                "oi_change": q.oi_change,
                "market_basis": q.market_basis,
                "disparity": q.disparity,
                "bsop_hour": q.bsop_hour,
                "t_ms": q.t_ms,
                # JSON 객체 키는 문자열뿐이다 — 읽을 때 int 로 되돌린다.
                "bars": {str(k): v for k, v in sorted(q.bars.items())},
            }
            for card_id, q in record.quotes.items()
        },
    }
    # 원자 교체 — 세션 중 매 분 덮어쓰므로, 부분 쓰기 상태에서 프로세스가 죽으면
    # 그날 기록이 통째로 깨진다(그리고 소급 복구가 없다).
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)
        os.replace(tmp_name, path)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise


def _parse_quote(raw: dict) -> NightQuoteRecord | None:
    try:
        bars = {int(k): float(v) for k, v in (raw.get("bars") or {}).items()}
        return NightQuoteRecord(
            code=str(raw["code"]),
            price=float(raw["price"]),
            change=float(raw["change"]),
            change_rate=float(raw["change_rate"]),
            volume=int(raw["volume"]),
            open_interest=int(raw["open_interest"]),
            oi_change=int(raw["oi_change"]),
            market_basis=None if raw.get("market_basis") is None else float(raw["market_basis"]),
            disparity=None if raw.get("disparity") is None else float(raw["disparity"]),
            bsop_hour=str(raw.get("bsop_hour") or ""),
            t_ms=int(raw["t_ms"]),
            bars=bars,
        )
    except (KeyError, TypeError, ValueError):
        # 한 종목이 깨졌다고 그날 전체를 버리지 않는다 — 나머지는 여전히 참이다.
        return None


def load_session(data_dir: Path, session_day: str) -> NightSessionRecord | None:
    """그 야간장의 기록. **없으면 None** — 파일 부재는 오류가 아니라 정상 상태다.

    깨진 파일도 `None` 이다. 되살릴 방법이 없으니 예외로 올려 호출자를 죽이는 것보다
    "그 밤은 모른다" 로 답하는 편이 카드 한 장을 비우는 데서 끝난다.
    """
    path = session_path(data_dir, session_day)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as e:
        log.warning("야간 기록 읽기 실패 %s: %s", path, e)
        return None
    if not isinstance(raw, dict) or raw.get("v") != _FORMAT_VERSION:
        log.warning("야간 기록 포맷 불일치 %s: v=%r", path, raw.get("v") if isinstance(raw, dict) else None)
        return None
    quotes: dict[str, NightQuoteRecord] = {}
    for card_id, q_raw in (raw.get("quotes") or {}).items():
        if isinstance(q_raw, dict) and (parsed := _parse_quote(q_raw)) is not None:
            quotes[str(card_id)] = parsed
    if not quotes:
        return None
    return NightSessionRecord(
        session_day=str(raw.get("session_day") or session_day),
        updated_ms=int(raw.get("updated_ms") or 0),
        quotes=quotes,
    )


def latest_session_day(data_dir: Path, *, before: str | None = None) -> str | None:
    """가장 최근 기록의 거래일. `before` 를 주면 **그날은 빼고** 그 이전에서 찾는다.

    낮에 "어젯밤" 을 보여줄 때 오늘 밤 파일(이미 쌓이기 시작한 것)을 집지 않으려면
    `before` 가 필요하다. 없으면 None — 아직 아무 밤도 기록하지 못한 상태이고,
    저장을 켠 첫날이 정확히 그 상태다.
    """
    directory = session_dir(data_dir)
    try:
        days = sorted(p.stem for p in directory.glob("*.json") if p.stem.isdigit())
    except OSError:
        return None
    if before is not None:
        days = [d for d in days if d < before]
    return days[-1] if days else None
