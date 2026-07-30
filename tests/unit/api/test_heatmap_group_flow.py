from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from zoneinfo import ZoneInfo

import polars as pl

from hoga.api.heatmap import save_document
from hoga.api.heatmap_group_flow import BUCKET_MS, build_group_flow
from hoga.api.models import HeatmapDocument, HeatmapEntry, WatchlistFolder

_KST = ZoneInfo("Asia/Seoul")
BASIS = dt.date(2026, 6, 19)
SEMI = "f_00000001"
BIO = "f_00000002"


def _ms(h: int, m: int) -> int:
    return int(dt.datetime(BASIS.year, BASIS.month, BASIS.day, h, m, tzinfo=_KST).timestamp() * 1000)


def _seed_heatmap(tmp_path: Path) -> None:
    save_document(
        tmp_path,
        HeatmapDocument(
            folders=[
                WatchlistFolder.model_construct(id=SEMI, name="반도체", order=0),
                WatchlistFolder.model_construct(id=BIO, name="바이오", order=1),
            ],
            entries=[
                HeatmapEntry.model_construct(code="005930", name="삼성전자", folder_id=SEMI, order=0),
                HeatmapEntry.model_construct(code="000660", name="SK하이닉스", folder_id=SEMI, order=1),
                HeatmapEntry.model_construct(code="068270", name="셀트리온", folder_id=BIO, order=0),
            ],
        ),
    )


def _seed_daily(tmp_path: Path) -> None:
    sdir = tmp_path / "screener"
    sdir.mkdir()
    pl.DataFrame(
        {
            "code": ["005930", "005930", "000660", "000660", "068270"],
            # 005930·000660 은 basis 전날(6/18) 종가가 prev_close; 068270 은 basis 이전 행 없음.
            "date": [dt.date(2026, 6, 17), dt.date(2026, 6, 18),
                     dt.date(2026, 6, 17), dt.date(2026, 6, 18),
                     dt.date(2026, 6, 19)],
            "close": [90.0, 100.0, 180.0, 200.0, 50.0],
        },
    ).write_parquet(sdir / "daily_adjusted.parquet")


def _write_candles(tmp_path: Path, code: str, records: list[tuple[int, float]]) -> None:
    root = tmp_path / "live_kiwoom" / BASIS.strftime("%Y%m%d")
    root.mkdir(parents=True, exist_ok=True)
    with (root / f"{code}.jsonl").open("w", encoding="utf-8") as fh:
        for t_ms, close in records:
            fh.write(json.dumps({
                "t_ms": t_ms, "kind": "candle",
                "payload": {"open": close, "high": close, "low": close, "close": close, "volume": 1},
            }) + "\n")


def test_group_flow_averages_member_change_pct(tmp_path: Path) -> None:
    _seed_heatmap(tmp_path)
    _seed_daily(tmp_path)
    # 반도체: 두 종목 모두 09:03 에 +5%(prev 100→105, 200→210). 그룹 평균 bucket0 = 5%.
    _write_candles(tmp_path, "005930", [(_ms(9, 3), 105.0)])
    _write_candles(tmp_path, "000660", [(_ms(9, 3), 210.0)])

    resp = build_group_flow(tmp_path, BASIS, now_ms=_ms(9, 10))

    assert resp.date == "2026-06-19"
    assert resp.bucket_ms == BUCKET_MS
    assert resp.t_base_ms == _ms(9, 0)
    semi = next(g for g in resp.groups if g.folder_id == SEMI)
    # bucket0(09:00–09:05) 에 +5%, 이후 현재 버킷까지 carry-forward 로 +5% 유지.
    # now=09:10 은 bucket2([09:10,09:15)) 시작 → 현재 버킷 포함이 맞다(라인이 현재까지).
    assert semi.pct[0] == 5.0
    assert semi.pct[1] == 5.0
    assert semi.pct[2] == 5.0
    # 미도래 버킷(09:15 이후)은 null.
    assert semi.pct[3] is None
    assert semi.pct[-1] is None


def test_group_flow_null_when_no_candles_or_no_baseline(tmp_path: Path) -> None:
    _seed_heatmap(tmp_path)
    _seed_daily(tmp_path)
    # 바이오(068270): basis 이전 daily 행 없음 → prev_close 결측 → 전 버킷 null.
    _write_candles(tmp_path, "068270", [(_ms(9, 3), 55.0)])

    resp = build_group_flow(tmp_path, BASIS, now_ms=_ms(9, 10))

    bio = next(g for g in resp.groups if g.folder_id == BIO)
    assert all(v is None for v in bio.pct)
    # 반도체는 캔들 파일이 없어(이 테스트는 미기록) 역시 전부 null.
    semi = next(g for g in resp.groups if g.folder_id == SEMI)
    assert all(v is None for v in semi.pct)


def test_group_flow_tolerates_torn_last_line(tmp_path: Path) -> None:
    _seed_heatmap(tmp_path)
    _seed_daily(tmp_path)
    root = tmp_path / "live_kiwoom" / BASIS.strftime("%Y%m%d")
    root.mkdir(parents=True, exist_ok=True)
    good = json.dumps({"t_ms": _ms(9, 3), "kind": "candle",
                       "payload": {"open": 105, "high": 105, "low": 105, "close": 105, "volume": 1}})
    # 마지막 줄이 찢긴 채(부분 write) — 파서는 그때까지를 반환해야 한다.
    (root / "005930.jsonl").write_text(good + '\n{"t_ms": 178485', encoding="utf-8")

    resp = build_group_flow(tmp_path, BASIS, now_ms=_ms(9, 10))
    semi = next(g for g in resp.groups if g.folder_id == SEMI)
    assert semi.pct[0] == 5.0


# ---------------------------------------------------------------------------
# candle 프리필터 (2026-07-29)
#
# _read_candle_closes 는 json.loads 앞에 저비용 문자열 검사를 둔다. 오늘자
# JSONL 은 kind 가 ob/fill/broker/trade/candle 로 섞여 있고 candle 은 실측 약
# 4% 라, 나머지를 파싱했다가 버리는 것이 비용의 대부분이었다(실측 243파일
# 947MB 스캔 11.37s → 1.90s, 6.0x).
#
# 이 선별자의 유일한 계약은 "과소수용하지 않는다" 다. 놓치면 그래프가 조용히
# 비므로 예외도 로그도 없이 데이터만 사라진다 — 아래가 그 계약을 고정한다.
# ---------------------------------------------------------------------------


def _write_lines(path: Path, lines: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(line + "\n" for line in lines), encoding="utf-8")


def test_prefilter_survives_separator_changes(tmp_path: Path) -> None:
    """직렬화 공백이 달라져도 candle 을 놓치지 않는다.

    프리필터를 `'"kind": "candle"'` 처럼 공백까지 맞춰 쓰면 빠르지만,
    LiveSnapshot.to_jsonl 이 json.dumps 기본 separators 에 의존하므로 그쪽이
    바뀌는 순간 0건을 반환한다 — 예외 없이 빈 그래프로만 나타나는 실패다.
    """
    from hoga.api.heatmap_group_flow import _read_candle_closes

    p = tmp_path / "005930.jsonl"
    _write_lines(p, [
        # 기본 separators (현재 writer 가 내는 형태)
        json.dumps({"t_ms": 1000, "kind": "candle", "payload": {"close": 100}}),
        # 압축 separators
        json.dumps({"t_ms": 2000, "kind": "candle", "payload": {"close": 200}},
                   separators=(",", ":")),
        # 키 순서가 바뀐 경우
        json.dumps({"kind": "candle", "payload": {"close": 300}, "t_ms": 3000}),
    ])

    assert _read_candle_closes(p) == [(1000, 100.0), (2000, 200.0), (3000, 300.0)]


def test_prefilter_skips_non_candle_kinds(tmp_path: Path) -> None:
    """걸러내는 쪽도 정확해야 한다 — 프리필터가 느슨한 만큼 최종 판정은
    obj.get("kind") 가 쥔다."""
    from hoga.api.heatmap_group_flow import _read_candle_closes

    p = tmp_path / "005930.jsonl"
    _write_lines(p, [
        json.dumps({"t_ms": 1000, "kind": "ob", "payload": {"asks": []}}),
        json.dumps({"t_ms": 1100, "kind": "trade", "payload": {"price": 1}}),
        json.dumps({"t_ms": 1200, "kind": "candle", "payload": {"close": 100}}),
        json.dumps({"t_ms": 1300, "kind": "fill", "payload": {"buy_qty": 1}}),
        json.dumps({"t_ms": 1400, "kind": "broker", "payload": {}}),
    ])

    assert _read_candle_closes(p) == [(1200, 100.0)]


def test_prefilter_overaccepts_without_corrupting(tmp_path: Path) -> None:
    """payload 안에 'candle' 문자열이 있는 비-candle 줄은 파싱까지 가지만
    kind 검사에서 정확히 탈락한다. 과다수용은 느려질 뿐 결과를 바꾸지 않는다."""
    from hoga.api.heatmap_group_flow import _read_candle_closes

    p = tmp_path / "005930.jsonl"
    _write_lines(p, [
        json.dumps({"t_ms": 1000, "kind": "trade", "payload": {"note": "candle"}}),
        json.dumps({"t_ms": 2000, "kind": "candle", "payload": {"close": 100}}),
    ])

    assert _read_candle_closes(p) == [(2000, 100.0)]


def test_prefilter_keeps_torn_last_line_tolerance(tmp_path: Path) -> None:
    """찢긴 마지막 줄 관용 파싱은 그대로여야 한다 — fsync 경계에서 흔하다."""
    from hoga.api.heatmap_group_flow import _read_candle_closes

    p = tmp_path / "005930.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    good = json.dumps({"t_ms": 1000, "kind": "candle", "payload": {"close": 100}})
    torn = '{"t_ms": 2000, "kind": "candle", "payl'
    p.write_text(good + "\n" + torn, encoding="utf-8")

    assert _read_candle_closes(p) == [(1000, 100.0)]


# ── tail-append 증분 읽기 ──────────────────────────────────────────────────────
#
# 이전에는 폴링마다 당일 JSONL 을 처음부터 전량 재파싱했다(실측 243파일 947MB,
# candle 선별 후 2.52초). 라우트의 버스트 합치기 창(30초)은 프론트 폴링 주기(60초)
# 보다 짧아 단일 클라이언트에서는 절대 히트하지 않으므로 완화 장치가 아니었다.


def _candle_line(t_ms: int, close: float) -> str:
    return json.dumps({"kind": "candle", "t_ms": t_ms, "payload": {"close": close}}) + "\n"


def _read_closes(path: Path) -> list[tuple[int, float]]:
    from hoga.api.heatmap_group_flow import _read_candle_closes

    return _read_candle_closes(path)


def _fresh(tmp_path: Path) -> Path:
    from hoga.api.heatmap_group_flow import reset_tail_cache_for_tests

    reset_tail_cache_for_tests()
    p = tmp_path / "live_kiwoom" / "20260619" / "005930.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def test_append_only_reads_the_new_tail(tmp_path: Path, monkeypatch) -> None:
    """두 번째 호출은 새로 붙은 바이트만 읽는다."""
    path = _fresh(tmp_path)
    path.write_text(_candle_line(_ms(9, 0), 100.0), encoding="utf-8")
    assert _read_closes(path) == [(_ms(9, 0), 100.0)]

    # 이후 read() 가 반환하는 바이트 수를 센다.
    read_bytes: list[int] = []
    real_open = Path.open

    def counting_open(self, *args, **kwargs):  # noqa: ANN001
        fh = real_open(self, *args, **kwargs)
        if "b" in (args[0] if args else kwargs.get("mode", "")):
            real_read = fh.read

            def read(*a, **k):
                data = real_read(*a, **k)
                read_bytes.append(len(data))
                return data

            fh.read = read  # type: ignore[method-assign]
        return fh

    monkeypatch.setattr(Path, "open", counting_open)

    tail = _candle_line(_ms(9, 5), 101.0)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(tail)

    assert _read_closes(path) == [(_ms(9, 0), 100.0), (_ms(9, 5), 101.0)]
    assert sum(read_bytes) == len(tail.encode("utf-8")), (
        f"꼬리만 읽어야 한다 — 실제 {sum(read_bytes)}B, 기대 {len(tail.encode())}B"
    )


def test_unchanged_file_is_not_reopened(tmp_path: Path, monkeypatch) -> None:
    """크기가 그대로면 파일을 아예 열지 않는다."""
    path = _fresh(tmp_path)
    path.write_text(_candle_line(_ms(9, 0), 100.0), encoding="utf-8")
    first = _read_closes(path)

    opened: list[str] = []
    real_open = Path.open

    def tracking_open(self, *args, **kwargs):  # noqa: ANN001
        opened.append(str(self))
        return real_open(self, *args, **kwargs)

    monkeypatch.setattr(Path, "open", tracking_open)

    assert _read_closes(path) == first
    assert opened == [], "변경 없는 파일을 다시 열었다"


def test_incomplete_trailing_line_is_not_consumed(tmp_path: Path) -> None:
    """개행 없이 끝난 꼬리는 소비하지 않고, 완성되면 반영된다.

    소비해 버리면 그 줄은 영구 유실이다(promote.py _JsonlParseState 와 같은 규율).
    """
    path = _fresh(tmp_path)
    path.write_text(_candle_line(_ms(9, 0), 100.0), encoding="utf-8")
    assert _read_closes(path) == [(_ms(9, 0), 100.0)]

    partial = _candle_line(_ms(9, 5), 101.0).rstrip("\n")
    with path.open("a", encoding="utf-8") as fh:
        fh.write(partial)          # 개행 없음 — 쓰기 도중 상태
    assert _read_closes(path) == [(_ms(9, 0), 100.0)], "부분 라인을 반영했다"

    with path.open("a", encoding="utf-8") as fh:
        fh.write("\n")             # 완성
    assert _read_closes(path) == [(_ms(9, 0), 100.0), (_ms(9, 5), 101.0)]


def test_shrunk_file_falls_back_to_a_full_reparse(tmp_path: Path) -> None:
    """파일이 교체(축소)되면 옛 오프셋을 버리고 전량 재파싱한다."""
    path = _fresh(tmp_path)
    path.write_text(
        _candle_line(_ms(9, 0), 100.0) + _candle_line(_ms(9, 5), 101.0), encoding="utf-8",
    )
    assert len(_read_closes(path)) == 2

    path.write_text(_candle_line(_ms(10, 0), 200.0), encoding="utf-8")  # 더 짧게 교체
    assert _read_closes(path) == [(_ms(10, 0), 200.0)]


def test_deleted_file_drops_the_cached_state(tmp_path: Path) -> None:
    """승격 후 삭제된 파일은 빈 리스트 + 상태 폐기(되살아나면 처음부터)."""
    path = _fresh(tmp_path)
    path.write_text(_candle_line(_ms(9, 0), 100.0), encoding="utf-8")
    assert len(_read_closes(path)) == 1

    path.unlink()
    assert _read_closes(path) == []

    path.write_text(_candle_line(_ms(11, 0), 300.0), encoding="utf-8")
    assert _read_closes(path) == [(_ms(11, 0), 300.0)]


def test_broken_line_does_not_discard_later_valid_lines(tmp_path: Path) -> None:
    """깨진 줄은 건너뛴다 — 구 구현의 `break` 는 뒤의 정상 줄까지 버렸다."""
    path = _fresh(tmp_path)
    path.write_text(
        _candle_line(_ms(9, 0), 100.0)
        + '{"kind": "candle", "t_ms": broken\n'
        + _candle_line(_ms(9, 5), 101.0),
        encoding="utf-8",
    )
    assert _read_closes(path) == [(_ms(9, 0), 100.0), (_ms(9, 5), 101.0)]
