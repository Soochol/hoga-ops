"""수급 표면의 **실제 갱신 주기**를 저장 표본에서 역산한다 (읽기 전용).

주기를 조인 뒤 "충분히 조였는가" 를 답하는 도구다. 벤더를 부르지 않고 **이미 저장된
표본만** 읽으므로 유량·슬롯 비용이 0 이고, 장중·장후 아무 때나 돌릴 수 있다.

## 두 간격은 다른 것을 잰다

    저장 표본 시각 간격   = 사실상 **폴 주기**
    값이 **바뀐** 간격    = 벤더 갱신 주기 (폴 격자에 반올림된다)

앞의 것을 벤더 주기로 읽으면 안 된다 — 중복 억제(`rows_equal`)가 응답 **전체 행**
(업종 28~33개)을 비교해서 업종 하나만 움직여도 새 표본이 되기 때문이다. 2026-08-10
실측 스킵률: 코스피 41/103 · 코스닥 9/103 · 파생 0/89.

## 판정

- **중복(dup)이 나오기 시작했다** → 폴 주기가 벤더보다 빠르다. 그 시점의 값 변화
  간격 중앙값이 실제 벤더 주기다.
- **dup 이 여전히 0** → 아직 벤더가 더 빠르다. 더 조일 여지가 남아 있다.
- 값 변화 간격이 폴 주기에 딱 붙어 있으면 **상한을 못 잰 것**이다. 그 사실을 그대로
  보고할 것 — "폴 주기 = 벤더 주기" 로 읽으면 2026-08-05 의 "90초" 오판을 반복한다
  (그건 3분 관측·변화 2회 표본이었다).

사용:
    uv run python scripts/check_flow_cadence.py
    uv run python scripts/check_flow_cadence.py --base http://127.0.0.1:8000
"""
from __future__ import annotations

import argparse
import json
import statistics
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))
ACTORS = ("individual", "foreign", "institution")
#: 간격을 하나라도 만들려면 표본이 둘은 있어야 한다.
MIN_SAMPLES = 2


def _get(base: str, path: str) -> dict:
    with urllib.request.urlopen(base + path, timeout=30) as r:  # noqa: S310 — 로컬 고정
        return json.loads(r.read())


def _hhmmss(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, KST).strftime("%H:%M:%S")


def _report(name: str, points: list[dict], keys: tuple[str, ...]) -> None:
    if len(points) < MIN_SAMPLES:
        print(f"\n[{name}] 표본 {len(points)}개 — 판정 불가")
        return

    ts = [p["t_ms"] for p in points]
    store_gaps = [round((b - a) / 1000) for a, b in zip(ts, ts[1:], strict=False)]

    changes: list[int] = []
    prev: tuple | None = None
    for p in points:
        cur = tuple(p.get(k) for k in keys)
        if cur != prev:
            changes.append(p["t_ms"])
            prev = cur
    change_gaps = [round((b - a) / 1000) for a, b in zip(changes, changes[1:], strict=False)]

    dups = len(points) - len(changes)
    print(f"\n[{name}] {_hhmmss(ts[0])} ~ {_hhmmss(ts[-1])}")
    print(f"  저장 표본 {len(points)} · 값 변화 {len(changes)} · **중복 저장 {dups}**")
    print(f"  표본 간격   중앙값 {statistics.median(store_gaps):.0f}s  "
          f"(= 사실상 폴 주기) {sorted(Counter(store_gaps).items())[:6]}")
    if change_gaps:
        med = statistics.median(change_gaps)
        print(f"  변화 간격   중앙값 {med:.0f}s  최소 {min(change_gaps)}s  "
              f"최대 {max(change_gaps)}s")
        # 폴 격자보다 촘촘한 쌍이 있어야 상한을 말할 수 있다.
        poll = statistics.median(store_gaps)
        finer = [g for g in change_gaps if g < poll * 0.9]
        if finer:
            print(f"  → 폴 주기보다 짧은 변화 {len(finer)}건(최단 {min(finer)}s) — "
                  f"**벤더가 더 빠르다**")
        elif dups > 0:
            print(f"  → 중복이 {dups}건 나왔다 — 폴 주기가 벤더보다 빠르다. "
                  f"변화 간격 중앙값 {med:.0f}s 가 실제 주기에 가깝다")
        else:
            print("  → 중복 0 + 폴 격자보다 짧은 변화 없음 — **상한 미측정**. "
                  "더 조일 여지가 있다")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    args = ap.parse_args()

    print("=" * 72)
    print("측정:", datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S KST"), "|", args.base)
    print("=" * 72)

    inv = _get(args.base, "/api/market/investor-flow")
    for market, points in (inv.get("markets") or {}).items():
        _report(f"주식 {market}", points, ACTORS)

    deriv = _get(args.base, "/api/market/deriv-flow")
    # 단위 미확정이면 억원 축이 통째로 null 이라 계약 축까지 봐야 변화가 보인다.
    keys = (*ACTORS, *(f"{a}_qty" for a in ACTORS))
    for key, product in (deriv.get("products") or {}).items():
        points = product.get("points") or []
        if points:
            _report(f"파생 {key} {product.get('label') or ''}".strip(), points, keys)


if __name__ == "__main__":
    main()
