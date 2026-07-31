"""백업 — 다시 구할 수 없는 것을 목적지로 복제한다.

**왜 이게 있어야 하나.** 이 앱의 유일한 DB 는 로컬 디스크다(``hoga/util/atomic_write``
docstring). 그런데 상류 재취득 창이 극히 짧다: hogaplay 는 ~18시간만 보유하고,
실시간 WS 틱은 애초에 재요청 대상이 아니다. 게다가 원본은 스스로 지워진다 — raw 는
3일(ADR-0075), ``_archive`` JSONL 은 7일(``promote.cleanup_archive``) 뒤 삭제된다.
즉 promoted parquet 이 유일 사본이 되는 시점이 정상 운영 중에 반드시 온다.
디스크 하나가 죽으면 그걸로 끝이라는 뜻이고, 저장소에는 그때까지 백업 경로가
없었다(``atomic_write`` 는 스크리너 아카이브를 "the no-backup SSOT" 라고 못박아 뒀다).

**두 가지 메커니즘을 쓴다. 실패 양상이 다르기 때문이다.**

- ``state/`` — **날짜별 tar 스냅샷**. 사용자 저작물(관심종목·저장뷰·프리셋·스크리너
  저장·알림 설정)은 극소이지만 상류가 없다. 여기서 현실적인 사고는 디스크 고장이
  아니라 **오삭제와 손상**이다: ``versioned_json_file`` 은 깨진 파일을 격리하고 **빈
  문서를 반환**한다. 미러였다면 그 빈 문서가 목적지의 정상본을 덮어쓴다. 그래서
  세대를 남겨 시간을 거슬러 복구할 수 있게 한다.
- ``market/`` — **덧쓰기 전용 미러**. 시장 데이터는 크고 (date, code) 파티션이
  사실상 불변이라(ADR-0092 "과거는 불변") 새 파일만 복사하면 하루치 비용으로 끝난다.
  **목적지에서 절대 지우지 않는다** — 원본의 prune·오삭제가 백업으로 전파되면
  백업이 아니다.

**의존성 없음.** 이 저장소가 도는 환경에 restic·rclone·rsync 가 없을 수 있어(실측
2026-07-31: tar 뿐) 표준 라이브러리만 쓴다.

**정합성.** parquet·상태 JSON·meta.json 은 전부 tempfile→fsync→``os.replace`` 라
사본이 찢어지지 않는다. 반면 JSONL 은 append 라 마지막 줄이 잘릴 수 있다(promote 의
파서는 마지막 개행까지만 소비해 이를 관용한다). 그래서 권장 실행 시각은 17:00 일일
런 이후다 — 그때는 JSONL 이 ``_archive`` 로 옮겨졌고 parquet 이 확정돼 있다.
``last_daily_run_date`` 마커로 그 사실을 확인해 결과에 싣는다.

**절대 담지 않는 것**: 자격증명(``.local/*token*.json``), DuckDB 스필(``duckdb-tmp/``,
최대 50GiB), flock 파일, 격리본. 백업본이 유출되면 실전투자 앱키가 함께 나간다.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import os
import shutil
import tarfile
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger(__name__)

# parquet 은 4바이트 매직으로 시작하고 끝난다 — 그 둘만 담아도 8바이트다.
_MIN_PARQUET_BYTES = 8

# 보관할 상태 스냅샷 세대 수. 사용자 상태는 하루 수백 KB 수준이라 넉넉히 남겨도
# 무비용이고, 오삭제를 뒤늦게 알아차리는 일이 흔하므로 2주치를 기본으로 둔다.
KEEP_DEFAULT = 14

# 상태 스냅샷에 담을 항목. data_dir 상대경로이며 파일·디렉토리 모두 허용한다.
# **없는 항목은 조용히 건너뛴다** — 기능을 안 쓰면 파일이 없는 게 정상이다.
_STATE_ITEMS: tuple[str, ...] = (
    "watchlist.json",
    "heatmap.json",
    "study_views",
    "screener/saves.json",
    "live_layout_presets",
    "study_layout_presets",
    "live_settings.json",
    "signal_alert_settings.json",
    "signal_alert_inbox_state.json",
    "signal_alerts",
    "live/investor-trend-estimate-observed-at.json",
    # 센티넬. 빠지면 부팅 때 레이아웃 마이그레이션이 다시 돈다.
    ".layout_v2",
    # 큐 매니페스트와 일일 런 마커. 작업 상태라 필수는 아니지만 극소이고, 복원 후
    # "어제까지 뭘 했는지" 를 잇는 데 쓰인다.
    ".queue.json",
    "scheduler_state.json",
)

# 미러 대상(덧쓰기 전용). data_dir 상대경로.
_MARKET_ROOTS: tuple[str, ...] = (
    "parquet",
    "screener",
    # VI 관측 채록 — legend 해독 근거라 재취득 경로가 없다.
    "research",
)

# 옵트인 미러 대상. 보존창(raw 3일 · _archive 7일) 안에만 존재하므로 백업 주기가
# 그보다 길면 어차피 못 잡는다. 용량이 지배적이라(raw 실측 351GB) 기본 제외다.
_RAW_ROOTS: tuple[str, ...] = ("raw",)
_LIVE_ROOTS: tuple[str, ...] = ("live", "live_kiwoom")

# 어떤 경로에서도 제외. 이름 기준 매칭이라 하위 어디에 있든 걸린다.
_EXCLUDE_NAMES: frozenset[str] = frozenset({
    ".local",        # KIS/키움 토큰 — 백업본 유출 시 실전투자 자격증명이 함께 나간다
    "duckdb-tmp",    # 스필. 최대 50GiB 이고 복원 가치 0
    ".queue.lock",   # flock 전용
})


def resolve_backup_dest(explicit: str | os.PathLike[str] | None = None) -> Path:
    """백업 목적지. 인자 > ``HOGA_BACKUP_DEST`` env 순."""
    if explicit is not None:
        return Path(explicit).expanduser()
    raw = os.environ.get("HOGA_BACKUP_DEST", "").strip()
    if not raw:
        raise ValueError(
            "백업 목적지가 없습니다. --dest 를 주거나 HOGA_BACKUP_DEST 를 설정하세요."
        )
    return Path(raw).expanduser()


def _is_excluded(path: Path) -> bool:
    return any(part in _EXCLUDE_NAMES for part in path.parts)


def _owned_by_state(rel: Path) -> bool:
    """이 파일을 상태 아카이브가 이미 담는가.

    ``screener/`` 는 미러 루트인데 그 안의 ``saves.json`` 은 사용자 저작물이라 상태
    항목이기도 하다. 양쪽에 담으면 복원 시 **어느 쪽이 정본인지 모호해진다** —
    미러는 절대 지우지 않으므로 사용자가 지운 저장뷰가 미러에 영원히 남는다.
    파일마다 소유자를 하나로 정한다: 상태 항목이면 아카이브만 담는다.
    """
    parts = rel.parts
    return any(
        parts[: len(item_parts)] == item_parts
        for item_parts in (tuple(Path(item).parts) for item in _STATE_ITEMS)
    )


@dataclass(frozen=True)
class BackupResult:
    dest: Path
    # 무엇을 담았는지. 출력에 반드시 실어야 한다 — HOGA_DATA_DIR 를 빠뜨리면 엉뚱한
    # (또는 빈) 디렉토리를 담고도 출력은 성공처럼 보인다. 실측으로 겪은 함정이다.
    data_dir: Path | None = None
    state_archive: Path | None = None
    state_items: int = 0
    state_bytes: int = 0
    copied_files: int = 0
    copied_bytes: int = 0
    skipped_files: int = 0        # 목적지가 이미 최신
    pruned_archives: int = 0
    daily_run_done: bool | None = None   # 오늘 17:00 런이 끝났나(정합성 신호)
    warnings: list[str] = field(default_factory=list)
    dry_run: bool = False


def _daily_run_done_today(data_dir: Path, *, today: str) -> bool | None:
    """``scheduler_state.json`` 의 마커로 오늘 일일 런 완료 여부를 읽는다.

    None 은 "알 수 없음"(파일 없음·손상)이다. 이 값은 **차단이 아니라 표시**다 —
    아직 안 돌았어도 백업은 해야 한다. 다만 그 사본은 JSONL 이 아직 원위치이고
    parquet 이 미확정인 상태일 수 있다는 사실을 사용자가 알아야 한다.
    """
    marker = data_dir / "scheduler_state.json"
    try:
        payload = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    last = payload.get("last_daily_run_date")
    return last == today if isinstance(last, str) else None


def _iter_files(root: Path):
    """root 아래 일반 파일을 전부 순회한다(제외 규칙 적용, 심볼릭 링크 무시)."""
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        here = Path(dirpath)
        # 제외 디렉토리는 통째로 가지치기 — 하위를 걷지도 않는다.
        dirnames[:] = [d for d in dirnames if d not in _EXCLUDE_NAMES]
        for name in filenames:
            if name in _EXCLUDE_NAMES or ".corrupt-" in name:
                continue
            p = here / name
            if p.is_symlink() or not p.is_file():
                continue
            yield p


def _needs_copy(src: Path, dst: Path) -> bool:
    """크기 또는 mtime 이 다르면 복사한다.

    해시 비교를 하지 않는 이유: 시장 데이터는 파티션이 불변이라 재기록 자체가 드물고,
    수십 GB 를 매일 해싱하는 비용이 얻는 것보다 크다. 원자적 교체(os.replace)라
    크기·mtime 이 같은데 내용이 다른 경우는 실질적으로 생기지 않는다.
    """
    try:
        d = dst.stat()
    except FileNotFoundError:
        return True
    s = src.stat()
    return s.st_size != d.st_size or int(s.st_mtime) != int(d.st_mtime)


def _write_state_archive(
    data_dir: Path, symbol_master: Path | None, out_dir: Path, *, stamp: str, dry_run: bool,
) -> tuple[Path | None, int, int]:
    """T0 상태를 tar.gz 한 벌로 묶는다. (경로, 항목수, 바이트) 반환.

    ``.tmp`` 로 쓴 뒤 **읽어서 검증하고** rename 한다. 중간에 죽은 실행이 목적지에
    유효해 보이는 반쪽 아카이브를 남기면, 세대 정리가 그걸 정상본으로 세어 진짜
    백업을 밀어낸다.
    """
    members: list[tuple[str, Path]] = []
    for rel in _STATE_ITEMS:
        p = data_dir / rel
        if p.exists():
            members.append((rel, p))
    # symbol-master.json 은 data_dir **밖**의 형제이고 HOGA_DATA_DIR 오버라이드가
    # 적용되지 않는다(hoga/config.py). data_dir 만 담으면 조용히 빠지는 항목이다.
    if symbol_master is not None and symbol_master.exists():
        members.append((symbol_master.name, symbol_master))

    if not members:
        return None, 0, 0
    if dry_run:
        total = sum(p.stat().st_size for _, p in members if p.is_file())
        return out_dir / f"state-{stamp}.tar.gz", len(members), total

    out_dir.mkdir(parents=True, exist_ok=True)
    final = out_dir / f"state-{stamp}.tar.gz"
    tmp = out_dir / f".state-{stamp}.tar.gz.tmp"
    try:
        with tarfile.open(tmp, "w:gz") as tar:
            for arcname, path in members:
                tar.add(path, arcname=arcname, filter=_tar_filter)
        # 검증: 다시 열어 목록이 읽히는지 본다. 여기서 터지면 rename 하지 않는다.
        with tarfile.open(tmp, "r:gz") as tar:
            count = sum(1 for _ in tar)
        size = tmp.stat().st_size
        os.replace(tmp, final)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return final, count, size


def _tar_filter(info: tarfile.TarInfo) -> tarfile.TarInfo | None:
    """아카이브 안에서도 제외 규칙과 격리본을 거른다(디렉토리 항목 재귀 대비)."""
    name = Path(info.name).name
    if name in _EXCLUDE_NAMES or ".corrupt-" in name:
        return None
    return info


def _prune_state_archives(out_dir: Path, *, keep: int, dry_run: bool) -> int:
    """오래된 상태 스냅샷을 정리한다. 이름순 = 시간순(UTC 타임스탬프 접두)."""
    if keep <= 0:
        return 0
    archives = sorted(out_dir.glob("state-*.tar.gz"))
    doomed = archives[:-keep] if len(archives) > keep else []
    if not dry_run:
        for p in doomed:
            p.unlink(missing_ok=True)
    return len(doomed)


def _mirror(
    data_dir: Path, mirror_root: Path, roots: list[str], *, dry_run: bool,
) -> tuple[int, int, int]:
    """덧쓰기 전용 미러. (복사, 바이트, 최신이라 건너뜀) 반환.

    목적지에서 지우는 코드는 **일부러 없다**. 원본의 prune(raw 3일 · archive 7일)이나
    오삭제가 백업으로 전파되면 백업이 아니다.
    """
    copied = copied_bytes = skipped = 0
    for rel_root in roots:
        src_root = data_dir / rel_root
        if not src_root.is_dir():
            continue
        for src in _iter_files(src_root):
            rel = src.relative_to(data_dir)
            if _is_excluded(rel) or _owned_by_state(rel):
                continue
            dst = mirror_root / rel
            if not _needs_copy(src, dst):
                skipped += 1
                continue
            copied += 1
            copied_bytes += src.stat().st_size
            if dry_run:
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            tmp = dst.with_name(f".{dst.name}.tmp")
            try:
                # copy2 는 mtime 을 보존한다 — 다음 실행의 _needs_copy 비교 근거다.
                shutil.copy2(src, tmp)
                os.replace(tmp, dst)
            except BaseException:
                tmp.unlink(missing_ok=True)
                raise
    return copied, copied_bytes, skipped


def run_backup(
    data_dir: Path,
    dest: Path,
    *,
    symbol_master: Path | None = None,
    include_raw: bool = False,
    include_live: bool = False,
    keep: int = KEEP_DEFAULT,
    dry_run: bool = False,
    now: dt.datetime | None = None,
) -> BackupResult:
    """상태 스냅샷 1벌 + 시장 데이터 덧쓰기 미러를 목적지에 만든다."""
    now = now or dt.datetime.now(dt.UTC)
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    warnings: list[str] = []

    if not data_dir.exists():
        raise FileNotFoundError(f"data_dir 이 없습니다: {data_dir}")
    # 목적지가 원본 안이면 백업이 자기 자신을 먹으며 무한히 자란다.
    resolved_dest, resolved_src = dest.resolve(), data_dir.resolve()
    if resolved_dest == resolved_src or resolved_src in resolved_dest.parents:
        raise ValueError(f"목적지가 data_dir 내부입니다: {dest}")

    kst_today = (now + dt.timedelta(hours=9)).strftime("%Y%m%d")
    daily_done = _daily_run_done_today(data_dir, today=kst_today)
    if daily_done is False:
        warnings.append(
            "오늘 17:00 일일 런이 아직 끝나지 않았습니다 — JSONL 이 아직 원위치이고 "
            "parquet 이 미확정일 수 있습니다(사본은 그래도 유효합니다)."
        )

    state_archive, state_items, state_bytes = _write_state_archive(
        data_dir, symbol_master, dest / "state", stamp=stamp, dry_run=dry_run,
    )
    if state_archive is None:
        warnings.append("상태 파일이 하나도 없습니다 — 신규 설치이거나 data_dir 이 틀렸습니다.")
    pruned = _prune_state_archives(dest / "state", keep=keep, dry_run=dry_run)

    roots = list(_MARKET_ROOTS)
    if include_raw:
        roots += list(_RAW_ROOTS)
    if include_live:
        roots += list(_LIVE_ROOTS)
    copied, copied_bytes, skipped = _mirror(data_dir, dest / "market", roots, dry_run=dry_run)

    if not dry_run:
        # 시장 데이터가 아직 없어도 market/ 은 만든다. 백업 레이아웃이 스스로를
        # 설명해야 하고, 검증기가 "디렉토리 없음" 과 "아직 승격분 없음" 을 구별할 수
        # 있어야 한다 — 신규 설치를 실패로 보고하면 아무도 검증을 안 보게 된다.
        (dest / "market").mkdir(parents=True, exist_ok=True)

    result = BackupResult(
        dest=dest,
        data_dir=data_dir,
        state_archive=state_archive,
        state_items=state_items,
        state_bytes=state_bytes,
        copied_files=copied,
        copied_bytes=copied_bytes,
        skipped_files=skipped,
        pruned_archives=pruned,
        daily_run_done=daily_done,
        warnings=warnings,
        dry_run=dry_run,
    )
    if not dry_run:
        _write_manifest(dest, result, now=now, data_dir=data_dir)
    return result


def _write_manifest(dest: Path, result: BackupResult, *, now: dt.datetime, data_dir: Path) -> None:
    """마지막 실행 요약. 복원할 사람이 "언제 것이고 무엇이 들었나" 를 알아야 한다."""
    payload = {
        "finished_at": now.isoformat(),
        "data_dir": str(data_dir),
        "state_archive": result.state_archive.name if result.state_archive else None,
        "state_items": result.state_items,
        "state_bytes": result.state_bytes,
        "copied_files": result.copied_files,
        "copied_bytes": result.copied_bytes,
        "skipped_files": result.skipped_files,
        "daily_run_done": result.daily_run_done,
        "warnings": result.warnings,
    }
    dest.mkdir(parents=True, exist_ok=True)
    tmp = dest / ".MANIFEST.json.tmp"
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, dest / "MANIFEST.json")


# ── 복원 리허설 ──────────────────────────────────────────────────────────────
#
# 검증하지 않은 백업은 백업이 아니다. 리허설을 "월 1회 수동 절차" 로 문서에만 적으면
# 아무도 안 한다 — 명령 하나로 만들어 타이머가 대신 돌게 한다.

@dataclass(frozen=True)
class VerifyResult:
    ok: bool
    checks: list[tuple[str, bool, str]] = field(default_factory=list)

    def failed(self) -> list[tuple[str, bool, str]]:
        return [c for c in self.checks if not c[1]]


_PARQUET_MAGIC = b"PAR1"


def verify_backup(dest: Path, *, sample: int = 20) -> VerifyResult:
    """백업본을 **실제로 열어** 쓸 수 있는지 확인한다.

    존재 확인만으로는 부족하다 — 0바이트 파일도, 잘린 tar 도 존재는 한다. 그래서
    상태 아카이브는 임시 디렉토리에 **풀고** JSON 을 파싱해 보고, parquet 은 표본을
    골라 앞뒤 매직바이트(PAR1)를 확인한다.
    """
    checks = [
        _check_manifest(dest),
        _check_state_archive(dest),
        _check_market_mirror(dest, sample=sample),
    ]
    return VerifyResult(ok=all(c[1] for c in checks), checks=checks)


def _check_manifest(dest: Path) -> tuple[str, bool, str]:
    manifest = dest / "MANIFEST.json"
    if not manifest.exists():
        return ("manifest", False, "MANIFEST.json 없음 — 백업이 완주한 적이 없습니다")
    try:
        payload = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return ("manifest", False, f"파싱 실패: {exc}")
    return ("manifest", True, f"마지막 실행 {payload.get('finished_at', '?')}")


def _check_state_archive(dest: Path) -> tuple[str, bool, str]:
    archives = sorted((dest / "state").glob("state-*.tar.gz"))
    if not archives:
        return ("state-archive", False, "상태 스냅샷이 없습니다")
    newest = archives[-1]
    try:
        with tempfile.TemporaryDirectory() as td:
            with tarfile.open(newest, "r:gz") as tar:
                names = tar.getnames()
                # filter="data" 는 절대경로·상위탈출·특수파일을 거른다(PEP 706).
                # 우리가 만든 아카이브라도 검증기가 신뢰를 전제하면 안 된다.
                tar.extractall(td, filter="data")
            bad = [
                f"{name}: {exc}"
                for name, exc in _json_parse_failures(Path(td), names)
            ]
        if bad:
            return ("state-archive", False, "; ".join(bad[:3]))
    except (OSError, tarfile.TarError) as exc:
        return ("state-archive", False, f"{newest.name} 열기 실패: {exc}")
    return (
        "state-archive", True,
        f"{newest.name} — {len(names)}개 항목 복원·JSON 파싱 확인 (세대 {len(archives)})",
    )


def _json_parse_failures(root: Path, names: list[str]):
    """복원된 JSON 을 실제로 파싱해 본다 — 담기만 하고 깨진 사본을 잡는다."""
    for name in names:
        p = root / name
        if p.is_file() and p.suffix == ".json":
            try:
                json.loads(p.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                yield name, exc


def _check_market_mirror(dest: Path, *, sample: int) -> tuple[str, bool, str]:
    market = dest / "market"
    if not market.is_dir():
        return ("market-mirror", False, "market/ 이 없습니다")
    total = sum(1 for _ in market.rglob("*") if _.is_file())
    parquets = sorted(market.rglob("*.parquet"))[:sample]
    if not parquets:
        # 신규 설치라 아직 승격된 parquet 이 없을 수 있다 — 실패로 보고하면 아무도
        # 검증을 안 보게 된다. 대신 **파일 수를 그대로 노출**해 0 이면 사용자가
        # data_dir 설정을 의심할 수 있게 한다.
        return (
            "market-mirror", True,
            f"parquet 사본 없음 (사본 {total}개) — 신규 설치이거나 data_dir 이 틀렸습니다",
        )
    broken = [
        str(p.relative_to(market))
        for p in parquets
        if p.stat().st_size < _MIN_PARQUET_BYTES or not _has_parquet_magic(p)
    ]
    if broken:
        return ("market-mirror", False, f"손상 {len(broken)}건: {', '.join(broken[:3])}")
    return ("market-mirror", True, f"사본 {total}개, parquet 표본 {len(parquets)}개 구조 확인")


def _has_parquet_magic(path: Path) -> bool:
    """parquet 은 PAR1 로 시작하고 PAR1 로 끝난다 — 잘린 사본을 잡는 싼 검사."""
    try:
        with path.open("rb") as fh:
            if fh.read(4) != _PARQUET_MAGIC:
                return False
            fh.seek(-4, os.SEEK_END)
            return fh.read(4) == _PARQUET_MAGIC
    except OSError:
        return False
