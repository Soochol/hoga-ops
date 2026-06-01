# Screener — 네이티브 팝업의 popover 전환 + 빌더 기본값 2건

**작성:** 2026-06-01 (via `/superpowers:brainstorming`)
**대상 화면:** `/screener` (frontend)
**승인:** 디자인 미리보기 컴패니언으로 시각 확인 후 사용자 승인 완료 (2026-06-01)

## 배경 / 목표

`/screener`에서 네 가지를 바꾼다. 둘은 floating UI(popover/메뉴) 통일 작업, 둘은 빌더 기본 동작 단순화다.

1. **네이티브 브라우저 팝업 → 인앱 popover.** 저장 목록의 네 가지 동작(새로 저장 · 이름변경 · 덮어쓰기 · 삭제)이 지금은 `window.prompt` / `window.confirm`을 쓴다. 이 투박한 OS 팝업을 트리거 버튼에 앵커되는 앱 디자인 popover로 교체한다.
2. **빌더 기본 조건 제거.** 페이지 로드 시 자동으로 들어가던 `new_high`(신고가) 조건을 없애고 **빈 빌더**로 시작한다.
3. **조건 세부 항목 항상 표시.** 조건 행의 접힘/펼침(▾/▸) 토글을 **없애고**, ParamForm을 항상 표시한다.
4. **조건 추가 메뉴 popover 통일.** `＋ 조건 추가` 드롭다운은 이미 in-app이지만 새 popover와 메커니즘이 다르다(외부클릭 닫기 없음 + 동일 클리핑 리스크). 동일한 닫기 계약 + fixed positioning으로 통일한다.

핵심 제약: 변경 1은 저장 목록의 **mutation 안전 의미론**(아래 §변경1-안전)을 한 바이트도 바꾸지 않는다. popover는 `window.prompt/confirm`의 *반환값을 받던 자리*를 콜백으로 교체할 뿐이다. 변경 4도 동작 보존 — 조건 추가가 하는 일(카탈로그 leaf 1개 추가)은 그대로고 chrome(닫기·위치)만 통일한다.

## 비목표 (YAGNI)

- undo / 실행취소.
- 저장 이름 중복 검증.
- 빈 조건일 때 `조회` 버튼 비활성화 (백엔드에 최소-조건 검증이 없어 빈 조건 조회는 422를 내지 않음 — 현행 동작 유지).
- 중앙 모달 다이얼로그(백드롭). DESIGN.md의 minimal/Linear 기조에 과하고 코드베이스에 선례 없음.
- popover가 열린 채 리스트 스크롤 시 위치를 따라가는 재배치 (스크롤 중 열림은 드물어 수용; 필요 시 후속 보강).

## 변경 1 — 네이티브 팝업을 앵커형 popover로

### 현행 (네이티브 다이얼로그)

[SavedScreenerList.tsx](frontend/src/screener/SavedScreenerList.tsx)의 네 핸들러:

- `onCreate` — `window.prompt('조건검색 이름')`
- `onRename` — `window.prompt('새 이름', s.name)`
- `onOverwrite` — `window.confirm("…덮어쓸까요?")`
- `onDelete` — `window.confirm("…삭제?")`

### <a name="변경1-안전"></a>보존해야 하는 load-bearing 안전 의미론

이 규칙들은 popover 전환 후에도 **정확히 그대로** 유지된다. 모두 [SavedScreenerList.test.tsx](frontend/src/screener/SavedScreenerList.test.tsx)와 [Screener.test.tsx](frontend/src/pages/Screener.test.tsx)가 단언한다.

- **create / overwrite**: 디스패치 시점에 `onBeginSave()`를 **동기적으로 먼저** 호출한다(부모가 edit-generation을 스냅샷하는 in-flight 편집 가드). mutation 성공 시 새로 생성/덮어쓰기된 `SavedScreener` 객체로 `onAnchorChange(result.id)`를 호출해 anchor를 갱신한다.
- **rename**: rename의 PUT 요청 body는 **라이브 빌더의 현재 conditions가 아니라 그 save 자신의** `conditions`/`universe`를 포함해야 한다. 이 제약(save 원본 데이터 사용)이, 라이브 빌더의 수정이 rename을 통해 의도치 않게 persist되는 데이터 손실(✎ 회귀 버그)을 막는 가드다. rename은 anchor를 갱신하지 않는다.
- **확인 문구의 대상 명시**: overwrite·delete 확인 popover의 메시지는 대상 save 이름을 명시한다 ("load A → B에 덮어쓰기"가 엉뚱한 save를 조용히 clobber하는 사고 방지).
- **delete**: 지운 행이 현재 anchor였다면 `onAnchorChange(null)`을 호출해 anchor를 해제한다. 다른 행이 anchor였다면 `onAnchorChange`를 호출하지 않는다.

### 새 컴포넌트: `SavedScreenerActionPopover`

순수 프리젠테이션 컴포넌트. `kind`에 따라 두 가지 몸체만 렌더하고, 수집한 값을 콜백으로 돌려준다. **mutation 로직은 일절 갖지 않는다** — 전부 `SavedScreenerList`에 남는다.

| kind | 트리거 | 몸체 | 콜백 |
|---|---|---|---|
| `create` | 헤더 `＋` | 이름 입력(빈칸, placeholder `조건검색 이름`) | `onSubmit(name)` |
| `rename` | 행 `✎` | 이름 입력(현재 이름 prefill, 전체 선택) | `onSubmit(name)` |
| `overwrite` | 행 `⤓` | 확인문(대상명 명시) | `onConfirm()` |
| `delete` | 행 `🗑` | 확인문(대상명 명시) | `onConfirm()` |

네 kind 모두 동일한 [useDismissablePopover](frontend/src/util/useDismissablePopover.ts) 훅을 사용한다 — 닫기 동작은 kind와 무관하게 일관된다(§닫기/동작).

### 상태 모델 (`SavedScreenerList` 소유)

```
popover: { kind: 'create'|'rename'|'overwrite'|'delete'; save?: SavedScreener; anchorRect: DOMRect } | null
```

- 한 번에 하나만 열린다(올바른 UX — rename·delete 동시 불가).
- 트리거 클릭 시: `setPopover({ kind, save, anchorRect: e.currentTarget.getBoundingClientRect() })`.
- **콜백 실행 순서**: popover의 콜백(`onSubmit`/`onConfirm`)이 실행되면 → 기존 `onCreate`/`onRename`/`onOverwrite`/`onDelete`의 핸들러 본문(위 §변경1-안전 포함)을 순서대로 완전히 실행하고 → `setPopover(null)`로 popover를 닫는다.
- **동작 후 dirty/anchor 상태**:
  - create/overwrite 성공: 위 §변경1-안전대로 `onBeginSave()` → re-anchor. 빌더는 결과 save와 정확히 일치하므로 clean으로 표시된다(edit-generation 스냅샷이 갱신됨).
  - delete: anchor였던 행을 지우면 `onAnchorChange(null)`로 anchor 해제. anchor가 아니던 행이면 anchor 변화 없음.
  - **dismiss(Esc/외부클릭)**: mutation 없이 popover만 닫는다. 빌더의 편집 상태(conditions/universe/dirty/anchor)는 전혀 바뀌지 않는다.

### Positioning (핵심 기술 제약)

[SavedScreenerList.tsx](frontend/src/screener/SavedScreenerList.tsx)의 루트 카드는 `overflow-auto`다. 따라서 [MAStylePicker.tsx](frontend/src/live/indicators/MAStylePicker.tsx)식 `position: absolute` popover는 **스크롤 컨테이너에 클리핑된다.**

→ **[LiveDrawingMenu.tsx](frontend/src/live/LiveDrawingMenu.tsx#L64-L73)의 핵심 메커니즘 채택**: 트리거 클릭 시 `getBoundingClientRect()`로 `anchorRect`를 캡처하고 popover를 `position: fixed`로 렌더한다. `fixed`는 viewport 기준이라 `overflow-auto` 조상에 클리핑되지 않는다(포털 불필요).

단, **정렬 로직은 LiveDrawingMenu와 다르다.** LiveDrawingMenu는 `left: anchorRect.left`(단순 좌측 정렬, 클램프 없음)만 쓴다 — 그 버튼은 넓은 툴바에 있어 화면 밖으로 나갈 일이 없기 때문이다. 새 popover는 좁은 236px 패널 우측 글리프에 앵커되므로 **우측 정렬 + viewport 클램프를 새로 추가**한다:

- 수직: `top = anchorRect.bottom + 4` (트리거 바로 아래 4px).
- 수평: 너비 `220px`(popover 카드 너비). `left = clamp(anchorRect.right − 220, 8, window.innerWidth − 228)` — 트리거 우측에 정렬(`anchorRect.right − 220`)하되, 좌측 최소 margin 8px와 우측 최소 margin 8px(`= window.innerWidth − 220 − 8`)를 보장하도록 클램프.
- 수직 오버플로 폴백: `popover 높이 + top`이 `viewport.bottom − 8`을 넘으면 트리거 위로 띄운다(`top = anchorRect.top − popoverHeight − 4`).
- 위험 노트: `fixed`는 `transform`/`filter`/`will-change`를 가진 조상이 있으면 그 조상 기준이 되어 다시 클리핑될 수 있다. live 페이지에서 동일 메커니즘이 정상 동작하므로 앱 셸에는 그런 조상이 없다고 보지만, 구현 시 1줄 확인한다. 만약 그런 조상이 발견되면 popover를 `document.body` 포털로 옮긴다.

### 닫기 / 동작

- **닫기 계약**: 네 kind 모두 [useDismissablePopover](frontend/src/util/useDismissablePopover.ts) 재사용 — 외부 mousedown 또는 Escape. **Esc·외부클릭은 모두 어떤 동작도 실행하지 않고 popover만 닫는다**(확인 popover에서는 `취소` 클릭과 동등; 입력 popover에서는 입력 폐기). 어느 경우든 mutation은 일어나지 않는다.
- **포커스 관리**:
  - 입력형(create/rename): popover가 마운트되면 입력칸에 자동 포커스. rename은 추가로 현재 `save.name`을 prefill하고 전체 텍스트를 선택(공백 포함). 사용자가 비우면 §빈이름 규칙으로 `확인`이 비활성.
  - 확인형(overwrite/delete): 확정 버튼에 초기 포커스(네이티브 `confirm()`처럼 확인 액션이 기본값). `Enter`로 포커스된 확정 버튼이 실행된다.
  - **닫힌 뒤**: 포커스는 popover를 연 트리거 버튼(`＋`/`✎`/`⤓`/`🗑`)으로 되돌린다(접근성). focus trap은 두지 않는다(useDismissablePopover 패턴 그대로).
- **키보드**: 입력형은 `Enter` = 확정(`확인`이 활성일 때만) / `Esc` = 취소. 확인형은 `Enter` = 확정 / `Esc` = 취소.
- **<a name="빈이름"></a>빈 이름 라이브 검증**: 입력의 매 키 입력마다 값을 trim한다. trim 결과가 빈 문자열이면(공백만 입력한 경우 포함) `확인` 버튼을 비활성화한다. 공백 아닌 문자가 들어와 trim 결과가 비지 않는 즉시 활성화한다. 제출 시점 검사가 아니라 **실시간 상태**다. 이는 현행 `if (name)` 가드와 동치이며, 빈/공백 이름은 제출할 수 없다.

### 문구

- overwrite: `"{name}"을(를) 현재 빌더 조건으로 덮어쓸까요?`
- delete: `"{name}" 삭제?` — **현행 코드 그대로 유지(확정)**. 승인된 미리보기와 일치하고, 테스트는 이름 부분문자열만 단언하므로 변경 불필요. (덮어쓰기 톤과 통일하고 싶으면 검토 단계에서 `…삭제할까요?`로 바꿀 수 있으나, 기본값은 현행 유지.)
- 모든 문구: 마침표 없음, 동작 명사화 (Copy tone, DESIGN.md).

### 스타일 토큰 (DESIGN.md)

- popover 카드 = **프로젝트 floating-surface 캐논**과 동일(IndicatorPanel·LiveSettingsModal 모달, LiveSymbolSearch·capture/SymbolSearch 드롭다운이 공유; DESIGN.md Combobox 그림자 규격): `background: var(--bg-card)`; `1px solid var(--border-strong)`; `border-radius: 6px` (`--radius-lg`); 그림자 `0 8px 24px rgba(0,0,0,0.4)`; 너비 ~220px; 패딩 `--space-sm`.
- 입력: `var(--bg-input)` + `var(--border)` + `--radius-lg`, Geist Sans.
- 버튼:
  - `취소` — 중립(`--bg-input` / `--border` / `--fg-dim`).
  - create/rename/overwrite의 확정 버튼(`확인`·`확인`·`덮어쓰기`) — primary(`--accent` / `--accent-fg`).
  - delete의 확정 버튼(`삭제`) — destructive(`--error`, 흰 텍스트). **문서 전체에서 유일한 rose 사용처**.
- 폰트: UI는 Geist Sans, 숫자/요약은 Geist Mono + `tabular-nums`.

## 변경 2 — 빈 초기 빌더

- [Screener.tsx:21](frontend/src/pages/Screener.tsx#L21): `useState<ConditionLeaf[]>(() => [makeLeaf('new_high')])` → `useState<ConditionLeaf[]>(() => [])`.
- `makeLeaf` import가 [Screener.tsx](frontend/src/pages/Screener.tsx)에서 더는 쓰이지 않으면 제거(이 줄이 유일 사용처임을 확인함). `ConditionBuilder`는 자체적으로 `makeLeaf`를 import하므로 영향 없음.
- 빈 조건일 때 `조건 추가` 버튼 + 전역 사전필터만 보이고 `모두 충족 · AND` 라벨은 숨는다(기존 `conditions.length > 0` 가드가 처리).

## 변경 3 — 조건 세부 항목 항상 표시

[ConditionRow.tsx](frontend/src/screener/ConditionRow.tsx)에서 접힘/펼침 기능을 **통째로 제거**한다(기본값을 펼침으로 바꾸는 게 아니라 토글 자체를 삭제).

- `open` 상태(`useState`)와 ▾/▸ caret 버튼([ConditionRow.tsx:14-15](frontend/src/screener/ConditionRow.tsx#L14-L15))을 삭제한다.
- `{open && (...)}` 조건 렌더를 없애고 ParamForm을 **항상 렌더**한다([ConditionRow.tsx:21-25](frontend/src/screener/ConditionRow.tsx#L21-L25)).
- 제목줄의 라벨 + 요약(`entry.summarize`) + × 제거 버튼은 그대로 유지. 결과적으로 `ConditionRow`는 상태 없는 순수 표시 컴포넌트가 된다.
- 코드를 추가가 아니라 **삭제**하는 변경이라 더 단순하다. 트레이드오프: 조건이 많으면 칸이 길어져 스크롤이 필요(스크리너는 보통 조건 2~5개라 영향 미미).

## 변경 4 — 조건 추가 메뉴 popover 통일

`＋ 조건 추가` 메뉴([ConditionBuilder.tsx:26-39](frontend/src/screener/ConditionBuilder.tsx#L26-L39))는 이미 in-app 드롭다운(`<ul role="menu">`, 조건 종류 목록)이라 네이티브 팝업은 아니다. 그러나 새 popover들과 메커니즘이 달라 통일한다.

- **닫기 통일**: 현재는 외부클릭으로 닫히지 않는다(버튼 토글/항목 선택으로만 닫힘). [useDismissablePopover](frontend/src/util/useDismissablePopover.ts)를 적용해 외부 mousedown·Esc로 닫는다. 버튼 + 메뉴를 함께 감싸는 wrapper를 anchor로 두어, 트리거 버튼 클릭은 내부로 취급(토글 정상 동작 — LiveDrawingMenu와 동일 구조).
- **클리핑 방지**: [ConditionBuilder.tsx:25](frontend/src/screener/ConditionBuilder.tsx#L25)의 루트도 `overflow-auto`다. 현행 `position: absolute`(`z-10`)를 `position: fixed` + 캡처한 `anchorRect`로 바꿔 클리핑을 피한다(저장목록 popover와 동일 메커니즘).
- **위치(저장목록보다 단순)**: 이 메뉴는 전체폭 트리거 버튼 아래에 꽉 맞춰 뜬다 — `top = anchorRect.bottom + 4`, `left = anchorRect.left`, `width = anchorRect.width`. 좁은 글리프가 아니라 전체폭 버튼에 앵커되므로 저장목록 popover의 우측정렬·클램프는 불필요(실제 LiveDrawingMenu의 단순 좌측정렬에 더 가깝다).
- **스타일**: 위 floating-surface 캐논에 맞춘다 — `bg-card` + `border-border-strong` + `--radius-lg`(6px) + 그림자 `0 8px 24px rgba(0,0,0,0.4)`. 즉 현행이 캐논에서 벗어나 있으므로 `bg-bg-subtle`→`bg-card`, `rounded-md`→`rounded-lg`, Tailwind `shadow-lg`→캐논 그림자로 교체한다. `role="menu"`/`role="menuitem"` 시맨틱과 카탈로그 항목은 그대로 유지.
- **공유 여지(선택)**: 저장목록 popover와 이 메뉴가 모두 "열릴 때 `anchorRect` 캡처 + fixed 렌더"를 쓰므로, 작은 공유 훅(예: `useAnchoredRect`)으로 추출할 수 있다. 호출처가 둘뿐이라 추출 여부는 구현 계획에서 판단(YAGNI 기준).

## 테스트 영향

### 재작성 (입력 수단만 교체 — 단언은 유지)

- [SavedScreenerList.test.tsx](frontend/src/screener/SavedScreenerList.test.tsx) — 4개 동작 핸들러(create·rename·overwrite·delete)의 모든 `window.prompt`/`window.confirm` spy(현재 총 7개 `spy()` 호출: prompt 3 + confirm 4)를 제거. 대신 트리거 클릭 → (입력형) popover 입력칸에 타이핑 + `확인`/Enter, (확인형) popover `확인` 버튼 클릭. **mutation 단언은 그대로**: `onBeginSave` 동기 호출, rename이 save 자신 conds 사용, 확인문이 대상명 포함(이제 `confirmSpy` 대신 popover 텍스트에 이름 포함 단언), create/overwrite re-anchor, delete anchor 처리.
- [Screener.test.tsx](frontend/src/pages/Screener.test.tsx) — create-in-flight race 테스트(L85–105)의 `window.prompt` spy를 popover 입력 구동으로 교체. race 의미론(in-flight 편집 → `수정됨`)은 유지.

### 검증 (대개 무변경)

- [ConditionBuilder.test.tsx](frontend/src/screener/ConditionBuilder.test.tsx) — 기존 3개 테스트는 `role="menu"`/`menuitem`을 그대로 쓰므로 변경 불필요할 가능성이 높다. 단, 새 `useDismissablePopover`의 mousedown 리스너가 "메뉴에서 조건 추가" 테스트(항목 클릭)와 충돌하지 않는지 확인한다(항목은 anchor 내부라 내부 mousedown으로 취급되어 안전할 것). `getBoundingClientRect`가 jsdom에서 0을 반환해도 메뉴 렌더 자체는 영향 없음.

### 추가

- popover 열림 / Esc · 외부클릭 닫힘(mutation 없음).
- 빈/공백 이름이면 `확인` 비활성.
- rename이 현재 이름으로 prefill.
- 조건 추가 메뉴: 외부클릭 · Esc 로 닫힘.

## 파일 변경 요약

| 파일 | 변경 |
|---|---|
| `frontend/src/screener/SavedScreenerActionPopover.tsx` | **신규** — 앵커형 popover(입력/확인 두 몸체) |
| `frontend/src/screener/SavedScreenerList.tsx` | `window.prompt/confirm` 제거 → popover 상태 + 콜백. 안전 의미론 유지 |
| `frontend/src/screener/ConditionBuilder.tsx` | `조건 추가` 드롭다운을 useDismissablePopover + fixed positioning + 드롭다운 스타일로 통일 |
| `frontend/src/pages/Screener.tsx` | 기본 조건 시드 제거, 미사용 `makeLeaf` import 정리 |
| `frontend/src/screener/ConditionRow.tsx` | 접힘/펼침 토글 제거 — `open` 상태·caret 삭제, ParamForm 항상 렌더 |
| `frontend/src/screener/SavedScreenerList.test.tsx` | popover 상호작용으로 재작성 |
| `frontend/src/pages/Screener.test.tsx` | race 테스트의 prompt spy 교체 |
| `frontend/src/screener/ConditionBuilder.test.tsx` | 변경 시 검증(대개 무변경) |

## 결정 로그

- **확인 단계 유지** (사용자 선택): overwrite·delete는 대상명을 명시하는 확인 popover로 교체(즉시 실행 아님). 기존 안전장치 보존.
- **앵커형 popover 채택** (A안): 사용자가 "popover UI"를 명시 요청. 모달(B)·인라인 편집(C)은 기각.
- **조건 추가 메뉴 통일 포함** (사용자 선택): 이미 in-app이지만 외부클릭 닫기·클리핑 방지가 없어, 저장목록 popover와 동일 메커니즘(useDismissablePopover + fixed + anchorRect)으로 통일. 모든 floating UI가 한 방식으로 동작.
- **조건 세부 항목 = 토글 삭제, 항상 표시** (사용자 선택): 기본값 펼침이 아니라 접힘/펼침 기능 자체를 제거. 숨겨진 설정이 없어지고 `ConditionRow`가 상태 없는 컴포넌트로 단순화.
- **positioning = fixed + anchorRect** (LiveDrawingMenu에서 차용): 저장목록 popover는 **우측정렬·클램프·수직폴백 신규 추가**(좁은 패널 우측 앵커), 조건 추가 메뉴는 **좌측정렬·전체폭**(전체폭 버튼 앵커). `overflow-auto` 클리핑은 두 경우 모두 회피.
- **공통 floating-surface 캐논 채택**: 신규 popover와 조건추가 메뉴 모두, 프로젝트 다수 컴포넌트(모달 2 + 검색 드롭다운 2, DESIGN.md Combobox 규격)가 공유하는 `bg-card + border-strong + 6px + 그림자 0 8px 24px`로 정렬한다. 조건추가는 현행이 `bg-subtle`/`rounded-md`/`shadow-lg`로 벗어나 있어 이번에 캐논으로 맞춘다. 기존 LiveDrawingMenu·MAStylePicker도 약간 드리프트(`border`·`rounded`·`shadow-lg`)되어 있으나 이번 범위에서는 건드리지 않는다.
- **delete 문구 = "삭제?" 유지** (확정): 현행 코드·승인 미리보기와 일치.
- **미리보기 검증**: 디자인 컴패니언으로 실제 토큰 기반 목업을 렌더, 적대적 디자인/스펙/마크업 리뷰 통과 후 사용자 승인.
- **스펙 적대적 검증**: 실제 코드 대비 3렌즈(code-fidelity / consistency-completeness / ambiguity-clarity) 검증으로 18건 반영(positioning 정확성 정정, 포커스 관리·dirty/anchor 후처리·빈이름 라이브 검증 명세화 등).
