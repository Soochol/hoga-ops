"""Offline calculation from the frozen 477-stock snapshot; no server or broker IO."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
from fractions import Fraction
from pathlib import Path

import polars as pl

from hoga.market_breadth import POLICY_ID, aggregate_codes, aggregate_groups, stock_signals

HERE = Path(__file__).resolve().parent
MEMBERS = HERE.parent / "2026-10-30-etf-constituent-validation"
PRICES = HERE.parent / "2026-10-30-etf-confirmed-observations"
SELECTED = HERE.parent / "2026-10-30-etf-universe"


def read(path):
    return json.loads(path.read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(name, data):
    (HERE / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def checked_file(directory, name):
    expected = read(directory / "validation.json")["files"][name]
    if sha(directory / name) != expected:
        raise ValueError(f"Frozen input checksum mismatch: {directory.name}/{name}")
    return directory / name


def number(value):
    return round(float(value), 8) if value is not None else None


def metrics(result):
    return {
        "constituent_count": len(result.codes),
        "codes": list(result.codes),
        "periods": {
            str(period): {
                "above": counts.above,
                "equal": counts.equal,
                "below": counts.below,
                "unavailable": counts.unavailable,
                "denominator": counts.total,
                "above_pct": number(counts.above_pct),
                "coverage_pct": number(counts.coverage_pct),
            }
            for period, counts in result.periods.items()
        },
        "score": number(result.score),
        "score_exact": str(result.score) if result.score is not None else None,
    }


def inputs():
    files = [
        checked_file(MEMBERS, name)
        for name in (
            "memberships.json",
            "universe.json",
            "security-observations.json",
            "daily-evidence/calendar.json",
        )
    ]
    files += [
        checked_file(PRICES, name)
        for name in (
            "confirmed-adjusted.parquet",
            "summary.json",
            "stocks.json",
            "ma-verification.json",
        )
    ]
    selected = read(SELECTED / "selected.json")
    selected_hash = read(SELECTED / "validation.json")["output_sha256"]["selected.json"]
    if sha(SELECTED / "selected.json") != selected_hash:
        raise ValueError("Selected ETF identity changed")
    files.append(SELECTED / "selected.json")
    members, universe = read(MEMBERS / "memberships.json"), read(MEMBERS / "universe.json")
    provenance = read(PRICES / "summary.json")
    observations = read(PRICES / "stocks.json")
    if any(
        r["confirmation_state"] != "confirmed" or r["adjusted_as_of"] != provenance["adjusted_as_of"]
        for r in observations
    ):
        raise ValueError("Unconfirmed or mixed adjusted bases")
    codes = {r["code"] for r in universe}
    if {r["code"] for r in observations} != codes:
        raise ValueError("Confirmation evidence and stock identities differ")
    constituent_dates = {row["referenceDate"] for row in members}
    if len(constituent_dates) != 1 or constituent_dates != {row["constituent_reference_date"] for row in universe}:
        raise ValueError("Mixed or inconsistent constituent reference dates")
    provenance = {**provenance, "constituent_reference_date": next(iter(constituent_dates))}
    groups = {r["code"]: [] for r in selected}
    for row in members:
        groups[row["etf_code"]].append(row["componentItemCode"])
    if set(c for codes_ in groups.values() for c in codes_) != codes:
        raise ValueError("ETF membership and stock union differ")
    target = dt.date.fromisoformat(provenance["target_end"])
    sessions = [
        dt.date.fromisoformat(d) for d in read(MEMBERS / "daily-evidence/calendar.json") if d <= target.isoformat()
    ]
    frame = pl.read_parquet(PRICES / "confirmed-adjusted.parquet")
    if set(frame["code"]) != codes or frame["date"].max() != target:
        raise ValueError("Price universe or target date mismatch")
    if frame.select(pl.struct("code", "date").n_unique()).item() != frame.height:
        raise ValueError("Duplicate stock/date in price snapshot")
    histories = {code: {} for code in sorted(codes)}
    for row in frame.iter_rows(named=True):
        if row["date"] > target:
            raise ValueError("Unfinished or future price row")
        histories[row["code"]][row["date"]] = row["close"]
    return selected, groups, universe, histories, sessions, provenance, files


def stock_output(signals, universe, halts):
    result = []
    for stock in universe:
        code = stock["code"]
        result.append(
            {
                "code": code,
                "name": stock["name"],
                "market": stock["market"],
                "known_current_halt": code in halts,
                "etf_codes": stock["etf_codes"],
                "periods": {
                    str(period): {
                        "close": number(value.close),
                        "sma": number(value.sma),
                        "sma_exact": str(value.sma) if value.sma is not None else None,
                        "state": value.state,
                        "missing_dates": [day.isoformat() for day in value.missing_dates],
                    }
                    for period, value in signals[code].items()
                },
            }
        )
    return result


def inclusive_crosscheck(signals):
    proof = read(PRICES / "ma-verification.json")
    result = []
    for part in proof["comparisons"]:
        period = part["period"]
        strict = {c for c, values in signals.items() if values[period].state == "above"}
        equal = {c for c, values in signals.items() if values[period].state == "equal"}
        if strict | equal != set(part["matching_codes"]):
            raise ValueError("Strict + equality differs from previously verified >= engine result")
        result.append(
            {
                "period": period,
                "strict_above": len(strict),
                "equal": len(equal),
                "previous_inclusive": len(part["matching_codes"]),
                "code_sets_reconcile": True,
            }
        )
    return result


def report(results, etfs):
    primary = results["primary"]
    ranked = sorted(etfs, key=lambda r: (-r["score"], r["code"]))
    overall_rows = "\n".join(
        f"| {period}일 | {r['above']} | {r['equal']} | {r['below']} | {r['above_pct']:.2f}% | 100% |"
        for period, r in primary["periods"].items()
    )
    table = "\n".join(
        f"| `{r['code']}` | {r['name']} | {r['constituent_count']} | "
        + " | ".join(f"{r['periods'][str(n)]['above_pct']:.2f}%" for n in (20, 60, 120))
        + f" | {r['score']:.2f} |"
        for r in ranked
    )
    score = primary["score"]
    sensitivity = results["known_halt_excluded_sensitivity"]["score"]
    (HERE / "README.md").write_text(f"""# ETF별 이평선 브레스와 전체 공탐 점수

**전체 공탐 점수는 {score:.2f} / 100**이다. 선정 ETF 38개의 편입 주식 합집합 477종목을 중복 없이 한 번씩
계산했다. 구성 기준일과 수정 기준일은 2026년 10월
30일, 평가 가격은 10월 29일까지의 공급자 확정 수정 종가다. 당일 진행 중 봉은 포함하지 않았다.

이 점수는 20·60·120일선 위 종목 비율을 같은 비중으로 평균한 `etf_ma_breadth_v1`이다. 낮은 값은 상승 추세에
참여하는 종목이 적다는 뜻이다. 선정 집합의 가격 확산을
측정하는 자체 정의이며, 전체 한국 시장의 투자자 심리나 향후 수익률로 보정한 척도는 아니다.

## 전체 집합 결과

| 기간 | 이평선 위 | 동일 | 아래 | 이평선 위 비율 | 가격 판정 가능 비율 |
|---|---:|---:|---:|---:|---:|
{overall_rows}

모든 기간의 분모는 477종목이며 판정 불가는 0개다. 최종 점수는 반올림 전 비율로 계산했다.

```text
ETF별 기간 비율 = 100 × (종가 > 해당 SMA인 종목 수) / ETF 편입 주식 수
ETF별 점수 = (20일 비율 + 60일 비율 + 120일 비율) / 3
전체 점수 = 중복 제거한 477종목에서 같은 식으로 계산
```

세 기간의 비중은 각각 1/3이며 종목별 비중도 같다. ETF 편입 비중·시가총액·CU 수량으로 가중하지 않는다. ETF 점수
38개를 평균하면 중복 편입 종목에 여러 표를 주므로 전체 지수 계산에
쓰지 않는다. 현금은 제외한다. [계산 정의](policy.json)와 [전체 결과](overall.json)에 식과 정확한 분수를
남겼다.

## ETF별 결과

각 행의 분모는 해당 ETF의 편입 주식 수다. 38개 ETF 모두 모든 기간의 가격 판정 가능 비율이 100%다. 점수
내림차순이며, 작은 집합의 한 종목 변화는 비율에 더 크게 반영된다.

| Code | ETF | 편입 주식 수 | 20일선 위 | 60일선 위 | 120일선 위 | 점수 |
|---|---|---:|---:|---:|---:|---:|
{table}

38개 ETF의 등록 행 757개는 [ETF별 결과](etf-breadth.json)에 편입 관계로 유지했다. 전체 점수의 분모는 중복 제거
후 477개다. 종목별 종가·SMA·정확한 분수·판정은
[stock-signals.json](stock-signals.json)에 있다.

## 동일 가격과 거래정지 처리

이번의 ‘위’는 **종가 > SMA**다. 이전 가격 준비 검증에서 사용한 기존 스크리너 `종가 ≥ SMA`와 구분한다. 이전
검증의 72·80·75개는 현대사료 1종목을 포함했고, 이번 엄격한
비교에서는 71·79·74개다. 같은 종목 집합인지도 `엄격한 위 ∪ 동일 = 이전 이상 조건`으로 전수 대조했다. 기존
스크리너의 연산 의미를 바꾸지 않았다.

현대사료 `016790`은 세 기간 모두 종가와 이평선이 같다. 주 결과는 요청한 477종목 전체를 유지한다. 앞 단계에서
현재 거래정지로 확인한 이 1종목만 제외하면 476종목의 참고 점수는
**{sensitivity:.2f} / 100**이다. 이는 10월 30일의 표본 거래 상태를 이용한 민감도 분석이며, 477종목 전부의 거래
가능 상태나 10월 29일의 역사적 정지 상태를 검증한
결과가 아니다. [기존 거래 상태 표본](../2026-10-30-etf-constituent-validation/security-observations.json)의
관측 시각을 보존한다.

## 결측과 해석 범위

필요한 거래일의 가격이 하나라도 없으면 그 종목은 판정 불가다. 과거의 다른 봉을 당겨 채우거나 0·이평선 아래로
바꾸지 않는다. 해당 ETF나 전체 집합에서 기간별 판정 불가가 발생하면 그 기간
비율은 `null`, 세 기간 중 하나라도 불완전하면 종합 점수도 `null`로 둔다. 현재 데이터는 전 종목·전 기간이
완전하다.

정규장 15:30만의 가격이 아니라 프로젝트가 확인한 키움 KRX 공급자 하루 집계의 마지막 가격 계약이다.
원주가·거래량의 기존 충돌은 이번 가격 비율에 섞지 않았다. 현재 편입 집합을 과거
날짜에 적용한 백테스트나 역사적 공포·탐욕 백분위는 계산하지 않았다. 점수를 극단적 공포 같은 구간으로 나누는
임계값도 아직 보정하지 않았다.

## 재현과 검증

가격 스냅샷 ID: `{results["price_snapshot_id"]}`

- 재사용 계산 모듈: [hoga/market_breadth.py](../../../hoga/market_breadth.py).
- 실행: `uv run --extra dev python docs/research/2026-10-30-etf-breadth/calculate_breadth.py`.
- `verification.json`: 기존 입력 파일의 해시 검사와 ≥ 엔진 결과 대조.
- `validation.json`: 단위 검사·독립 집계·같은 입력 재실행·입출력 해시와 코드·환경 기록.

스크립트는 보존된 가격과 편입 목록만 읽고 이 디렉터리에 결과를 쓴다. 서버·증권사 호출이나 운영 데이터 변경은
없다. 계산 모듈과 이번 결과까지 완료했으며 앱 화면과 정기 갱신 연결은 후속 단계다.
""")


def calculate():
    selected, groups, universe, histories, sessions, source, files = inputs()
    signals = stock_signals(histories, sessions)
    per_etf, overall = aggregate_groups(groups, signals)
    observations = read(MEMBERS / "security-observations.json")
    halts = {r["code"] for r in observations if r["observation"]["tradableStatus"] == "halt"}
    halts &= histories.keys()
    sensitivity = aggregate_codes(sorted(set(histories) - halts), signals)
    etfs = [
        {
            "code": etf["code"],
            "name": etf["name"],
            "group_id": etf["group_id"],
            "group_label": etf["group_label"],
            "tier": etf["tier"],
            **metrics(per_etf[etf["code"]]),
        }
        for etf in selected
    ]
    results = {
        "policy_id": POLICY_ID,
        "price_snapshot_id": source["snapshot_id"],
        "adjusted_as_of": source["adjusted_as_of"],
        "price_date": source["target_end"],
        "constituent_reference_date": source["constituent_reference_date"],
        "primary": metrics(overall),
        "known_halt_excluded_sensitivity": {"excluded_codes": sorted(halts), **metrics(sensitivity)},
        "trading_status_observed_codes": [r["code"] for r in observations],
        "trading_status_coverage": "sample_only; do not infer 476 stocks are all tradable",
    }
    write("overall.json", results)
    write("etf-breadth.json", etfs)
    write("stock-signals.json", stock_output(signals, universe, halts))
    write(
        "policy.json",
        {
            "id": POLICY_ID,
            "periods": [20, 60, 120],
            "price_field": "confirmed vendor-adjusted close",
            "average": "simple; includes the target close",
            "comparison": "close > SMA; equality is separate",
            "etf_breadth_pct": "100 * strictly_above_count / constituent_count",
            "score": "arithmetic mean of the 20, 60, 120 breadth percentages; equal 1/3 weights",
            "overall_population": "deduplicated union; one stock, one vote; not an average of ETF scores",
            "holding_weight_usage": "none",
            "cash": "excluded",
            "missing_policy": "incomplete period => null percentage; any incomplete period => null score",
            "halt_policy": "primary includes all 477 constituents; sampled current halt exclusion is sensitivity only",
            "score_range": [0, 100],
            "interpretation": "low = weak upward price breadth; high = broad upward price breadth",
            "calibration": "unfitted v1 definition; no historical quantile or investor-psychology calibration",
            "history_scope": "one current constituent snapshot; not a historical point-in-time backtest",
        },
    )
    write(
        "verification.json",
        {
            "inputs": {str(f.relative_to(HERE.parent)): sha(f) for f in files},
            "etf_count": len(etfs),
            "membership_count": sum(len(c) for c in groups.values()),
            "union_count": len(overall.codes),
            "calculation_available_count": len(histories),
            "inclusive_engine_reconciliation": inclusive_crosscheck(signals),
            "score_is_equal_weight_period_mean": overall.score
            == sum(Fraction(overall.periods[p].above * 100, len(overall.codes)) for p in overall.periods)
            / len(overall.periods),
        },
    )
    report(results, etfs)
    print(
        json.dumps(
            {
                "policy_id": POLICY_ID,
                "etfs": len(etfs),
                "stocks": len(overall.codes),
                "price_date": source["target_end"],
                "score": number(overall.score),
                "periods": results["primary"]["periods"],
                "known_halt_excluded_score": number(sensitivity.score),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    calculate()
