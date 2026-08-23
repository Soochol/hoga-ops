"""ADR 번호는 하나의 문서만 가리킨다 — 새 충돌을 막는 가드.

## 왜 필요한가

ADR 번호는 **식별자**다. 코드 주석·다른 ADR·커밋 메시지·GitHub 이슈가 「ADR-0135」로
문서를 부르고, 그중 커밋 메시지와 이슈는 **나중에 고칠 수 없다**. 그래서 한 번호가 두
문서를 가리키기 시작하면 그 인용들은 영구히 모호해진다.

병행 세션이 많은 이 리포에서 실제로 여섯 번 났다(2026-08-23 발견). 원인은 늘 같다 —
두 세션이 각자 `ls docs/adr | tail` 로 다음 번호를 고르고 같은 값을 얻는다.

## 막는 방향과 못 보는 것

**막는다**: 새 번호 충돌. 동결 목록 밖의 중복이 하나라도 생기면 실패한다.

**못 본다**: 이미 난 충돌의 모호성. 동결된 다섯 쌍은 **둘 다 인용돼 있어** 옮길 수
없고(옮기면 인용마다 「어느 쪽이었나」 판정이 필요하다), 각 문서 머리에 서로를 가리키는
경고를 달아 두는 것이 최선이었다. 이 테스트는 그 상태를 **동결**할 뿐 고치지 않는다.

**등록 의존 없음**: 파일 시스템을 직접 읽으므로 새 ADR 을 어디 등록할 필요가 없다.

## 동결 목록을 늘리지 말 것

여기 번호를 추가하는 것은 「충돌을 허용한다」는 뜻이다. 새 ADR 이 이 테스트를 빨갛게
만들면 **번호를 바꿔라** — 아직 아무도 인용하지 않은 시점이라 비용이 0 이다. 그것이
0154 에서 실제로 통했다(인용 0 인 쪽을 0158 로 옮겼다).
"""

from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path

ADR_DIR = Path(__file__).resolve().parents[2] / "docs" / "adr"

#: 역사적 충돌 — 둘 다 인용돼 있어 되돌릴 수 없다(모듈 도크스트링 참조).
#: **늘리지 말 것.**
FROZEN_DUPLICATE_NUMBERS: frozenset[str] = frozenset({"0055", "0057", "0059", "0090", "0135"})

_ADR_NAME = re.compile(r"^(\d{4})-.+\.md$")


def _numbers() -> dict[str, list[str]]:
    by_number: dict[str, list[str]] = defaultdict(list)
    for path in sorted(ADR_DIR.iterdir()):
        m = _ADR_NAME.match(path.name)
        if m:
            by_number[m.group(1)].append(path.name)
    return by_number


def test_adr_dir_is_readable() -> None:
    """양성 대조 — 디렉터리를 못 읽으면 아래 단언이 공집합 위에서 통과한다."""
    assert len(_numbers()) > 100, "ADR 을 거의 못 읽었다 — 경로가 틀렸을 수 있다"


def test_no_new_duplicate_adr_numbers() -> None:
    duplicates = {n: files for n, files in _numbers().items() if len(files) > 1}
    unexpected = {n: f for n, f in duplicates.items() if n not in FROZEN_DUPLICATE_NUMBERS}
    assert not unexpected, (
        "새 ADR 번호 충돌: "
        + "; ".join(f"{n} → {', '.join(f)}" for n, f in sorted(unexpected.items()))
        + " — 아직 아무도 인용하지 않았을 때 번호를 바꾸는 것이 가장 싸다. "
          "동결 목록에 추가하지 말 것(모듈 도크스트링)."
    )


def test_frozen_duplicates_still_exist() -> None:
    """동결 목록이 **실제 상태와 일치**하는가.

    누군가 역사적 충돌을 해소했는데 목록이 남아 있으면, 그 번호가 다시 충돌해도
    이 가드가 침묵한다. 동결선은 좁게 유지돼야 의미가 있다.
    """
    duplicates = set(_numbers()) & FROZEN_DUPLICATE_NUMBERS
    actual = {n for n, files in _numbers().items() if len(files) > 1}
    stale = FROZEN_DUPLICATE_NUMBERS - actual
    assert not stale, (
        f"동결 목록에 있는데 이제 충돌이 아니다: {sorted(stale)} — 목록에서 빼라"
    )
    assert duplicates, "동결 목록의 번호가 하나도 존재하지 않는다 — 경로 오류일 수 있다"
