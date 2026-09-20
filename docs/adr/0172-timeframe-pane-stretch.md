# 0172 — Pane Stretch는 봉 프로필별로 저장한다

**Status:** accepted (2026-09-20)

**Amends:**
- [ADR-0114](0114-live-workspace-order-layer-and-layout-presets.md) §3의 pane 크기 전역 1세트 정책
- [ADR-0152](0152-per-window-indicator-sets.md) §9의 레이아웃 전역 1세트 정책

## Context

pane 순서·그룹·축 모드는 봉과 무관한 배치 의미지만, pane 높이는 실제로 함께 표시되는
지표 수와 종류에 좌우된다. 분봉에서 쓰는 호가·체결 pane과 일봉에서 쓰는 투자자 pane은
구성이 달라 한쪽에서 separator를 드래그하면 다른 봉의 유용한 비율이 깨졌다.

## Decision

1. `paneStretch`와 `paneGroupStretch`를 `minute` / D / W / M 네 프로필로 저장한다.
   모든 분봉 간격은 `minute`을 공유한다.
2. 프로필은 차트 창별이 아니다. 같은 봉 프로필을 보는 모든 창이 같은 높이를 공유한다.
3. pane 순서, 병합 그룹, 축 모드는 계속 전역 한 세트다.
4. 기존 flat 저장값은 최초 정규화에서 네 프로필에 복제한다. 따라서 업그레이드 직후
   레이아웃에는 시각적 변화가 없고, 이후 드래그부터 프로필이 갈라진다.
5. flat `paneStretch`와 `paneGroupStretch`는 구 빌드 호환을 위해 `minute` 프로필의
   미러로 한동안 함께 쓴다. 새 필드가 일부만 있으면 빠진 프로필은 flat 값으로 채운다.
6. 레거시 flat 프리셋의 높이는 종전의 전역 적용 의미를 보존해 네 프로필 모두에 적용한다.
7. separator 종료 시 개별 pane와 병합 그룹 높이를 같은 프로필에 한 번의 store commit으로
   기록한다. 서로 다른 시점의 스냅샷이 섞이는 리셋 회귀를 막기 위함이다.

## Consequences

- 일봉 높이 조정이 분봉에 영향을 주지 않고, 봉을 왕복하면 각 프로필의 높이가 복구된다.
- 1분봉과 5분봉은 같은 `minute` 프로필이므로 서로 영향을 준다.
- 봉별 높이는 `live.indicators.v2`의 전역 localStorage에 남아 새로고침과 크로스탭
  동기화를 그대로 따른다.
