"""Standalone research figures. Run with the bundled Python plus matplotlib."""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import numpy as np
from matplotlib import font_manager

HERE = Path(__file__).resolve().parent
COLORS = {"069500": "#235a94", "229200": "#b55a16"}


def style():
    font_manager.fontManager.addfont("/usr/share/fonts/truetype/nanum/NanumGothic.ttf")
    plt.rcParams.update(
        {
            "font.family": "NanumGothic",
            "font.size": 12,
            "axes.titlesize": 13,
            "axes.labelsize": 12,
            "legend.fontsize": 10.5,
            "xtick.labelsize": 11,
            "ytick.labelsize": 11,
            "axes.unicode_minus": False,
            "axes.spines.top": False,
            "axes.spines.right": False,
        }
    )


def dates(rows):
    return [dt.date.fromisoformat(row["date"]) for row in rows]


def timeseries(data):
    summary = data["summary"]
    fig, axes = plt.subplots(3, 1, figsize=(11, 10), sharex=True, layout="constrained")
    for panel, color, label in [
        ("fixed_complete_cohort", "#235a94", f"고정 장기 집합 {summary['cohort_size']}종목"),
        ("eligible_min_90pct", "#b55a16", "현재 집합 내 계산 가능 종목 (커버리지 ≥90%)"),
    ]:
        rows = sorted([r for r in data["daily"] if r["panel"] == panel], key=lambda r: r["date"])
        axes[0].plot(dates(rows), [r["score"] for r in rows], label=label, color=color, lw=1)
        if panel == "fixed_complete_cohort":
            axes[0].plot(
                dates(rows),
                [r["prior_q10"] for r in rows],
                color="#666666",
                lw=0.8,
                linestyle="--",
                label="고정 집합의 이전 252일 하위 10% 기준",
            )
    target = dt.date.fromisoformat(summary["target"])
    axes[0].scatter(
        [target],
        [summary["current_477_score"]],
        color="#202020",
        s=28,
        zorder=5,
        label=f"원래 477종목 현재 점수 {summary['current_477_score']:.2f}",
    )
    axes[0].set(ylabel="이평선 점수", ylim=(-2, 102))
    axes[0].legend(loc="upper left", ncols=2, frameon=False)
    for code, details in summary["benchmarks"].items():
        rows = sorted([r for r in data["benchmarks"] if r["code"] == code], key=lambda r: r["date"])
        for ax, key in [(axes[1], "drawdown252"), (axes[2], "realized_vol20")]:
            ax.plot(
                dates(rows),
                [None if r[key] is None else 100 * r[key] for r in rows],
                label=details["name"],
                color=COLORS[code],
                lw=1,
            )
    axes[1].set_ylabel("252일 고점 대비 (%)")
    axes[2].set_ylabel("20일 실현변동성\n연율 (%)")
    axes[2].set_xlabel("평가일")
    axes[1].legend(loc="lower left", frameon=False)
    for ax in axes:
        ax.grid(axis="y", color="#dddddd", lw=0.6)
        ax.axvline(target, color="#666666", lw=0.6)
        ax.margins(x=0.01)
    axes[2].xaxis.set_major_locator(mdates.AutoDateLocator(minticks=5, maxticks=9))
    axes[2].xaxis.set_major_formatter(mdates.ConciseDateFormatter(axes[2].xaxis.get_major_locator()))
    fig.suptitle("현재 편입 주식으로 재구성한 과거 참고 분석\n당시 ETF 편입 집합을 재현한 백테스트가 아님", fontsize=14)
    fig.savefig(HERE / "breadth-and-stress.png", dpi=160)
    plt.close(fig)


def distributions(data):
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.8), layout="constrained")
    for ax, panel, title in zip(
        axes,
        ("original_477", "fixed_complete_cohort"),
        ("원래 477종목 고정 집합", "가격 이력이 완전한 장기 고정 집합"),
        strict=True,
    ):
        rows = [
            r
            for r in data["daily"]
            if r["panel"] == panel and r["score"] is not None and r["date"] < data["summary"]["target"]
        ]
        summary = data["summary"]["panels"][panel]
        values = [r["score"] for r in rows]
        if values:
            ax.hist(
                values,
                bins=np.arange(0, 105, 5),
                weights=np.full(len(values), 100 / len(values)),
                color="#235a94",
                alpha=0.75,
            )
        score = summary["target_score"]
        if score is not None:
            ax.axvline(score, color="#b55a16", lw=2, label=f"같은 집합의 현재 점수 {score:.2f}")
        ax.set(
            title=f"{title}\n과거 표본 {len(values):,}일",
            xlabel="이평선 점수",
            ylabel="각 구간의 관측 비율 (%)",
            xlim=(0, 100),
        )
        ax.legend(frameon=False, loc="upper right")
        ax.grid(axis="y", color="#dddddd", lw=0.6)
    fig.suptitle("당일은 과거 분포에서 제외 · 두 패널은 종목 집합이 다름", fontsize=13)
    fig.savefig(HERE / "score-distributions.png", dpi=160)
    plt.close(fig)


if __name__ == "__main__":
    style()
    data = json.loads((HERE / "plot-data.json").read_text())
    timeseries(data)
    distributions(data)
