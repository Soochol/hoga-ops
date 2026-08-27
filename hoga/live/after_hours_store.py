"""시간외 단일가 마지막 호가의 **일자별 경량 저장** — 창 밖 조회의 유일한 소스.

## 왜 저장이 필요한가

`ka10087` 은 16:00–18:00 에만 답한다(그 밖에서는 라우트가 벤더를 아예 치지 않는다 —
`kiwoom_after_hours` 모듈 docstring). 그래서 18:00 이 지나면 그날 시간외 호가를 볼
방법이 **없다**: WS 경로가 아니라 링버퍼에도 안 쌓이고, 3초 TTL 캐시는 이름 그대로
캐시다. 저녁에 브라우저를 새로 열면 오늘 시간외가 통째로 사라진다.

이 모듈이 그 구멍만 닫는다 — 종목당 **마지막 한 장**.

## 정규장 파케이에 넣지 않는다

`tables/snapshots` 스키마는 10단 고정이고 하류에 피크월·히트맵 소비자가 붙어 있다.
5단짜리 시간외를 zero-pad 로 섞으면 그 소비자들이 시간외 사다리를 정규장 호가로
읽는다. 축이 다른 데이터를 같은 표에 넣지 않는 것이 싸다 — 종목당 하루 한 줄이라
JSON 한 파일로 충분하다.

## 시각은 `fetched_at_ms` 다 — `base_tm` 이 아니다

벤더의 `bid_req_base_tm` 은 2026-08-19 실측(117표본 20분)에서 `"160000"` 에 고정된
채 한 번도 움직이지 않았다. 그것을 "언제 값인가" 로 쓰면 저장본이 전부 16:00 으로
찍힌다. 보관은 하되(원본 보존) 신선도 판단에는 쓰지 않는다.

## writer 는 폴러 하나뿐이다

라우트는 읽기만 한다. 그래서 잠금이 없고, 대신 **한 주기의 결과를 모아 한 번**
쓴다(`save_cycle`) — 종목마다 read-modify-write 하면 같은 파일을 주기당 N 번 다시
쓰게 되고, 중간에 죽으면 부분 상태가 남는다. temp + rename 이라 독자는 언제 읽어도
온전한 한 주기를 본다.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from hoga.util.timeenc import KST

log = logging.getLogger(__name__)

#: 저장 루트(데이터 디렉터리 상대). 일자별 파일 하나.
_DIRNAME = "after_hours"
#: 스키마 버전. 필드를 늘릴 때 올리고, 낮은 버전은 **버리지 말고** 읽을 수 있는
#: 만큼 읽는다 — 하루치 편의 데이터라 마이그레이션 비용을 들일 값이 아니다.
_SCHEMA = 1


@dataclass(frozen=True)
class StoredAfterHoursBook:
    """저장된 시간외 5단 호가 한 장. 필드는 `AfterHoursBook` 의 부분집합이다.

    **예상체결(`exp_*`)을 담지 않는다.** 그 값은 "지금 접수 상황으로 보면 이 가격에
    체결될 것" 이라는 뜻이라 **체결이 끝난 뒤에는 의미가 없다** — 저녁에 보는 화면에
    "예상" 을 띄우면 그것이 확정 체결인지 아닌지를 말할 방법이 없다.

    (폴러가 그 TR 을 안 치는 것은 아니다. `get()` 재사용이라 `ka10001` 도 함께 나가고
    결과를 버릴 뿐이다 — 이유는 `start_after_hours_recorder` 의 유량 절.)
    """

    code: str
    #: (price, qty) 5쌍. index 0 = 최우선호가. 빈 단계는 `(0, 0)`.
    ask: tuple[tuple[int, int], ...]
    bid: tuple[tuple[int, int], ...]
    total_ask_qty: int
    total_bid_qty: int
    cur_price: int | None
    close_price: int | None
    acc_volume: int
    base_tm: str | None
    #: 관측 시각. 신선도의 유일한 근거다(모듈 docstring).
    fetched_at_ms: int


def today_kst_yyyymmdd() -> str:
    """오늘(KST) — 폴러가 쓰는 저장 키이자 라우트가 쓰는 조회 키.

    **두 곳이 같은 정의를 봐야 한다.** 갈리면 폴러가 적은 파일을 라우트가 못 찾는다.
    그리고 이 함수가 정책 한 조항을 자동으로 파생시킨다: 자정을 넘기면 어제 파일은
    더 이상 "오늘" 이 아니라 조회가 비고, 그것이 곧 "장중 시간외 = 없음" 이다.
    """
    return datetime.now(KST).strftime("%Y%m%d")


def _day_path(data_dir: Path, yyyymmdd: str) -> Path:
    return data_dir / _DIRNAME / f"{yyyymmdd}.json"


def _to_json(book: StoredAfterHoursBook) -> dict:
    return {
        "ask": [list(lv) for lv in book.ask],
        "bid": [list(lv) for lv in book.bid],
        "total_ask_qty": book.total_ask_qty,
        "total_bid_qty": book.total_bid_qty,
        "cur_price": book.cur_price,
        "close_price": book.close_price,
        "acc_volume": book.acc_volume,
        "base_tm": book.base_tm,
        "fetched_at_ms": book.fetched_at_ms,
    }


def _from_json(code: str, row: dict) -> StoredAfterHoursBook | None:
    """한 종목 행을 복원. 모양이 깨졌으면 **그 종목만** None — 파일 전체를 버리지 않는다."""
    def levels(key: str) -> tuple[tuple[int, int], ...]:
        return tuple((int(lv[0]), int(lv[1])) for lv in row[key])

    try:
        return StoredAfterHoursBook(
            code=code,
            ask=levels("ask"),
            bid=levels("bid"),
            total_ask_qty=int(row["total_ask_qty"]),
            total_bid_qty=int(row["total_bid_qty"]),
            cur_price=row.get("cur_price"),
            close_price=row.get("close_price"),
            acc_volume=int(row.get("acc_volume", 0)),
            base_tm=row.get("base_tm"),
            fetched_at_ms=int(row["fetched_at_ms"]),
        )
    except (KeyError, TypeError, ValueError, IndexError):
        log.warning("live.after_hours.stored_row_malformed code=%s", code)
        return None


def _read_day(data_dir: Path, yyyymmdd: str) -> dict:
    p = _day_path(data_dir, yyyymmdd)
    if not p.exists():
        return {}
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        # 손상 파일은 **빈 것으로 취급한다**. 이 데이터는 편의 조회용이고, 폴러가
        # 다음 주기에 다시 쓴다 — 격리·백업을 둘 값이 아니다.
        log.warning("live.after_hours.day_file_unreadable date=%s", yyyymmdd)
        return {}
    if not isinstance(doc, dict) or doc.get("schema") != _SCHEMA:
        return {}
    codes = doc.get("codes")
    return codes if isinstance(codes, dict) else {}


def save_cycle(
    data_dir: Path, yyyymmdd: str, books: dict[str, StoredAfterHoursBook]
) -> None:
    """한 폴링 주기의 결과를 병합 저장한다. 빈 dict 면 아무것도 하지 않는다.

    **병합이다** — 이번 주기에 실패한 종목의 직전 값을 지우지 않는다. 벤더 한 건이
    실패했다고 그 종목의 저장본이 사라지면, 마감 캡처 한 번의 실패가 그날 데이터를
    통째로 날린다.
    """
    if not books:
        return
    p = _day_path(data_dir, yyyymmdd)
    p.parent.mkdir(parents=True, exist_ok=True)
    codes = _read_day(data_dir, yyyymmdd)
    for code, book in books.items():
        codes[code] = _to_json(book)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps({"schema": _SCHEMA, "date": yyyymmdd, "codes": codes}, ensure_ascii=False),
        encoding="utf-8",
    )
    os.replace(tmp, p)


def load_book(data_dir: Path, yyyymmdd: str, code: str) -> StoredAfterHoursBook | None:
    """그날 그 종목의 마지막 저장본. 없으면 None(= "저장된 적 없다")."""
    row = _read_day(data_dir, yyyymmdd).get(code)
    if not isinstance(row, dict):
        return None
    return _from_json(code, row)


def stored_codes(data_dir: Path, yyyymmdd: str) -> tuple[str, ...]:
    """그날 저장본이 있는 종목 코드 — 관측·테스트용."""
    return tuple(sorted(_read_day(data_dir, yyyymmdd)))
