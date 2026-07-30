"""LiveBuffer **정상상태** 메모리 실측 — 실제 거래일 JSONL 을 버퍼에 재생.

`bench_live_buffer.py` 와 목적이 다르다. 그쪽은 합성 틱을 1ms 간격으로 넣어 **개수 캡**
상한(worst case)을 재고, 이쪽은 실제 `live_kiwoom/<date>/*.jsonl` 의 payload·cadence 로
**보존창이 결정하는 실 보유량**을 잰다. `hoga/live/buffer.py` docstring 이 인용하는
수치가 이 스크립트의 출력이다.

측정 규율 두 가지 (이걸 어기면 같은 코드가 2.4배로 나온다):

1. **peak 이 아니라 current** — `ru_maxrss` 는 프로세스 최대치라 측정용 임시 객체까지
   포함한다. 보유량은 gc 후 `VmRSS`(/proc/self/status) 로 본다.
2. **측정 자체가 만드는 churn 을 줄인다** — payload 를 엔트리마다 `json.dumps` 하면
   그 쓰레기가 peak 을 부풀린다. 미리 직렬화해 두고 `loads` 만 한다.

사용:
    uv run --extra dev python tools/measure_live_buffer_steady_state.py \\
        ~/.local/share/hoga-ops/data/live_kiwoom/20260729 --codes 800
"""

from __future__ import annotations

import argparse
import asyncio
import gc
import json
import resource
from collections import defaultdict
from pathlib import Path

from hoga.live.buffer import BUFFER_FLUSH_INTERVAL_MS, DEFAULT_RETENTION_MS, LiveBuffer
from hoga.live.snapshot import LiveSnapshot, SnapshotKind

MIB = 1024 * 1024


def vmrss_mib() -> float:
    """현재 상주 메모리(MiB). peak(ru_maxrss)이 아니라 current 를 쓰는 이유는 모듈 docstring."""
    for line in Path("/proc/self/status").read_text(encoding="utf-8").splitlines():
        if line.startswith("VmRSS:"):
            return int(line.split()[1]) / 1024
    return 0.0


def peak_mib() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


def load_payload_samples(root: Path, per_kind: int) -> dict[str, list[str]]:
    """kind 별로 실제 payload 를 `per_kind` 개씩 — 직렬화 문자열로 미리 보관."""
    raw: dict[str, list[str]] = defaultdict(list)
    for path in sorted(root.glob("*.jsonl")):
        with path.open("r", encoding="utf-8") as fh:
            for line in fh:
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                kind = obj.get("kind")
                if isinstance(kind, str) and len(raw[kind]) < per_kind:
                    raw[kind].append(json.dumps(obj.get("payload") or {}))
        if raw and all(len(v) >= per_kind for v in raw.values()) and len(raw) >= len(SnapshotKind):
            break
    if not raw:
        raise SystemExit(f"no JSONL payloads under {root}")
    return dict(raw)


async def fill(codes: int, samples: dict[str, list[str]], retention_ms: int) -> LiveBuffer:
    buffer = LiveBuffer(retention_ms=retention_ms)
    base_t_ms = 1_785_283_200_000
    for index in range(codes):
        code = f"C{index:05d}"
        for kind, payloads in samples.items():
            snapshot_kind = SnapshotKind(kind)
            for offset, payload_json in enumerate(payloads):
                t_ms = base_t_ms + offset * BUFFER_FLUSH_INTERVAL_MS
                await buffer.publish(
                    code,
                    [LiveSnapshot(t_ms=t_ms, kind=snapshot_kind, payload=json.loads(payload_json))],
                    now_ms=t_ms,
                )
    return buffer


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("jsonl_dir", type=Path, help="live_kiwoom/<YYYYMMDD>")
    parser.add_argument("--codes", type=int, default=800)
    parser.add_argument("--retention-ms", type=int, default=DEFAULT_RETENTION_MS)
    args = parser.parse_args()

    # 보존창이 담는 (code,kind) 당 엔트리 수 = 보존창 ÷ flush 주기. 실측과 일치한다.
    per_kind = args.retention_ms // BUFFER_FLUSH_INTERVAL_MS + 1
    samples = load_payload_samples(args.jsonl_dir, per_kind)

    gc.collect()
    base_current, base_peak = vmrss_mib(), peak_mib()
    buffer = asyncio.run(fill(args.codes, samples, args.retention_ms))
    gc.collect()
    current, peak = vmrss_mib(), peak_mib()
    stats = asyncio.run(buffer.stats_snapshot())

    held = int(stats["total_entries"])
    delta = current - base_current
    print(json.dumps({
        "codes": args.codes,
        "kinds": sorted(samples),
        "entries_per_code_per_kind": per_kind,
        "entries_held": held,
        "max_entries_per_deque": int(stats["max_entries_per_deque"]),
        "vmrss_delta_mib": round(delta, 1),
        "vmrss_bytes_per_entry": round(delta * MIB / held) if held else 0,
        "mib_per_code": round(delta / args.codes, 2) if args.codes else 0,
        "peak_note": f"peak {base_peak:.0f}→{peak:.0f} MiB (참고용 — 보유량은 vmrss_delta)",
    }, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
