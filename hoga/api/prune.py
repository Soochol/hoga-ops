"""Raw data retention — parse 완료(COMPLETE) hogaplay raw를 유예 후 삭제한다.

게이트: raw는 hogaplay 전용(flat first_*.tsv)이므로 aggregate가 아니라
hogaplay-source가 DiskState.COMPLETE일 때만 삭제 (ADR-0075, ADR-0039).
순수 로직 — CLI(`hoga prune`)와 Daily Scheduler가 공유한다.
"""
from __future__ import annotations

import datetime as dt
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from hoga.api.disk_state import (
    Classification,
    DiskState,
    check_disk_state,
    classify_stock_date,
)
from hoga.api.eligibility import is_expired_unconfirmed_gap
from hoga.collector.orchestrator import now_kst

RETENTION_DAYS_DEFAULT = 3

# 디스크 여유 경고 임계(%). 이 아래로 내려가면 로그에 경고를 남긴다.
#
# 왜 필요한가: 2026-06-13 에 raw 704GB 가 디스크를 100% 로 채워 쓰기가 실패했다
# (ADR-0075 를 만든 사고). 그 뒤로도 코드베이스에 여유 공간을 보는 곳이 단
# 한 군데도 없었다 — statvfs / disk_usage / ENOSPC 검색 결과 0건(2026-07-29).
# 즉 같은 사고가 재현되어도 가득 찬 뒤 쓰기 실패로만 알 수 있었다.
#
# 하드 게이트(임계 미만이면 캡처 거부)를 두지 않은 이유: ADR-0036 의 "백엔드는
# 사용자 명시 액션 없이 자동 동작하지 않는다" 원칙과, ADR-0075 가 그 예외를
# **디스크 회수(삭제)** 에 한정한 것을 존중한다. 여기서 늘리는 것은 가시성이지
# 새로운 자동 차단이 아니다.
DISK_WARN_FREE_PCT = 10.0


def resolve_retention_days() -> int:
    """HOGA_RETENTION_DAYS env(없으면 기본 3)를 정수로 해석한다."""
    return int(os.environ.get("HOGA_RETENTION_DAYS", RETENTION_DAYS_DEFAULT))


def resolve_include_confirmed_gaps() -> bool:
    """HOGA_PRUNE_CONFIRMED_GAPS truthy 판정 — 일일 prune 의 게이트 확장 옵트인 (#998).

    기본 게이트(COMPLETE 만 삭제)는 실측에서 유예 밖 raw 351GB 를 전량 보존했다
    — "수동 CLI(--include-confirmed-gaps)를 기억해야 회수된다" 가 무인 prod 의
    실질 디스크 구멍(raw ~4GB/day)이라, env 한 줄로 확인된 업스트림 갭까지
    일일 자동 회수에 포함시킨다. 기본은 off(현행 보수 게이트 유지).
    """
    return os.environ.get("HOGA_PRUNE_CONFIRMED_GAPS", "").strip() in (
        "1", "true", "yes", "on",
    )


def resolve_include_expired_unconfirmed() -> bool:
    """HOGA_PRUNE_EXPIRED_UNCONFIRMED truthy 판정 — 2단계 옵트인 (ADR-0135).

    확인된 갭(위 옵트인)만으로는 지배 클래스가 남는다: 2026-07-29 실측에서 유예
    밖 raw 351GB 중 confirmed 는 520건 77GB 인데 **unconfirmed 가 743건 110GB**
    였고, 그 미확정분의 99.85% 는 업스트림 보유 창(~18h)을 지나 확정 경로가
    영구히 닫힌 것들이다. 기본은 off — 근거와 되돌릴 수 없는 성질은 ADR-0135.
    """
    return os.environ.get("HOGA_PRUNE_EXPIRED_UNCONFIRMED", "").strip() in (
        "1", "true", "yes", "on",
    )


@dataclass(frozen=True)
class PruneCandidate:
    date: str          # YYYYMMDD
    code: str
    raw_dir: Path
    size_bytes: int    # 회수 예상량(dry-run 표시 + execute 합산)


@dataclass(frozen=True)
class PruneResult:
    candidates: list[PruneCandidate] = field(default_factory=list)
    deleted: int = 0
    reclaimed_bytes: int = 0
    scanned: int = 0  # 함수 종료 시점 raw/에 남은 (date,code) 수 (execute 후=생존자)
    # 컷오프를 통과했는데 상태 게이트에서 걸린 항목의 사유별 집계.
    #
    # 왜 필요한가: 이게 없으면 "후보 0건" 이 두 가지 정반대 상황에 대해 똑같이
    # 출력된다 — (a) 지울 게 정말 없다, (b) 전부 게이트에 걸려 영구 보존 중이다.
    # 실제로 2026-07-29 진단에서 raw 는 (b) 였는데, 스케줄러는 매일
    # "removed 0 dirs, reclaimed 0.00 GiB" 를 성공처럼 로그하고 있었다. 디스크가
    # 차오르는 동안 아무도 이유를 알 수 없는 상태였다.
    skipped_by_state: dict[str, int] = field(default_factory=dict)
    skipped_bytes_by_state: dict[str, int] = field(default_factory=dict)


def _hogaplay_classification(data_dir: Path, code: str, date: str) -> Classification:
    """이 (date,code)의 hogaplay-source Classification.

    raw/는 hogaplay 전용이므로 aggregate가 아니라 hogaplay-source의 상태로
    판정한다. per-source 레이아웃이면 hogaplay Classification 을, legacy flat
    레이아웃(source subdir 없음)이면 단일 hogaplay이므로 check_disk_state 를
    쓴다. per-source 인데 hogaplay 키 자체가 없으면(예: kis_api 만 있는 경우)
    NONE — raw 의 짝이 되는 parquet 이 없다는 뜻이라 판정 불가로 보존한다.
    (ADR-0075, ADR-0039)
    """
    per_source = classify_stock_date(data_dir / "parquet" / date / code)
    if per_source:
        return per_source.get("hogaplay") or Classification(state=DiskState.NONE)
    return check_disk_state(data_dir, code, date)


def _is_prunable(
    cls: Classification,
    *,
    include_confirmed_gaps: bool,
    reclaim_expired_unconfirmed: bool = False,
) -> bool:
    """이 상태의 raw 를 삭제해도 되는가?

    기본은 ADR-0075 그대로 COMPLETE 뿐이다. ``include_confirmed_gaps`` 는
    ADR-0075 의 Trigger Condition("비-COMPLETE raw 누적이 디스크를 위협하면
    --include-partial 옵트인 또는 별도 진단 도구를 도입한다")에 대한 응답이다.

    **모든 partial 이 아니라 확인된 갭만** 포함한다. 그 경계가 load-bearing 이다:

    - ``CLIENT_INCOMPLETE`` — 우리 수집이 중간에 멈춘 상태. raw 가 resume 커서의
      소스다. 지우면 재개가 불가능해지고 처음부터 다시 받아야 한다. 절대 포함 불가.
    - ``SOURCE_PARTIAL`` + ``upstream_gap_confirmed=False`` — 수집은 끝났지만
      갭이 업스트림 탓인지 아직 미확정이다. **보유 창 안이면** decide_capture 가
      재캡처를 다시 시도할 수 있는 대상이라 제외한다.
      보유 창 **밖**(is_expired_unconfirmed_gap)이면 확정 경로가 영원히 닫혀
      있으므로 사실상 terminal 이고, decide_capture 도 2026-07-30 부터
      건너뛴다. 그 2단계(삭제 허용)가 **ADR-0135 로 승인돼** 별도 옵트인
      (`reclaim_expired_unconfirmed`, 기본 off)으로 열렸다 — 1단계(재캡처
      중단)와 여전히 다른 결정이라 스위치도 따로다. 켜지 않으면 종전대로
      보존되고, 진단 라벨은 `_skip_reason` 이 `(expired)` 로 갈라 보여 준다.
    - ``SOURCE_PARTIAL`` + ``upstream_gap_confirmed=True`` — 재캡처가 동일한 갭을
      재현했거나(ADR-0093) 갭이 세션 경계에 접한다(ADR-0126). **decide_capture 가
      이미 건너뛰는 상태**, 즉 시스템 스스로 terminal 로 선언한 것이다. 이 raw 를
      다시 파싱해도 지금 있는 parquet 과 똑같은 결과가 나온다.

    실측(2026-07-29): 유예 밖 raw 351GB 중 confirmed 갭이 520건 77.2GB,
    unconfirmed 가 743건 110.1GB. 처음에는 안전한 쪽만으로 충분하다고 봤는데,
    2026-08-03 재측정에서 raw 성장이 **거래일당 ~33GB**(문서 전제의 8배)로
    드러나 지배 클래스를 남겨 둘 여유가 없어졌다 — 그 재평가가 ADR-0135 다.
    """
    if cls.state == DiskState.COMPLETE:
        return True
    if cls.state != DiskState.SOURCE_PARTIAL:
        return False
    if cls.upstream_gap_confirmed:
        return include_confirmed_gaps
    return reclaim_expired_unconfirmed


def _is_complete_hogaplay(data_dir: Path, code: str, date: str) -> bool:
    """기본 게이트(ADR-0075): 이 (date,code) 의 hogaplay-source 가 COMPLETE 인가.

    _hogaplay_classification + _is_prunable 로 분리된 뒤에도 남겨 둔 얇은 래퍼다.
    "hogaplay 가 COMPLETE 일 때만" 이라는 규칙 자체가 ADR-0075 의 핵심 계약이고
    (특히 aggregate 가 COMPLETE 여도 hogaplay 가 partial 이면 보존해야 한다는
    부분), 그 계약을 직접 겨냥한 테스트들이 이 이름에 걸려 있다.
    """
    return _is_prunable(
        _hogaplay_classification(data_dir, code, date), include_confirmed_gaps=False,
    )


def _skip_reason(cls: Classification, date: str, now: dt.datetime) -> str:
    """진단용 사유 라벨. state 만으로는 SOURCE_PARTIAL 종류가 구분되지 않는다.

    미확정 갭을 다시 둘로 가른다 — 이 구분이 없으면 "언젠가 확정될 것" 과
    "영원히 확정될 수 없는 것" 이 한 줄로 합산돼, 보고를 읽는 사람이 기다리면
    줄어들 양으로 오해한다. 실제로는 2026-07-30 기준 미확정 1,344건 중 확정
    가능한 것은 2건뿐이었다.

    ``(expired)`` 는 **재캡처가 원리적으로 무의미하다**는 뜻이지 삭제해도 된다는
    뜻이 아니다. prune 게이트는 이 라벨을 보지 않는다(_is_prunable 참조).
    """
    if cls.state == DiskState.SOURCE_PARTIAL:
        if cls.upstream_gap_confirmed:
            return "source_partial(gap_confirmed)"
        if is_expired_unconfirmed_gap(cls, date, now):
            return "source_partial(gap_unconfirmed,expired)"
        return "source_partial(gap_unconfirmed)"
    return cls.state.value


def _dir_size(path: Path) -> int:
    """디렉터리 내 모든 파일 크기 합(바이트)."""
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def _scan(
    data_dir: Path, *, retention_days: int, now: dt.datetime,
    include_confirmed_gaps: bool = False,
    include_expired_unconfirmed: bool = False,
) -> tuple[list[PruneCandidate], dict[str, int], dict[str, int]]:
    """raw/ 를 한 번 순회해 (후보, 보존 사유별 건수, 보존 사유별 바이트) 를 낸다.

    보존 사유를 함께 내는 이유: 후보 0건이 "지울 게 없다" 와 "전부 게이트에 걸려
    영구 보존 중이다" 두 정반대 상황에 대해 같은 출력을 내던 것이 이 트리를
    351GB 까지 조용히 자라게 한 조건이었다.
    """
    raw_root = data_dir / "raw"
    if not raw_root.is_dir():
        return [], {}, {}
    cutoff = (now.date() - dt.timedelta(days=retention_days)).strftime("%Y%m%d")
    out: list[PruneCandidate] = []
    skipped: dict[str, int] = {}
    skipped_bytes: dict[str, int] = {}

    def _note(reason: str, size: int) -> None:
        skipped[reason] = skipped.get(reason, 0) + 1
        skipped_bytes[reason] = skipped_bytes.get(reason, 0) + size

    for date_dir in sorted(raw_root.iterdir()):
        if not date_dir.is_dir():
            continue
        date = date_dir.name
        if date >= cutoff:  # 유예 내 → 보존
            for code_dir in date_dir.iterdir():
                if code_dir.is_dir():
                    _note("within_grace", _dir_size(code_dir))
            continue
        for code_dir in sorted(date_dir.iterdir()):
            if not code_dir.is_dir():
                continue
            code = code_dir.name
            cls = _hogaplay_classification(data_dir, code, date)
            size = _dir_size(code_dir)
            prunable = _is_prunable(
                cls,
                include_confirmed_gaps=include_confirmed_gaps,
                reclaim_expired_unconfirmed=(
                    include_expired_unconfirmed
                    and is_expired_unconfirmed_gap(cls, date, now)
                ),
            )
            if not prunable:
                _note(_skip_reason(cls, date, now), size)
                continue
            out.append(PruneCandidate(
                date=date, code=code, raw_dir=code_dir, size_bytes=size,
            ))
    return out, skipped, skipped_bytes


def find_prunable(
    data_dir: Path, *, retention_days: int, now: dt.datetime,
    include_confirmed_gaps: bool = False,
    include_expired_unconfirmed: bool = False,
) -> list[PruneCandidate]:
    """raw/ 순회 → 날짜 컷오프 통과(date < today−N 달력일) + 상태 게이트를
    통과한 (date,code)만 PruneCandidate로 반환한다. 부작용 없음.

    기본 게이트는 hogaplay-source COMPLETE 다(ADR-0075). ``include_confirmed_gaps``
    를 켜면 확인된 업스트림 갭(SOURCE_PARTIAL + upstream_gap_confirmed)도,
    ``include_expired_unconfirmed`` 를 켜면 보유 창 밖 미확정 갭(ADR-0135)까지
    포함한다 — _is_prunable 의 docstring 이 그 경계의 근거를 설명한다.
    """
    candidates, _, _ = _scan(
        data_dir, retention_days=retention_days, now=now,
        include_confirmed_gaps=include_confirmed_gaps,
        include_expired_unconfirmed=include_expired_unconfirmed,
    )
    return candidates


def _count_stock_dates(raw_root: Path) -> int:
    """raw/에 현재 존재하는 (date,code) 총수."""
    if not raw_root.is_dir():
        return 0
    n = 0
    for date_dir in raw_root.iterdir():
        if not date_dir.is_dir():
            continue
        for code_dir in date_dir.iterdir():
            if code_dir.is_dir():
                n += 1
    return n


def _remove_empty_date_dirs(raw_root: Path) -> None:
    """비어 버린 raw/{date}/ 디렉터리를 제거한다(raw/ 루트는 유지)."""
    if not raw_root.is_dir():
        return
    for date_dir in raw_root.iterdir():
        if date_dir.is_dir() and not any(date_dir.iterdir()):
            date_dir.rmdir()


def prune_raw(
    data_dir: Path, *, retention_days: int, now: dt.datetime, execute: bool,
    include_confirmed_gaps: bool = False,
    include_expired_unconfirmed: bool = False,
) -> PruneResult:
    """find_prunable 후보를 (execute면) rmtree로 삭제하고 결과를 반환한다.

    dry-run(execute=False)이면 후보만 채운 PruneResult를 돌려준다(디스크 불변).
    삭제 후 비어 버린 날짜 디렉터리도 정리한다. 단일 rmtree 실패 시 예외가
    전파된다(loop 중단). 스케줄러는 이를 swallow하고 다음 일일 실행이 남은
    후보를 재시도한다. scanned는 함수 종료 시점 raw/에 남은 (date,code) 수다
    (dry-run이면 전체, execute 후면 생존자).
    """
    raw_root = data_dir / "raw"
    candidates, skipped, skipped_bytes = _scan(
        data_dir, retention_days=retention_days, now=now,
        include_confirmed_gaps=include_confirmed_gaps,
        include_expired_unconfirmed=include_expired_unconfirmed,
    )
    deleted = 0
    reclaimed = 0
    if execute:
        for c in candidates:
            shutil.rmtree(c.raw_dir)
            deleted += 1
            reclaimed += c.size_bytes
        _remove_empty_date_dirs(raw_root)
    return PruneResult(
        candidates=candidates,
        deleted=deleted,
        reclaimed_bytes=reclaimed,
        scanned=_count_stock_dates(raw_root),
        skipped_by_state=skipped,
        skipped_bytes_by_state=skipped_bytes,
    )


def prune_default_now() -> dt.datetime:
    """CLI/scheduler가 쓰는 기본 시각. 테스트는 hoga.api.prune.now_kst를 패치한다."""
    return now_kst()


@dataclass(frozen=True)
class DiskHeadroom:
    total_bytes: int
    free_bytes: int

    @property
    def free_pct(self) -> float:
        return 100.0 * self.free_bytes / self.total_bytes if self.total_bytes else 0.0

    @property
    def is_low(self) -> bool:
        return self.free_pct < DISK_WARN_FREE_PCT


def disk_headroom(path: Path) -> DiskHeadroom | None:
    """``path`` 가 속한 파일시스템의 총/여유 용량. 조회 실패 시 None.

    None 을 돌려주는 경우까지 호출부가 다루게 하는 이유: 이건 진단 보조라
    실패가 캡처나 prune 을 막아서는 안 된다. 데이터 디렉터리가 아직 없을 수도
    있으므로 가장 가까운 존재하는 상위로 거슬러 올라가 묻는다.
    """
    probe = path
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    try:
        usage = shutil.disk_usage(probe)
    except OSError:
        return None
    return DiskHeadroom(total_bytes=usage.total, free_bytes=usage.free)
