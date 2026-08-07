"""Live storage-target planning (키움 WS 전담).

KIS WebSocket 계층은 ADR-0118 PR-G에서 삭제됐다 — 실시간 호가·체결 수집은 키움 WS
전담이다. 이 모듈은 저장 대상(관심종목 + 히트맵)을 키움 세션 용량에 맞춰 계획한다.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

from hoga.api.watchlist_projection import capture_ordered_codes

_log = logging.getLogger(__name__)

# 키움 WS 연결당 등록 상한 = 총 200종목, **타입 무관**(실측 2026-07-16, ADR-0116).
# 종목당 1건(0B+0D 쌍도 200종목)이라 TR 수로 나누지 않는다. 4앱키=800종목.
KIWOOM_WS_MAX_REGISTRATIONS = 200
KIWOOM_PER_ACCOUNT_MAX = KIWOOM_WS_MAX_REGISTRATIONS

# 업종·지수(0J/0U) 구독분 예약 — **마지막 계정에만** 건다(`_account_cap`).
# 값은 `sector_registry.SECTOR_CODES` 길이여야 하는데, 여기서 import 하면 순환이
# 생긴다(sector_registry → 없음, 하지만 coverage 는 저수준이라 방향을 지킨다).
# 대신 테스트가 두 값의 일치를 못 박는다 — 목록이 늘어나면 그 테스트가 먼저 깨진다.
KIWOOM_SECTOR_RESERVE = 66


@dataclass(frozen=True)
class LiveStorageTargets:
    ws_targets: tuple[str, ...]
    capture_candidates: tuple[str, ...]
    # 키움 WS 수집 대상(ADR-0116). kiwoom off/무자격(capacity 0)이면 () — 미수집.
    kiwoom_targets: tuple[str, ...] = ()


# ── venue 구독 파생 (ADR-0140 §2·§5, PR-F) ────────────────────────────────────
#
# 시분할(시각→venue 1개)을 폐지하고 **세 venue 를 동시에** 구독한다. 한 종목이
# 차지하는 wire 등록 수가 1 또는 3 으로 갈리므로, 슬롯 회계가 "종목 수"에서
# **"등록 수"**로 바뀐다 — 이 파일이 그 환산의 정본이다.
#
#     NXT 상장   → ("KRX", "NXT", "UN")   3 등록
#     NXT 미상장 → ("KRX",)               1 등록
#
# 실측 2026-08-05: 저장셋 274 종목(관심 23 + 히트맵 271, 중복 20) 중 NXT 상장 176 ·
# 미상장 98 → **626 등록**. 계정당 200 이므로 **앱키 4개**가 필요하다(274 종목 시절엔
# 2개로 충분했다). 모자라면 plan_storage_targets 가 초과분을 드롭하고 경고한다.
_ALL_VENUES: tuple[str, ...] = ("KRX", "NXT", "UN")
_KRX_ONLY: tuple[str, ...] = ("KRX",)


def subscription_venues(
    code: str, nxt_map: Mapping[str, bool | None] | None,
) -> tuple[str, ...]:
    """이 종목에 구독할 venue 들. ``nxt_map`` 은 `symbols.nxt_enabled_by_code()`.

    **모름은 미상장이 아니다 — 구독한다**(fail-open). 근거는 두 실패의 비대칭이다:

    - 모름을 미상장으로 보면 → NXT 에 실제로 상장된 종목의 그날 데이터가 **영구 결손**
      이다. 지나간 장은 다시 안 온다(ADR-0140 §8 "저장은 끄는 것이 더 위험하다").
    - 모름을 상장으로 보면 → 미상장 코드에 `_NX`/`_AL` 을 구독해 **슬롯 2개를 낭비**
      한다. 다음 마스터 갱신에 회수된다.

    실무에서 이 fail-open 이 비싸지 않은 이유: 마스터 시드가 **커밋돼 있어**
    (`kiwoom_master_seed.json`, 4,274행) 자격증명 없이도 로드된다. 실측 저장셋 274
    종목의 "모름"은 **0건**이었다. `nxt_map is None`(마스터 완전 미로드)은 부팅 1회뿐이고,
    그 창에서는 전 종목이 3배를 쓰므로 용량 경고가 뜬다 — 조용하지 않다.

    ⚠ 키움은 **미상장 코드에도 `rc=0` ACK 를 준다**(#1127 실측). 그래서 잘못된 구독은
    등록 완결 술어로는 안 잡히고, 오직 "틱이 안 온다"로만 드러난다. 파생을 여기서
    정확히 하는 것이 유일한 방어선이다.
    """
    if nxt_map is None:
        return _ALL_VENUES  # 마스터 미로드 — 전량 fail-open(용량 경고로 드러난다)
    return _KRX_ONLY if nxt_map.get(code) is False else _ALL_VENUES


def venue_weight(code: str, nxt_map: Mapping[str, bool | None] | None) -> int:
    """이 종목이 차지하는 wire 등록 수 — 슬롯 예산의 단위."""
    return len(subscription_venues(code, nxt_map))


def partition_kiwoom(
    codes: list[str],
    n: int,
    *,
    weight: Callable[[str], int] | None = None,
    last_account_reserve: int = KIWOOM_SECTOR_RESERVE,
) -> list[list[str]]:
    """키움 계정별 disjoint 분할 — **wire 등록 수**가 계정당 200 을 넘지 않게 순차로 채운다.

    ``weight`` 미지정(=모두 1)이면 예전 슬라이싱과 **결과가 동일**하다: 코드 0~199 가
    계정 0, 200~399 가 계정 1 … . 시분할 시절엔 종목 1개 = 등록 1개라 그 가정이 맞았다.

    한 종목의 등록들은 **쪼갤 수 없다**(같은 연결이 KRX·NXT·UN 을 함께 받아야 표시·저장
    라우팅이 한 stream 으로 모인다). 그래서 경계에서 계정당 최대 2 슬롯이 놀 수 있다 —
    bin-packing 최적화는 하지 않는다. 낭비 상한이 `n×2` 로 작고, 순서를 흔들면
    관심종목 우선(plan_storage_targets)이 깨진다.

    초과분(용량 넘는 종목)은 어느 계정에도 안 담긴다(호출자 책임 — `_sync_locked` 경고).
    """
    w = weight or (lambda _code: 1)
    parts: list[list[str]] = [[] for _ in range(n)]
    account, used = 0, 0
    for code in codes:
        cost = w(code)
        while account < n and used + cost > _account_cap(account, n, last_account_reserve):
            account += 1
            used = 0
        if account >= n:
            break  # 용량 소진 — 남은 코드는 드롭(호출자가 경고)
        parts[account].append(code)
        used += cost
    return parts


def _account_cap(account: int, n: int, reserve: int = KIWOOM_SECTOR_RESERVE) -> int:
    """이 계정이 **저장셋에** 쓸 수 있는 상한.

    마지막 계정만 낮다 — 업종·지수 구독(0J/0U)이 거기 얹히기 때문이다. 그 구독은
    **슬롯을 먹는다**: 코드당 1개, 타입 수와 무관(2026-08-07 실측 — 업종 66개 등록 후
    종목이 130 에서 `rc=105115` 로 막혔다).

    예약을 안 걸었다가 실제로 터졌다: 저장셋이 계정 0 을 199/200 까지 채운 뒤 업종
    50개 배치가 거부됐고, 결과는 `tick_count: 0` 의 **조용한 실패**였다(화면은 폴링
    baseline 으로 그려져 아무 증상이 없다).

    마지막 계정을 고르는 이유는 파티셔너가 **앞에서부터 채우기** 때문이다 — 저장셋이
    용량을 다 쓰지 않는 한 뒤쪽이 항상 한가하다. 다 쓰는 날엔 이 상한이 저장셋을
    그만큼 밀어내는데, 그게 옳다: 밀린 종목은 `targets_over_capacity` 경고로 드러나지만
    업종 구독 실패는 조용하다.
    """
    # 예약이 상한을 삼키면 저장셋이 통째로 드롭된다 — 최소 1 자리는 남긴다(테스트가
    # 작은 상한을 주입하는 경로 방어).
    if account != n - 1:
        return KIWOOM_PER_ACCOUNT_MAX
    return max(1, KIWOOM_PER_ACCOUNT_MAX - reserve)


def _fit_within_capacity(
    codes: tuple[str, ...], capacity: int, weight: Callable[[str], int],
) -> tuple[str, ...]:
    """등록 수 합이 ``capacity`` 를 넘지 않는 앞부분. 순서(관심종목 우선)를 보존한다.

    비싼 종목 하나에서 멈추지 않고 **계속 훑는다** — 뒤의 싼 종목(KRX 전용, 1 등록)은
    아직 들어갈 수 있다. 여기서 break 하면 NXT 상장 종목 하나가 뒤의 미상장 종목
    수십 개를 통째로 밀어낸다.
    """
    taken: list[str] = []
    used = 0
    for code in codes:
        cost = weight(code)
        if used + cost > capacity:
            continue
        taken.append(code)
        used += cost
    return tuple(taken)


def plan_storage_targets(
    capture_candidates: list[str],
    *,
    heatmap_candidates: tuple[str, ...] = (),
    kiwoom_capacity: int = 0,
    weight: Callable[[str], int] | None = None,
) -> LiveStorageTargets:
    """저장셋 = 관심종목 + 히트맵, 키움 WS 전담(ADR-0118 PR-G 칼 컷오버).

    KIS WebSocket 계층이 삭제되어 ``ws_targets``는 **항상 빈 튜플**이다. 실시간은 키움
    WS가 유일 소스이므로 활성화 스위치가 따로 없다 — ``kiwoom_capacity``(=200×앱키수)가
    양수면(자격증명 존재) 곧 활성이다.

    **자격증명 존재**(capacity>0): 관심종목+히트맵 dedup union이 kiwoom_targets(저장셋,
    용량까지 관심종목 우선). 용량 초과분은 미수집(경고, 계좌 추가로 대응).

    **자격증명 부재**(capacity 0): 저장셋이 비어 아무것도 수집하지 않는다
    (fix-forward — KIS REST/WS 폴백 없음).
    """
    candidates = tuple(capture_candidates)
    candidate_set = set(candidates)
    heatmap = tuple(
        code for code in dict.fromkeys(heatmap_candidates) if code not in candidate_set
    )
    if kiwoom_capacity > 0:
        # 컷오버: 관심종목 먼저(우선) + 히트맵 = 저장셋.
        storage_set = candidates + heatmap
        # capacity 는 **등록 수** 예산(200×앱키수)이다 — 종목 수가 아니다(PR-F).
        # weight 미지정이면 종목당 1 이라 예전 슬라이싱과 동일하다.
        w = weight or (lambda _code: 1)
        kiwoom_targets = _fit_within_capacity(storage_set, kiwoom_capacity, w)
        dropped = len(storage_set) - len(kiwoom_targets)
        if dropped > 0:  # 초과분은 미수집 — 계좌 추가로 대응(폴백 없음)
            _log.warning(
                "live.storage.storage_set_over_kiwoom_capacity dropped=%d cap=%d "
                "regs=%d — venue 동시 구독은 NXT 상장 종목당 등록 3개를 쓴다(앱키 추가로 대응)",
                dropped, kiwoom_capacity, sum(w(c) for c in storage_set),
            )
    else:
        kiwoom_targets = ()
    return LiveStorageTargets(
        ws_targets=(),
        capture_candidates=candidates,
        kiwoom_targets=kiwoom_targets,
    )


def _known_symbol_codes() -> set[str]:
    from hoga.api import symbols as _symbols  # noqa: PLC0415

    return {h.code for h in _symbols.search("", limit=10_000)}


def _compute_capture_candidates(data_dir: Path) -> list[str]:
    from hoga.api.watchlist import load_document  # noqa: PLC0415

    known = _known_symbol_codes()
    doc = load_document(data_dir)
    candidates = capture_ordered_codes(doc, known_codes=known if known else None)
    if known:
        all_enabled = capture_ordered_codes(doc)
        dropped = tuple(code for code in all_enabled if code not in known)
        if dropped:
            _log.warning("live.capture.codes_unknown dropped=%r", list(dropped))
    else:
        _log.warning(
            "live.capture.symbol_master_cold kept=%d surface=watchlist — 필터 생략(fail-open)",
            len(candidates),
        )
    return candidates


def _compute_heatmap_codes(data_dir: Path) -> tuple[str, ...]:
    """Heatmap codes for Kiwoom WS capture (ADR-0116; 유일 저장 경로).

    Document order preserved; symbol-master filter mirrors
    _compute_capture_candidates (cold cache keeps all).

    fail-open은 의도된 설계지만 **저장셋 크기를 캐시 상태에 종속시킨다** — 같은 설정이
    실행 시점마다 다른 수집 대상을 만들 수 있으므로 생략 사실을 반드시 로그로 남긴다.
    실서버에서 캐시가 빌 수 있는 창은 부팅 1회뿐이다(`load_disk_state`가 커밋된 시드로라도
    채우고 `refresh`는 성공 시에만 `_cache`를 재바인딩한다). 그 창은 startup_runtime이
    심볼 마스터를 라이브 기동보다 먼저 로드해 닫는다 — 이 로그가 뜨면 그 순서가 깨진 것이다.
    """
    from hoga.api.heatmap import load_heatmap  # noqa: PLC0415

    codes = list(dict.fromkeys(entry.code for entry in load_heatmap(data_dir)))
    known = _known_symbol_codes()
    if not known:
        _log.warning(
            "live.capture.symbol_master_cold kept=%d surface=heatmap — 필터 생략(fail-open)",
            len(codes),
        )
        return tuple(codes)
    dropped = [code for code in codes if code not in known]
    if dropped:
        _log.warning("live.capture.heatmap_codes_unknown dropped=%r", dropped)
    return tuple(code for code in codes if code in known)
