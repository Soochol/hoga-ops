"""`kiwoom_live/*` → `kiwoom_live/KRX/*` 마이그레이션 (ADR-0140 §3).

⚠ 이 스크립트는 **실행 전에 한 번 틀렸다**. 예전 `_plan` 은 *"이미 옮긴 디렉터리는
파일이 venue 아래에만 있다"* 고 **가정**하고 평면 파일을 전부 옮겼다. PR-D1 이 머지돼
앱이 새 레이아웃으로 쓰기 시작하자 그 가정이 깨졌고, 실측 2026-08-05 기준 **273
Stock-Date 가 두 모양을 같은 파일명으로** 갖고 있었다.

`Path.rename` 은 POSIX 에서 대상을 **조용히 덮어쓴다**. 그대로 돌렸다면 새 승격이 쓴
`KRX/*.parquet` 1,365 개가 옛 평면본으로 되돌아가고, 평면 `meta.json` 이
`KRX/meta.json` 위로 옮겨져 **source 레벨 meta 와 venue 레벨 meta 를 한 번에** 파괴했다.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from migrate_kiwoom_live_venue_dir import _plan


def _sd(root: Path, date: str, code: str) -> Path:
    d = root / date / code / "kiwoom_live"
    d.mkdir(parents=True)
    return d


def test_unmigrated_dir_moves_everything_including_meta(tmp_path):
    """미마이그레이션 디렉터리의 평면 `meta.json` 은 **그 시절의 venue meta** 라 함께 옮긴다."""
    src = _sd(tmp_path, "20260720", "000100")
    (src / "snapshots.parquet").write_bytes(b"old")
    (src / "meta.json").write_text("{}")

    plan = _plan(tmp_path, reverse=False)

    assert {s.name for s, _ in plan.moves} == {"snapshots.parquet", "meta.json"}
    assert all(d.parent.name == "KRX" for _, d in plan.moves)
    assert not plan.stale and not plan.source_meta


def test_migrated_dir_never_moves_over_existing_files(tmp_path):
    """⚠ 회귀 가드. venue 디렉터리가 있으면 **아무것도 안 옮긴다** — 덮어쓰기가 없다."""
    src = _sd(tmp_path, "20260805", "053080")
    (src / "KRX").mkdir()
    (src / "KRX" / "snapshots.parquet").write_bytes(b"new")   # 새 승격이 쓴 정본
    (src / "snapshots.parquet").write_bytes(b"stale")         # 옛 평면 잔재

    plan = _plan(tmp_path, reverse=False)

    assert plan.moves == []                                    # 이동 0 — 이게 요점이다
    assert [f.name for f in plan.stale] == ["snapshots.parquet"]
    assert (src / "KRX" / "snapshots.parquet").read_bytes() == b"new"


def test_source_level_meta_is_preserved_not_moved(tmp_path):
    """마이그레이션된 디렉터리의 평면 `meta.json` 은 **source 레벨 정본**이다(PR-E).

    `expected_venues`·`nxt_enabled` 가 거기 산다 — venue 밖 한 단계 위여야 "NXT 가 없는
    날"의 이유를 적을 자리가 남기 때문이다. 잔재로 오인해 옮기면 그 정보가 사라지고
    동시에 venue meta 를 덮어쓴다.
    """
    src = _sd(tmp_path, "20260805", "053080")
    (src / "KRX").mkdir()
    (src / "KRX" / "meta.json").write_text('{"collection_complete": true}')
    (src / "meta.json").write_text('{"expected_venues": ["KRX", "NXT"]}')

    plan = _plan(tmp_path, reverse=False)

    assert plan.moves == []
    assert [f.name for f in plan.source_meta] == ["meta.json"]
    assert plan.stale == []  # meta.json 은 잔재가 아니다 — 삭제 대상에도 안 든다


def test_plan_is_idempotent_on_a_fully_migrated_tree(tmp_path):
    """전부 옮겨진 트리는 계획이 비어 있다 — 재실행이 안전하다."""
    src = _sd(tmp_path, "20260720", "000100")
    (src / "KRX").mkdir()
    (src / "KRX" / "snapshots.parquet").write_bytes(b"x")

    plan = _plan(tmp_path, reverse=False)

    assert plan.moves == [] and plan.stale == [] and plan.source_meta == []


def test_reverse_moves_venue_files_back_up(tmp_path):
    """되돌림은 유일하게 제공되는 복구 수단이다(ADR-0140 §8)."""
    src = _sd(tmp_path, "20260720", "000100")
    (src / "KRX").mkdir()
    (src / "KRX" / "snapshots.parquet").write_bytes(b"x")

    plan = _plan(tmp_path, reverse=True)

    assert [(s.name, d.parent.name) for s, d in plan.moves] == [
        ("snapshots.parquet", "kiwoom_live"),
    ]
