"""connect_bounded 가 프로세스 공유 인스턴스의 커서를 준다는 계약.

이전에는 호출마다 새 DuckDB 인스턴스였고, `memory_limit` 이 인스턴스마다 적용되므로
duck.py 가 표방한 "폭주 쿼리 하나가 서버를 죽이지 못하게" 가 성립하지 않았다(동시
생존 N 개 → 실효 상한 N × 8 GiB). 실측 근거는 hoga/duck.py docstring.
"""
from __future__ import annotations

import os
import threading

import duckdb
import pytest

from hoga.duck import connect_bounded


def _threads() -> int:
    return len(os.listdir("/proc/self/task"))


def test_same_config_shares_one_instance(tmp_path):
    """같은 설정의 두 호출은 **같은 DB** 를 본다 — 한쪽이 만든 전역 테이블이 보인다.

    별도 인스턴스였다면 두 번째 커서에서 Catalog Error 가 난다.
    """
    a = connect_bounded(temp_directory=tmp_path)
    b = connect_bounded(temp_directory=tmp_path)
    assert a is not b, "커서는 호출마다 새로 — 부모 커넥션은 스레드 안전하지 않다"

    a.execute("CREATE TABLE shared_probe AS SELECT 42 AS v")
    try:
        assert b.execute("SELECT v FROM shared_probe").fetchone() == (42,)
    finally:
        a.execute("DROP TABLE shared_probe")


def test_different_temp_dir_gets_its_own_instance(tmp_path):
    """설정이 다르면 인스턴스도 다르다 — 테스트 격리가 리셋 훅 없이 성립하는 근거."""
    a = connect_bounded(temp_directory=tmp_path / "a")
    b = connect_bounded(temp_directory=tmp_path / "b")

    a.execute("CREATE TABLE only_in_a AS SELECT 1")
    with pytest.raises(duckdb.CatalogException):
        b.execute("SELECT * FROM only_in_a").fetchall()


def test_memory_limit_is_one_shared_budget(tmp_path):
    """상한이 **프로세스 예산**이라는 주장 자체를 검증한다.

    `current_setting` 비교만으로는 판별이 안 된다 — 인스턴스가 달라도 설정값은 같기
    때문이다. `SET` 전파로 본다(실측: 같은 인스턴스면 488.2 MiB 로 전파, 다른
    인스턴스면 각자 8.0 GiB 유지).
    """
    a = connect_bounded(memory_limit="8.0 GiB", temp_directory=tmp_path)
    b = connect_bounded(memory_limit="8.0 GiB", temp_directory=tmp_path)
    try:
        a.execute("SET memory_limit='512MB'")
        assert b.execute("SELECT current_setting('memory_limit')").fetchone() != ("8.0 GiB",), (
            "한쪽의 예산 변경이 다른 쪽에 안 보인다 — 상한이 인스턴스마다 따로라는 뜻"
        )
    finally:
        a.execute("SET memory_limit='8.0 GiB'")


def test_live_connections_do_not_each_spawn_a_thread_pool(tmp_path):
    """인스턴스마다 스레드 31개(32코어 실측)가 붙던 비용이 사라졌다는 증거.

    **닫지 않고** 동시에 들고 있어야 한다 — close 하면 스레드가 회수돼 예전 코드에서도
    통과해 버린다(실제로 그렇게 썼다가 가드 구실을 못 하는 걸 확인했다). 실제 위험도
    동시 생존이지 순차 사용이 아니다. 개수를 못 박으면 코어 수에 따라 깨지므로
    **증가하지 않는다**만 주장한다.
    """
    warm = connect_bounded(temp_directory=tmp_path)
    warm.execute("SELECT 1").fetchall()
    before = _threads()

    live = []
    for _ in range(4):
        con = connect_bounded(temp_directory=tmp_path)
        con.execute("SELECT 1").fetchall()
        live.append(con)

    grown = _threads() - before
    assert grown <= 2, f"동시 커넥션 4개에 스레드가 {grown}개 늘었다 — 인스턴스가 새로 생긴다는 뜻"


def test_concurrent_cursors_from_threads(tmp_path):
    """부모 커넥션이 스레드 안전하지 않다는 제약이 커서로 해소되는지 — 동기 라우트가
    AnyIO 워커 스레드에서 부르는 실제 형태."""
    errors: list[BaseException] = []

    def work() -> None:
        try:
            con = connect_bounded(temp_directory=tmp_path)
            con.execute("CREATE TEMP VIEW t AS SELECT 1 AS v")  # 이름 충돌 없어야
            assert con.execute("SELECT v FROM t").fetchone() == (1,)
        except BaseException as exc:  # noqa: BLE001 — 워커 예외를 본 스레드로 옮긴다
            errors.append(exc)

    threads = [threading.Thread(target=work) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, f"동시 커서에서 예외: {errors[:2]}"
