# 0032 — Drawing property panel (supersedes ADR-0030 in part)

**Status:** accepted (2026-05-25)
**Supersedes (in part):** ADR-0030 (post-commit clears selection) — only the post-commit clause; the empty-click-deselects companion is preserved.

## Decision

The **Replay Viewer** ships a **Drawing Property Panel** that floats over the chart whenever a **Drawing** is selected in `select` mode. The panel lets the user edit color (16-entry palette), stroke width ({1,2,3,4,5} px), and line style (solid / dashed / dotted), and delete the drawing. The user's last-picked style values are persisted globally to `localStorage["replay.drawingDefaults.v1"]` as **Drawing Defaults** and seed the next new drawing of any kind.

To make the panel always point at a clear target, after a drawing tool commits a new shape the active tool reverts to `select` **and `selectedId` is set to the new drawing's id** — restoring halo + 2× stroke on the freshly-committed shape. This reverses the post-commit clause of ADR-0030.

The empty-click-deselects companion from ADR-0030 is **kept**: clicking on empty chart space in `select` mode clears `selectedId`, hiding the panel.

## Why this supersedes ADR-0030

ADR-0030 argued that a halo on a shape the user had not clicked read as visual noise — *"select mode = nothing selected"* was the user's mental model and a fresh halo broke it. That argument depended on there being **no DOM affordance** that pointed at the freshly-drawn shape: the halo had nothing to anchor.

Once a property panel exists, the halo *is* the visual anchor for the panel. Removing it would make the panel float over the chart with no indication of which drawing it controls. The 2026-05-25 brainstorm session re-examined the trade-off with the panel feature in scope and re-decided the post-commit clause.

The empty-click-deselects clause from ADR-0030 stands because it is independent of the panel: it solves the orthogonal problem of stale selection lingering after unrelated chart interactions.

## Why the palette is fixed

Free-form colour entry would (a) break `DESIGN.md`'s colour-token discipline by introducing arbitrary hex values, (b) add a non-trivial input surface (hex parsing, eyedropper, contrast accessibility), and (c) tempt users into per-drawing colour tweaking that produces noisy charts. Sixteen palette entries cover the practical needs (system / market / strong / muted / grayscale) while keeping the colour vocabulary disciplined.

The palette is registered in `DESIGN.md` as a fourth "user annotation layer" category alongside the existing three (system / status / market direction), because annotations are user-authored content rather than UI chrome — distinct in intent and provenance.

## Why session-only panel position

Persistent panel position would be feature creep — the panel's role is "edit this drawing now," not "remember where I parked the panel for this line." Two questions would also have to be answered (per-drawing? per-stock? what about pan/zoom?) for a feature whose return is "the panel reopens 30 pixels to the left of where it would otherwise." We chose to skip the question and accept that the panel re-anchors per selection.

> **Superseded in part by ADR-0062 (2026-06-03).** The *re-anchor per selection* clause was reversed: once the user drags the panel it becomes **sticky** and keeps the last position across selections. The *no-persistence (session-scoped)* decision in this section is retained — sticky position still dies with the page.

## Consequences

- `Drawing.lineStyle` field added; legacy hydration defaults to `'solid'`.
- `useDrawingsStore` gains a `defaults` slice; `update(id, patch)` syncs style fields into defaults.
- `ToolCtx` loses `accentColor` and gains `defaults: DrawingDefaults`.
- `revertToSelectMode(newId)` regains its `newId` argument and selects the just-added shape; the Escape handler in `DrawingOverlay.tsx` still clears explicitly (Escape's "return to neutral" semantic is unchanged).
- `setStroke` writes `setLineDash(dashPattern(lineStyle, width))` and switches `lineCap` to `'round'` for dotted (round-cap zero-length-dash dot trick).
- A new component `DrawingPropertyPanel.tsx` mounts as a sibling of `DrawingOverlay` in `ChartStage`.
- ADR-0030's status header is updated to "superseded in part by ADR-0032."
- CONTEXT.md's `Drawing Tool` entry is rewritten to cite ADR-0032 for the post-commit description; the `Drawing Property Panel` and `Drawing Defaults` glossary entries were added during the brainstorm grill and remain accurate.

## Alternatives considered

- **Keep ADR-0030 verbatim; show the panel without restoring selection.** Rejected — the panel would point at a drawing rendered in the same style as every other drawing; the user could not tell which one is being edited.
- **Free-form hex input.** Rejected — colour-token discipline + accessibility cost (see "Why the palette is fixed").
- **Persistent panel position.** Rejected — feature creep with low return.
- **Locked drawings.** Out of scope for v1. The model doesn't need a `locked` field yet; if added later, the panel grows a lock toggle.

## 2026-10-29 — 보조지표 색상 팔레트 공유

사용자 요청으로 위의 **16색 고정 팔레트** 결정을 대체한다. 그리기 속성 패널은
보조지표의 `MA_COLOR_ROWS`(8열 × 4단계 명도, 32색)를 같은 순서로 사용하며,
원형 스와치·테마를 따르는 선택 외곽선·체크 표시도 보조지표와 통일한다.
단일·다중 선택에 같은 팔레트를 쓰고 선택 즉시 적용·닫기 계약을 유지한다.
자유 HEX 입력은 추가하지 않는다. 팔레트에서 빠진 기존 색도 저장된 드로잉과
도구별 기본값에서 그대로 유지하며, 사용자가 새 색을 고를 때만 바뀐다.

## 2026-11-01 — 빠른 도구 메뉴와 분석 도구 편집

사용자가 승인한 빠른 도구 메뉴 안을 적용한다. 상단 버튼을 유지하고 검색·즐겨찾기,
분류별 도구·그리기 목록 탭을 제공한다. 목록에서 선택·개별 숨김·잠금·삭제를 처리한다.
새 왼쪽 레일이나 상시 고정 작업 창은 추가하지 않는다. 팔레트·밀도·테마 토큰과
ADR-0108의 속성 패널 이동·복원 계약을 유지한다.

수평 레이, 추세선 좌/우 연장, 피보나치 되돌림, 평행 채널, 롱·숏 포지션을 지원한다.
선택한 그리기의 설정에서 이름·가격/값·KST 시각을 입력하고 이름 있는 스타일을
저장한다. 이름·좌표는 명시적인 `이름 · 좌표 적용` 한 동작으로 반영하며 유효하지 않은
포지션 가격 순서와 같은 시각의 채널 기준선은 저장하지 않는다. 색·레벨·연장 등의
옵션은 변경 즉시 반영한다. 스타일 템플릿은 도구 종류별 스타일만 담으며 좌표·잠금을
복사하지 않는다.

`연속 그리기`는 기본 끔이며 켜면 일반 그리기 도구를 유지한다. 끄면 생성 후 선택
모드로 돌아가 새 그리기를 선택한다. 이는 2026-07-01 도구 유지 계획의 무조건 연속
동작을 사용자 선택으로 대체한다. 일자 기준선은 기존 단발 동작을 유지하고 지우개는
연속 동작을 유지한다. 기존 단축키는 바꾸지 않는다. 자석 제거(ADR-0173)도 유지한다.


### 2026-11-01 보완 — 피보나치 확장·경로·콜아웃·회귀 채널

추가 네 종류도 기존 빠른 메뉴·종류별 스타일·숨김·잠금·복제·그룹 이동·실행취소·
내보내기/가져오기·종목/봉 슬롯 저장 계약을 공유한다. 새 왼쪽 도구막대는 만들지 않는다.
경로는 클릭 정점과 미확정 호버 점을 분리한다. 더블클릭의 중복 클릭은 저장하지 않는다.
콜아웃은 대상의 실시간 Point와 화면상 메모 간격을 분리해 상자만 옮길 수 있다.
기존 텍스트의 IME 안전 편집기를 재사용하고 줄바꿈은 Shift+Enter, 완료는 Enter다.

회귀 채널은 현재 로드된 관측 봉 서수를 독립변수로 한 OLS와 잔차 모집단 표준편차
`sqrt(SSE/n)`로 계산한다. 시작/끝 시각의 봉이 모두 로드되어 있고 구간의 기준가가
전부 유효해야 한다. 두 봉 이상이면 생성하며 σ=0도 유효하다. 구간·기준가·봉 배열이
바뀌면 다시 계산한다. 범위 밖이나 잘못된 데이터는 임의로 보간/대체하지 않고 계산을
생략한다. 저장된 구간을 선택하면 데이터 부족 안내와 시간 설정을 제공한다.
회귀의 가격은 데이터가 결정하므로 핸들/몸통/키보드/그룹 이동은 시간만 옮긴다.
앵커 가격은 공통 Point 호환용이며 회귀 계산·좌표 편집·수직 정렬에 사용하지 않는다.
