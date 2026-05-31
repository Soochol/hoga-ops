# 보조지표 레전드 (Chart Indicator Legend)

**Date:** 2026-05-31
**Scope:** frontend
**Status:** approved (brainstorming)

## 배경 / 목적

`/live` 차트의 각 보조지표 pane 좌상단에 레전드(범례)를 추가한다. TradingView 스타일로
각 지표의 이름·색상·**커서 시점 값**을 보여주고, 아이콘으로 지표를 끄거나(✕) 숨긴다(눈).
사용자 제공 이미지 4장이 디자인 명세다 — 이동평균선 / 거래량 / 일별 외국인 순매수량 /
일별 기관 순매수량.

## 결정 사항 (brainstorming GATE)

| 항목 | 결정 |
|---|---|
| 값 표시 | **커서 따라감** — crosshair hover 시점 값, 커서 없으면 최신값. 모든 pane |
| ✕ 아이콘 | 지표 **끄기** — popover 토글 off와 양방향 연동 |
| 눈 아이콘 (MA만) | MA 선 **일시 숨김** (지표 설정 유지, 레전드는 남김 — TradingView 방식) |
| 거래량 끄기 | popover에 **'거래량' 항목 신규 추가**(기본 on), ✕로 off |
| 거래량 "(20)" | **무시** — 거래량 값만 표시 (거래량 MA 추가하지 않음) |
| 스코프 | MA·거래량·외국인·기관 4개 pane. 분봉 전용 pane(호가비·QuoteTotals·FillStrength)은 범위 밖 |

## 아키텍처

**접근법 A — 단일 `PaneLegendOverlay`** (`LiveChartRoot`에 마운트):
- 기존 `DrawingOverlay`의 `chart.panes()` 좌표 패턴을 재사용 → 각 pane의 HTML 컨테이너
  좌상단에 레전드 div를 절대배치.
- `subscribeCrosshairMove` 구독 **1개**로 커서 위치(time/index)를 추적.
- 토글/숨김 상태는 `state/livePage` store **1곳**.

(접근법 B = pane별 레전드 컴포넌트는 crosshair 구독 중복 + 코드 분산으로 기각.)

## 컴포넌트

- **`PaneLegendOverlay`** (신규): `chart.panes()`를 순회하며 각 pane 좌상단에 레전드 행 렌더.
  - 행 = `[아이콘(눈/✕)] [라벨] [값들]`.
  - 캔들 pane: 눈 + ✕ + "이동평균선" + 기간별(각 MA 색상)+SMA 커서값 (5·20·60·120).
  - 거래량 pane: ✕ + "거래량" + 거래량 커서값.
  - 외국인 pane(D): ✕ + "일별 외국인 순매수량" + 순매수량 커서값.
  - 기관 pane(D): ✕ + "일별 기관 순매수량" + 순매수량 커서값.
- 스타일: `DESIGN.md` 토큰(색상·간격·폰트). 반투명 배경 오버레이.

## 데이터 흐름

- **정적 메타**: `livePage` store — MA configs(색상/기간), 토글 상태.
- **동적 값**: `subscribeCrosshairMove` → 커서 time/index → 각 series 값 읽기
  (`param.seriesData` 또는 projector 데이터 lookup). 커서 없으면 최신값.
- **✕ 클릭** → store 토글 off. popover ↔ 레전드 **양방향 연동**.
- **눈 클릭** → `movingAverageHidden` 토글.

## 새 상태 (livePage store + persistence)

- `volumeEnabled: boolean` (기본 **true**) — 거래량 pane on/off.
- `movingAverageHidden: boolean` (기본 **false**) — MA 선 일시 숨김 (`enabled`와 별개;
  `enabled && !hidden`일 때만 선을 그림).
- localStorage `live.indicators.v1`에 additive merge — 누락 시 `volumeEnabled→true`,
  `movingAverageHidden→false` (기존 사용자 화면 불변).

## 차트 통합

- **`paneSpecsForTimeframe`**: 거래량 spec을 `volumeEnabled` 조건부로 (현재 고정 →
  조건부 마운트; 투자자 pane과 동일한 토글 기반 패턴).
- **`MovingAverageOverlay`**: `movingAverageHidden`일 때 선 숨김(빈 데이터/visible).
- **`IndicatorPanel`**: '거래량' 카테고리 추가 (기본 on, active).

## 테스트

- `PaneLegendOverlay` 단위: 커서 index→값 매핑, ✕/눈 클릭 → store 변경.
- `IndicatorPanel`: 거래량 토글.
- `paneSpecsForTimeframe`: `volumeEnabled` 조건부 (거래량 off → pane 제거).
- persistence: `volumeEnabled`/`movingAverageHidden` 기본값 + merge.
- 브라우저 dogfooding: 레전드 표시, 커서 이동 시 값 변화, ✕/눈 동작, 거래량 토글, D/분봉.

## plan 이월 (구현 단계에서 확정)

- crosshair 값 추출 정확한 메커니즘: `param.seriesData`(series→값 Map) vs projector lookup.
- pane 좌표/HTML 컨테이너 획득: `DrawingOverlay`의 정확한 `chart.panes()` 사용 패턴.
- 레전드 스타일 토큰 매핑 (`DESIGN.md`).
- 눈 숨김의 정확한 구현: `MovingAverageOverlay`의 series `applyOptions({visible})` vs `setData([])`.
