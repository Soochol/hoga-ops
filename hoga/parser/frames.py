"""first.tsv 이벤트 수집의 컬럼형(polars) 고속 경로.

배경: `_collect_events`(행별 python `parse_row`)는 최중량일 기준 98.6만 행에
~4.5s + dataclass 물질화를 지불하고, 전 구간 GIL-bound라 백필 워커 24개의
파싱 버스트가 서빙과 직렬화된다(2026-07-11 프로파일). 이 모듈은 라인의
97%+(type-1 체결, type-2 호가)를 polars 벡터 연산(Rust, GIL 해제)으로
파싱하고, 나머지 전부 — type-3(단일가 요약)·type-4(거래원)·type-5(하트비트)·
필드수 불일치·캐스트 실패 — 는 기존 python `parse_row`로 **라인 단위 폴백**
한다.

폴백이 정확성의 핵심이다: strict/lenient 오류 의미론(`ParserError`의
``page:lineno 메시지``, lenient의 skipped 목록)은 python 경로가 그대로
생산하므로 바이트 동일하다. polars가 캐스트하지 못하는 라인은 "오류"가
아니라 "의심"으로만 표시되어 python 파서가 재판정한다 — python이 성공하면
그 결과를 병합하고, 실패하면 python의 예외가 그대로 전파된다. 따라서 신경로가
구경로보다 더 관대하지도 엄격하지도 않다.

시퀀스 dedup(전 타입 공용 seen_seqs, 라인 순서 첫 등장 승리)과 라인 순서
보존(gidx)은 프레임 연산으로 재현한다. 동등성은
tests/test_parser_frames_oracle.py 가 python 경로(_collect_events — 폴백용으로
프로덕션에 상존)와의 차등 비교로 보증한다.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import polars as pl

from hoga.collector.orchestrator import raw_pages
from hoga.tables.brokers import BrokerRow
from hoga.tables.dispatch import FieldCountError, parse_row
from hoga.tables.snapshots import ORDERBOOK_LEVELS, Orderbook
from hoga.tables.trades import Trade

# type-1(체결) 필드 → Trade 속성 (qty/side는 부호 처리라 별도).
_TRADE_INT_FIELDS = {
    "ts_ms": 4, "seq": 3, "price": 6, "cum_vol": 9, "cum_trades": 10,
    "low_so_far": 11, "high_so_far": 12, "unknown_14": 13, "net_pressure": 14,
}
_TRADE_FLOAT_FIELDS = {"change_pct": 7, "unknown_16": 15, "unknown_17": 16, "unknown_18": 17}

_TRADE_COLUMNS = [
    "ts_ms", "seq", "price", "change_pct", "qty", "side", "cum_vol",
    "cum_trades", "low_so_far", "high_so_far", "net_pressure",
    "unknown_14", "unknown_16", "unknown_17", "unknown_18",
]

_SNAPSHOT_LEVEL_PREFIXES = ("ask_p", "ask_q", "ask_d", "bid_p", "bid_q", "bid_d")
_SNAPSHOT_TOTALS = ("tot_ask", "tot_ask_d", "tot_bid", "tot_bid_d")
_SNAPSHOT_COLUMNS = (
    ["ts_ms", "seq"]
    + [f"{p}{i}" for p in _SNAPSHOT_LEVEL_PREFIXES for i in range(1, ORDERBOOK_LEVELS + 1)]
    + list(_SNAPSHOT_TOTALS)
)


@dataclass(frozen=True)
class CollectedFrames:
    """`_collect_events`의 컬럼형 등가물.

    trades/snapshots는 gidx(전역 라인 순서) 오름차순 — python 경로의 리스트
    append 순서와 동일. brokers는 소량이라 entity 리스트 그대로.
    """
    trades: pl.DataFrame          # _TRADE_COLUMNS
    snapshots: pl.DataFrame       # _SNAPSHOT_COLUMNS
    brokers: list[BrokerRow]
    unique_event_count: int       # == len(seen_seqs)
    skipped: list[tuple[str, int, str]]


def _read_lines(raw_dir: Path) -> pl.DataFrame:
    """페이지들을 raw_pages 순서로 읽어 (page, lineno, gidx, line) 프레임 구성."""
    pages: list[str] = []
    linenos: list[int] = []
    lines: list[str] = []
    for page_path in raw_pages(raw_dir):
        name = page_path.name
        for lineno, line in enumerate(
            page_path.read_text(encoding="utf-8").splitlines(keepends=False), start=1,
        ):
            if not line:
                continue
            pages.append(name)
            linenos.append(lineno)
            lines.append(line)
    return pl.DataFrame(
        {"page": pages, "lineno": linenos, "line": lines},
        schema_overrides={"lineno": pl.Int64},
    ).with_row_index("gidx")


def _field(i: int) -> pl.Expr:
    return pl.col("fields").list.get(i, null_on_oob=True)


def collect_event_frames(raw_dir: Path, *, lenient: bool) -> CollectedFrames:
    df = _read_lines(raw_dir)
    if df.height == 0:
        return CollectedFrames(
            trades=pl.DataFrame(schema={c: pl.Int64 for c in _TRADE_COLUMNS}),
            snapshots=pl.DataFrame(schema={c: pl.Int64 for c in _SNAPSHOT_COLUMNS}),
            brokers=[], unique_event_count=0, skipped=[],
        )

    # 토크나이즈: split_row와 동일 — CR 제거 후 탭 분리, 말미 빈 필드 1개 제거.
    df = df.with_columns(
        pl.col("line").str.strip_chars_end("\r").str.split("\t").alias("fields"),
    ).with_columns(nf=pl.col("fields").list.len())
    df = df.with_columns(
        fields=pl.when(
            (pl.col("nf") > 0) & (pl.col("fields").list.last() == ""),
        ).then(pl.col("fields").list.slice(0, pl.col("nf") - 1)).otherwise(pl.col("fields")),
    ).with_columns(nf=pl.col("fields").list.len())
    df = df.with_columns(et=_field(1).cast(pl.Int64, strict=False))

    # 마스크는 반드시 null-불가로: et가 비숫자(null)면 (et==5)&(nf>=2)가
    # Kleene null이 되어 ~null=null → filter가 해당 라인을 "폴백도 skipped도
    # 아닌" 조용한 드롭으로 흘린다(퍼즈가 잡은 결함). fill_null(False) 필수.
    # ── type-1 체결: 벡터 추출 ────────────────────────────────────────────
    is_t1 = ((pl.col("et") == 1) & (pl.col("nf") == 18)).fill_null(False)
    # 0행이어도 동일 표현식을 적용한다 — 빈 프레임이 출력 스키마를 유지해야
    # 이후 select/concat이 성립한다(비용은 0행이라 무시 가능).
    t1 = df.filter(is_t1)
    qty_raw = _field(8)
    t1 = t1.with_columns(
        [_field(i).cast(pl.Int64, strict=False).alias(name) for name, i in _TRADE_INT_FIELDS.items()]
        + [_field(i).cast(pl.Float64, strict=False).alias(name) for name, i in _TRADE_FLOAT_FIELDS.items()]
        + [
            # 부호 접두 파싱: '+N'→(1,N), '-N'→(-1,N), 그 외 int(raw)→(0,N).
            pl.when(qty_raw.str.starts_with("+")).then(1)
            .when(qty_raw.str.starts_with("-")).then(-1)
            .otherwise(0).cast(pl.Int64).alias("side"),
            pl.when(qty_raw.str.starts_with("+") | qty_raw.str.starts_with("-"))
            .then(qty_raw.str.slice(1).cast(pl.Int64, strict=False))
            .otherwise(qty_raw.cast(pl.Int64, strict=False)).alias("qty"),
        ],
    )
    t1_bad = pl.any_horizontal(
        [pl.col(c).is_null() for c in (*_TRADE_INT_FIELDS, *_TRADE_FLOAT_FIELDS, "qty")],
    )
    t1_clean = t1.filter(~t1_bad)
    t1_suspicious_gidx = set(t1.filter(t1_bad)["gidx"].to_list())

    # ── type-2 호가: 벡터 추출 (70필드 → 64컬럼 플랫) ─────────────────────
    is_t2 = ((pl.col("et") == 2) & (pl.col("nf") == 70)).fill_null(False)
    t2 = df.filter(is_t2)
    base = 6
    exprs = [
        _field(4).cast(pl.Int64, strict=False).alias("ts_ms"),
        _field(3).cast(pl.Int64, strict=False).alias("seq"),
    ]
    for block, prefix in enumerate(_SNAPSHOT_LEVEL_PREFIXES):
        for i in range(ORDERBOOK_LEVELS):
            exprs.append(
                _field(base + block * ORDERBOOK_LEVELS + i)
                .cast(pl.Int64, strict=False).alias(f"{prefix}{i + 1}"),
            )
    totals_start = base + 6 * ORDERBOOK_LEVELS
    for off, name in enumerate(_SNAPSHOT_TOTALS):
        exprs.append(_field(totals_start + off).cast(pl.Int64, strict=False).alias(name))
    t2 = t2.with_columns(exprs)
    t2_bad = pl.any_horizontal([pl.col(c).is_null() for c in _SNAPSHOT_COLUMNS])
    t2_clean = t2.filter(~t2_bad)
    t2_suspicious_gidx = set(t2.filter(t2_bad)["gidx"].to_list())

    # ── type-5 하트비트: 필드수 무관 스킵 (parse_row와 동일 — SKIP 판정은
    #    개수 검사보다 먼저다) ─────────────────────────────────────────────
    is_t5 = ((pl.col("et") == 5) & (pl.col("nf") >= 2)).fill_null(False)

    # ── 폴백: 나머지 전부 python parse_row (type-3/4, 의심 라인, 미지 타입) ──
    fallback = df.filter(~is_t1 & ~is_t2 & ~is_t5)
    fallback_rows = list(zip(
        fallback["gidx"].to_list(), fallback["page"].to_list(),
        fallback["lineno"].to_list(), fallback["line"].to_list(), strict=True,
    ))
    if t1_suspicious_gidx or t2_suspicious_gidx:
        suspicious = t1_suspicious_gidx | t2_suspicious_gidx
        extra = df.filter(pl.col("gidx").is_in(pl.Series(sorted(suspicious)).implode()))
        fallback_rows += list(zip(
            extra["gidx"].to_list(), extra["page"].to_list(),
            extra["lineno"].to_list(), extra["line"].to_list(), strict=True,
        ))
        fallback_rows.sort(key=lambda r: r[0])

    skipped: list[tuple[str, int, str]] = []
    py_trades: list[tuple[int, Trade]] = []
    py_snapshots: list[tuple[int, Orderbook]] = []
    py_brokers: list[tuple[int, list[BrokerRow]]] = []
    from hoga.parser import ParserError  # 지연 import — 순환 회피

    for gidx, page, lineno, line in fallback_rows:
        try:
            parsed = parse_row(line)
        except (FieldCountError, ValueError) as e:
            msg = f"{page}:{lineno} {e}"
            if lenient:
                skipped.append((page, lineno, str(e)))
                continue
            raise ParserError(msg) from e
        if parsed is None:
            continue
        if isinstance(parsed, list):
            py_brokers.append((gidx, parsed))
        elif isinstance(parsed, Trade):
            py_trades.append((gidx, parsed))
        else:
            py_snapshots.append((gidx, parsed))

    # python 폴백 결과를 프레임으로 승격(소량) 후 병합.
    trades_df = t1_clean.select("gidx", *_TRADE_COLUMNS)
    if py_trades:
        trades_df = pl.concat([
            trades_df,
            pl.DataFrame(
                {"gidx": [g for g, _ in py_trades]}
                | {c: [getattr(t, c) for _, t in py_trades] for c in _TRADE_COLUMNS},
                schema_overrides={"gidx": trades_df.schema["gidx"], "change_pct": pl.Float64,
                                  "unknown_16": pl.Float64, "unknown_17": pl.Float64,
                                  "unknown_18": pl.Float64},
            ).with_columns([
                pl.col(c).cast(pl.Int64)
                for c in _TRADE_COLUMNS
                if c not in ("change_pct", "unknown_16", "unknown_17", "unknown_18")
            ]),
        ]).sort("gidx")

    snapshots_df = t2_clean.select("gidx", *_SNAPSHOT_COLUMNS)
    if py_snapshots:
        def _snap_value(o: Orderbook, col: str) -> int:
            if col in ("ts_ms", "seq") or col in _SNAPSHOT_TOTALS:
                return getattr(o, col)
            prefix, idx = col[:-1], int(col[-1:])
            if col[-2:].isdigit():  # ask_p10 형태
                prefix, idx = col[:-2], int(col[-2:])
            return getattr(o, prefix)[idx - 1]
        snapshots_df = pl.concat([
            snapshots_df,
            pl.DataFrame(
                {"gidx": [g for g, _ in py_snapshots]}
                | {c: [_snap_value(o, c) for _, o in py_snapshots] for c in _SNAPSHOT_COLUMNS},
            ).with_columns([pl.col(c).cast(pl.Int64) for c in _SNAPSHOT_COLUMNS])
            .with_columns(pl.col("gidx").cast(snapshots_df.schema["gidx"])),
        ]).sort("gidx")

    # ── 전 타입 공용 seq dedup — 라인 순서 첫 등장 승리 (seen_seqs 재현) ──
    seq_tables = [
        trades_df.select("gidx", "seq"),
        snapshots_df.select("gidx", "seq"),
    ]
    if py_brokers:
        seq_tables.append(pl.DataFrame({
            "gidx": [g for g, _ in py_brokers],
            "seq": [rows[0].seq if rows else None for _, rows in py_brokers],
        }).drop_nulls().with_columns(
            pl.col("gidx").cast(trades_df.schema["gidx"]), pl.col("seq").cast(pl.Int64),
        ))
    all_seqs = pl.concat(seq_tables).sort("gidx")
    winners = all_seqs.unique(subset=["seq"], keep="first", maintain_order=True)
    winner_gidx = winners["gidx"]

    # is_in(Series)는 polars 1.x에서 모호성 deprecation — implode로 명시.
    winner_expr = pl.col("gidx").is_in(winner_gidx.implode())
    trades_df = trades_df.filter(winner_expr).drop("gidx")
    snapshots_df = snapshots_df.filter(winner_expr).drop("gidx")
    broker_winner = set(winner_gidx.to_list())
    brokers_out: list[BrokerRow] = []
    for gidx, rows in py_brokers:
        # _add_broker_rows 재현: 빈 fan-out은 sample_seq가 없어 dedup을 건너뛰고
        # 그대로 추가된다(추가할 행도 없지만 의미론 유지).
        if rows and gidx not in broker_winner:
            continue
        brokers_out.extend(rows)

    return CollectedFrames(
        trades=trades_df,
        snapshots=snapshots_df,
        brokers=brokers_out,
        unique_event_count=winners.height,
        skipped=skipped,
    )
