"""캔들 도메인 모델 — 브로커 중립 포트 계약 타입.

`LiveCandle`은 종목 1개의 봉 하나이고 `IndexCandlePoint`는 지수의 봉 하나다.
생산자는 시대마다 갈렸다 — KIS REST 캔들 파서, 키움 `ka10080` 딥백필
(ADR-0116 도입 → ADR-0120 제거), 키움 `ka20005` 지수 분봉(ADR-0129) — 그런데
소비자(캔들 캐시·백필 사다리·리페어)는 **줄곧 소스 무관**이었다. 파서 모듈과
수명을 분리해 두면 생산자가 갈려도 이 모델은 잔존한다 — `ticks.py`의 `WsTick`이
같은 이유로 파서 밖에 산다(ADR-0118 브로커 완전 특화).

`LiveCandle`은 2026-08-03까지 `kis_models.KisCandle`이었다. 그 docstring이 이미
"브로커 중립 캔들 포트 — 이름의 「Kis」는 역사적이다"라고 적었지만 리네임은
사용처 파급으로 보류돼 있었다. #1018(지도 #1005)에서 이사·리네임을 마쳤다.

**이름이 `Candle`이 아닌 이유**: `hoga.tables.candles.Candle` 이 이미 있고 그쪽은
parquet/TSV 행 모델이다(`ts_ms`·`open_`·`close_`·`vol_a`·`vol_b`) — 개념은 같지만
필드가 다르다. `hoga/live` 는 상대 import 를 많이 쓰므로 두 `Candle` 이 공존하면
`from .candles import Candle` 이 어느 쪽인지 매번 확인해야 한다. 벤더 접두어
`Kis` 가 그동안 사실상 네임스페이스 노릇을 하고 있었고, 그 자리를 `Live` 가
받는다 — `ticks.WsTick`·`LiveVenuePolicy` 와 같은 문법이다.

I/O 없음 — fixture로 완전 테스트 가능. ADR-0038에 따라 parquet 라이브러리를
import 하지 않는다(핫패스 모듈).
"""
from __future__ import annotations

from pydantic import BaseModel


class LiveCandle(BaseModel):
    """종목 봉 하나. `t_ms`는 봉 **시작** 시각(epoch ms, UTC)."""

    t_ms: int
    open: int
    high: int
    low: int
    close: int
    volume: int


class IndexCandlePoint(BaseModel):
    """지수 봉 하나. 지수는 소수점을 가지므로 OHLC가 float다."""

    t_ms: int   # epoch ms (UTC) — start of bar
    open: float
    high: float
    low: float
    close: float
    volume: int


def daily_anchor_ms(date_yyyymmdd: str) -> int:
    """일봉 1건의 시각 앵커 = **그날 09:00 KST**.

    소스 무관 규약이다. 과거 KIS 경로도 같은 값을
    내야 프론트가 같은 날의 캔들·투자자 막대·지수 봉을 한 x 위치에 정렬한다 —
    앵커가 어긋나면 차트에서 하루씩 밀린 것처럼 보인다.

    키움 어댑터 3벌(`kiwoom_index_rest`·`kiwoom_investor`·`kiwoom_daily_candles`)이
    각자 복사본을 갖고 있었다. 규약은 하나인데 정의가 여럿이면 한 곳만 고쳐도
    조용히 어긋나므로 여기로 모은다.
    """
    from datetime import datetime  # noqa: PLC0415 — ADR-0038 핫패스 모듈: 모듈 레벨 import 최소화

    from hoga.util.timeenc import KST  # noqa: PLC0415

    dt = datetime.strptime(date_yyyymmdd, "%Y%m%d").replace(hour=9, tzinfo=KST)
    return int(dt.timestamp() * 1000)
