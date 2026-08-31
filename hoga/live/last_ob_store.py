"""마지막 호가 스냅샷의 디스크 영속화 — **재시작이 화면을 비우지 않게** 한다.

## 왜 필요한가

`LiveBuffer._last_ob` 는 WS `0D` 프레임이 올 때마다 종목·venue 별 마지막 호가를
갱신한다. 프론트도 그 값을 이미 폴백으로 쓴다(`/api/live/series` 의 `last_ob` —
`liveSeries.ts` 가 "새로 마운트한 탭의 유일한 출처" 라고 적어 둔 그것). 그런데 그게
**메모리뿐이라 프로세스가 죽으면 전 종목이 함께 죽는다.**

2026-08-27 실측: 백엔드가 19:40 에 기동(장 마감 15:30 · 시간외 종료 18:00 **이후**)
하자 005930·000660 을 포함한 **전 종목 링버퍼가 0 건**이었고 10호가 창이 통째로
비었다. 장이 끝난 뒤라 다시 채울 소스도 없다.

## 새 수집 경로를 만들지 않는다

WS 는 이미 흐르고 `_last_ob` 는 이미 갱신된다. 이 모듈은 **디스크 왕복만** 붙인다 —
벤더 호출이 0 이다. 시간외 단일가(16:00–18:00)만은 WS 가 원리적으로 없어 REST 를
쓰는데, 그쪽은 `after_hours_store` 가 담당한다.

## 일자별이 아니라 **단일 파일**이다

날짜가 바뀌어도 그대로 복원한다(사용자 결정 2026-08-27). 근거는 대칭이다: 지금도
백엔드가 안 죽으면 `_last_ob` 는 축출 대상이 아니라 어제 값이 그대로 남아 있다
(`LiveBuffer._last_ob` 선언부 주석 — "venue 당 1건이라 축출 대상이 아니고"). 그대로
복원해야 **"재시작이 동작을 바꾸지 않는다"** 가 성립한다. 화면은 이미 스냅샷 시각을
표시하므로 어제 값을 오늘 것으로 오해할 소지도 낮다.

⚠ **마지막 문장의 전제는 2026-09-01 에 반증됐다.** 그 시각 표시는 시간외 총잔량이
함께 그려질 때만 붙는다(`krxRegularLabel` 은 `regularLadderAtMs` 가 null 이면 그냥
'정규장' 이다). 그래서 아침 08:00–08:30 에는 어제 사다리가 **아무 표식 없이** 떴고,
사용자가 "어제 정규장 마지막 모습" 으로 신고했다.

닫은 방식은 이 파일이 아니라 **표시 만료**다 — 프론트 `previousDayObExpired` 가 전일
프레임을 다음 거래일 08:00 이후 화면에서 내린다. 여기가 여전히 어제 값을 복원하는
것은 그대로 의도다: 저장을 건드리면 위의 재시작 대칭이 깨지고, 애초에 **무엇을
그릴지는 표시 계층이 정할 일**이다. 두 정책은 충돌이 아니라 층이 다르다.

## 파일은 항상 **전체 덮어쓰기**다

부분 병합을 하지 않는다 — 그래야 구독에서 빠진 종목(`drop_codes_except` 가 메모리에서
지운 것)이 파일에서도 함께 사라져 무한히 자라지 않는다. `after_hours_store` 가 병합인
것과 반대인데, 그쪽은 writer 가 종목마다 따로 오지만 여기는 **한 번에 전량**이라
그럴 이유가 없다.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path

log = logging.getLogger(__name__)

#: 데이터 디렉터리 상대 파일명.
_FILENAME = "last_ob.json"
#: 스키마 버전. 낮은 버전은 **버리지 말고** 읽을 수 있는 만큼 읽는다 — 편의 복원용
#: 데이터라 마이그레이션 비용을 들일 값이 아니다.
_SCHEMA = 1


def _path(data_dir: Path) -> Path:
    return data_dir / _FILENAME


def save(data_dir: Path, entries: dict[tuple[str, str], dict]) -> None:
    """`LiveBuffer.last_ob_snapshot()` 의 결과를 통째로 쓴다. 빈 입력은 no-op.

    빈 입력에 파일을 지우지 **않는다** — 기동 직후처럼 메모리가 아직 비어 있는 순간에
    호출되면 애써 남긴 어제 값을 날린다. "쓸 것이 없다" 와 "비우라" 는 다른 뜻이다.

    ⚠ **호출자가 버전으로 걸러야 한다.** 이 함수는 매번 쓴다 — 바뀐 게 없을 때
    건너뛰는 판정은 `last_ob_snapshot()` 이 함께 주는 버전으로 호출자가 한다.
    """
    if not entries:
        return
    codes: dict[str, dict[str, dict]] = {}
    for (code, venue), entry in entries.items():
        codes.setdefault(code, {})[venue] = entry
    p = _path(data_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps({"schema": _SCHEMA, "codes": codes}, ensure_ascii=False),
        encoding="utf-8",
    )
    os.replace(tmp, p)


def load(data_dir: Path) -> dict[tuple[str, str], dict]:
    """저장본 → `restore_last_ob` 가 먹는 모양. 없거나 손상이면 빈 dict.

    손상 파일을 격리·백업하지 않는다: 이 데이터는 편의 복원용이고 다음 flush 가
    덮어쓴다(`after_hours_store` 와 같은 판단).
    """
    p = _path(data_dir)
    if not p.exists():
        return {}
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        log.warning("live.last_ob.file_unreadable")
        return {}
    if not isinstance(doc, dict) or doc.get("schema") != _SCHEMA:
        return {}
    codes = doc.get("codes")
    if not isinstance(codes, dict):
        return {}
    out: dict[tuple[str, str], dict] = {}
    for code, by_venue in codes.items():
        if not isinstance(by_venue, dict):
            continue
        for venue, entry in by_venue.items():
            # 한 행이 깨져도 **파일 전체를 버리지 않는다**.
            if isinstance(entry, dict) and "t_ms" in entry:
                out[(str(code), str(venue))] = entry
    return out
