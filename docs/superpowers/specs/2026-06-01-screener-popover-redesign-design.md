# Screener — 저장목록 동작 UX 개편 + 빌더 기본값 2건

**작성:** 2026-06-01 (via `/superpowers:brainstorming`)
**대상 화면:** `/screener` (frontend)
**승인:** 디자인 미리보기 컴패니언 + 반복 협의로 사용자 승인 (2026-06-01)

> 파일명은 초기의 `popover-redesign`이지만, 협의 과정에서 설계가 **앵커형 popover → 인라인 편집 + 센터 확인 모달**로 진화했다. 이력은 §결정 로그 참조.

## 배경 / 목표

`/screener`에서 네 가지를 바꾼다. 둘은 UI 동작 개편, 둘은 빌더 기본 동작 단순화다.

1. **저장목록 동작 UX 개편.** 저장 목록의 네 동작이 지금은 네이티브 `window.prompt`/`window.confirm`을 쓴다. 이를 — **생성·이름변경 = 인라인 편집**, **덮어쓰기·삭제 = 센터 확인 모달**로 교체한다.
2. **빌더 기본 조건 제거.** 로드 시 자동으로 들어가던 `new_high`(신고가) 조건을 없애고 **빈 빌더**로 시작한다.
3. **조건 세부 항목 항상 표시.** 조건 행의 접힘/펼침 토글을 **없애고** ParamForm을 항상 표시한다.
4. **조건 추가 메뉴 닫기 수정.** `＋ 조건 추가` 드롭다운이 지금은 **바깥 클릭으로 닫히지 않는다(버그)**. 외부클릭·Esc로 닫히게 고치고, 클리핑도 함께 막는다.

핵심 제약: 저장목록의 **mutation 안전 의미론**(§변경1-안전)을 한 바이트도 바꾸지 않는다. UI(인라인 입력/모달)는 `window.prompt/confirm`이 값을 받던 자리를 대체할 뿐이다.

## 비목표 (YAGNI)

- undo / 실행취소 (덮어쓰기·삭제는 확인 모달로 사고만 예방; 되돌리기는 별도).
- 저장 이름 중복 검증 (추천 이름의 자동 번호 부여는 예외 — 아래).
- 빈 조건일 때 `조회` 버튼 비활성화 (백엔드에 최소-조건 검증 없음 → 빈 조건 조회는 422 아님).
- 조건 추가 메뉴를 센터 모달로 전환 (메뉴 성격이라 드롭다운 유지).
- 인라인 입력의 포커스 트랩 (기존 모달들도 트랩 없음 — 패턴 일관).

## 변경 1 — 저장목록 동작 UX 개편

### 현행 (네이티브 다이얼로그)

[SavedScreenerList.tsx](frontend/src/screener/SavedScreenerList.tsx): `onCreate`/`onRename` = `window.prompt`, `onOverwrite`/`onDelete` = `window.confirm`.

### 새 동작 (요약)

| 트리거 | 새 동작 |
|---|---|
| 새로 저장 `＋` | 목록에 **편집용 새 행 즉시 등장** + 추천 이름 `새조건N` + 인라인 편집. blur/Enter = 저장, Esc = 폐기 |
| 이름변경 `✎` | 해당 행을 **인라인 편집**으로 전환. blur/Enter = 확정, Esc = 원래 이름 복귀 |
| 덮어쓰기 `⤓` | **센터 확인 모달** (`[취소][덮어쓰기]`, 확정 accent) |
| 삭제 `🗑` | **센터 확인 모달** (`[취소][삭제]`, 확정 rose) |

→ 앵커형 popover는 만들지 않는다. 생성·이름변경은 인라인, 덮어쓰기·삭제는 모달.

### <a name="변경1-안전"></a>보존해야 하는 load-bearing 안전 의미론

UI만 바뀌고 아래는 **정확히 그대로** 유지된다(모두 기존 테스트가 단언).

- **create / overwrite**: 디스패치 시점에 `onBeginSave()`를 **동기적으로 먼저** 호출(부모의 in-flight 편집 가드). 성공 시 결과 `SavedScreener`로 `onAnchorChange(id)` re-anchor.
- **rename**: PUT body는 **라이브 빌더가 아니라 그 save 자신의** `conditions`/`universe`를 실어야 한다(이름만 바뀜). 이 제약이 라이브 빌더가 rename으로 의도치 않게 persist되는 데이터 손실(✎ 회귀)을 막는 가드다. rename은 re-anchor 안 함.
- **확인 모달의 대상 명시**: 덮어쓰기·삭제 모달 메시지는 **대상 save 이름을 명시**(엉뚱한 save clobber 방지). 즉시 실행이 아니어도 이 안전장치는 모달이 이어받는다.
- **delete**: 지운 행이 현재 anchor면 `onAnchorChange(null)`. 아니면 anchor 변화 없음.

### 인라인 편집 (생성 · 이름변경)

상태는 `SavedScreenerList`가 소유:

```
editing:
  | { mode: 'create'; draft: string }              // 아직 저장 안 된 편집용 새 행
  | { mode: 'rename'; id: string; draft: string }  // 기존 행 이름 편집
  | null
```

- **생성(＋)**: `setEditing({ mode:'create', draft: suggestName() })`. 목록 맨 위(또는 정해진 위치)에 **임시 행**을 렌더 — 이름칸이 `<input>`(자동 포커스 + 전체 선택). 아직 서버에 없음.
- **이름변경(✎)**: `setEditing({ mode:'rename', id: s.id, draft: s.name })`. 해당 행의 이름 span을 `<input>`(자동 포커스 + 전체 선택)으로 교체.
- **확정 = blur 또는 Enter**:
  - create: `draft`가 비어 있지 않으면 `onBeginSave()` → `createSave({ name: draft.trim(), conditions, universe })`(현재 빌더) → 성공 시 re-anchor. 비어 있으면 임시 행 폐기(저장 안 함).
  - rename: `draft`가 비고/변화 없으면 원래 이름 복귀(호출 없음). 바뀌었으면 `updateSave({ id, body: { name: draft.trim(), conditions: s.conditions, universe: s.universe } })`(save 자신 conds). re-anchor 안 함.
  - 확정 후 `editing = null`.
- **취소 = Esc**: create → 임시 행 폐기. rename → 원래 이름 복귀. 둘 다 `editing = null`, mutation 없음.
- 한 번에 한 행만 편집(`editing`이 단일값).

#### 추천 이름

- `새조건{N}` 형식. N은 **현재 저장 이름들과 겹치지 않는 가장 작은 양의 정수**(`새조건1`, 이미 있으면 `새조건2`…).
- 생성 시 입력 필드는 전체 선택 상태라 바로 덮어 타이핑 가능.

### 확인 모달 (덮어쓰기 · 삭제)

기존 [LiveSettingsModal.tsx](frontend/src/live/LiveSettingsModal.tsx) / [IndicatorPanel.tsx](frontend/src/live/indicators/IndicatorPanel.tsx) **모달 패턴을 그대로 재사용**한다. 둘이 동일 구조라 **공유 컴포넌트 `ConfirmModal`**로 추출한다.

- 구조: 백드롭 `fixed inset-0 bg-black/50 flex items-center justify-center z-[60]`(클릭 = 닫기) + 카드 `bg-bg-card border border-border-strong rounded-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.4)]`(클릭 stopPropagation). 헤더(제목 + ✕) · 메시지 · 푸터(`[취소]` + 확정).
- 닫기: `useEffect` 문서 keydown(Escape) → onClose + 백드롭 onClick → onClose + ✕/취소 버튼. (기존 모달과 동일 — `useDismissablePopover`는 안 씀.)
- 너비: 작은 확인용이라 `w-[360px] max-w-[90vw]`(설정/지표의 640px보다 작게).
- `ConfirmModal` props(안): `title?`, `message`(대상명 포함), `confirmLabel`, `tone: 'primary'|'danger'`, `onConfirm`, `onClose`.
- 상태: `confirm: { kind:'overwrite'|'delete'; save } | null`.
  - 덮어쓰기 확정: `onBeginSave()` → `updateSave({ id, body: bodyFromBuilder(s.name) })`(현재 빌더, 이름 유지) → 성공 시 re-anchor. 메시지 `"{name}"을(를) 현재 빌더 조건으로 덮어쓸까요?`, 확정 `덮어쓰기`(accent).
  - 삭제 확정: `deleteSave(s.id)` → (anchor면) `onAnchorChange(null)`. 메시지 `"{name}" 삭제?`, 확정 `삭제`(rose).
  - dismiss(Esc/백드롭/취소): mutation 없음, 빌더 무변경.

### 동작 후 dirty/anchor

- create/overwrite 성공 → re-anchor → 빌더가 결과 save와 일치 → clean.
- delete → anchor였으면 해제, 아니면 변화 없음.
- 인라인 Esc / 모달 dismiss → 빌더(conditions·universe·dirty·anchor) 무변경.

### 스타일 토큰 (DESIGN.md)

- 인라인 입력: `var(--bg-input)` + `1px solid var(--border)` + `--radius-lg`(6px), Geist Sans, 행 높이에 맞춤.
- 확인 모달 = **프로젝트 모달 캐논**(LiveSettingsModal·IndicatorPanel과 동일): `bg-card` + `border-strong` + `6px` + 그림자 `0 8px 24px rgba(0,0,0,0.4)` + 백드롭 `bg-black/50`.
- 버튼: `취소` 중립(`--bg-input`); `덮어쓰기` primary(`--accent`/`--accent-fg`); `삭제` destructive(`--error`) — 문서 내 유일 rose.
- 폰트: UI Geist Sans, 숫자/요약 Geist Mono + `tabular-nums`.

## 변경 2 — 빈 초기 빌더

- [Screener.tsx:21](frontend/src/pages/Screener.tsx#L21): `useState(() => [makeLeaf('new_high')])` → `useState(() => [])`.
- 미사용이 되는 `makeLeaf` import 제거(이 줄이 유일 사용처). `ConditionBuilder`는 자체 import이므로 영향 없음.
- 빈 조건이면 `조건 추가` + 전역 사전필터만, `모두 충족 · AND` 라벨은 숨음(기존 `conditions.length > 0` 가드).

## 변경 3 — 조건 세부 항목 항상 표시

[ConditionRow.tsx](frontend/src/screener/ConditionRow.tsx)에서 접힘/펼침 기능을 **통째로 제거**한다.

- `open` 상태(`useState`) + ▾/▸ caret 버튼([ConditionRow.tsx:14-15](frontend/src/screener/ConditionRow.tsx#L14-L15)) 삭제.
- `{open && (...)}` 조건 렌더 제거 → ParamForm **항상 렌더**([ConditionRow.tsx:21-25](frontend/src/screener/ConditionRow.tsx#L21-L25)).
- 라벨 + 요약(`entry.summarize`) + × 제거 버튼은 유지 → `ConditionRow`는 상태 없는 순수 표시 컴포넌트가 됨.

## 변경 4 — 조건 추가 메뉴 닫기 수정

`＋ 조건 추가` 메뉴([ConditionBuilder.tsx:26-39](frontend/src/screener/ConditionBuilder.tsx#L26-L39))는 in-app 드롭다운이지만 **바깥 클릭으로 닫히지 않는다**(현재 `useDismissablePopover` 미적용 — 버튼 토글/항목 선택으로만 닫힘). 사용자 확인된 버그.

- **닫기 수정**: [useDismissablePopover](frontend/src/util/useDismissablePopover.ts) 적용 — 외부 mousedown·Esc로 닫는다. 버튼+메뉴를 함께 감싸는 wrapper를 anchor로(트리거 클릭은 내부 취급 → 토글 정상; LiveDrawingMenu 구조).
- **클리핑 방지**: [ConditionBuilder.tsx:25](frontend/src/screener/ConditionBuilder.tsx#L25) 루트가 `overflow-auto` → 현행 `position: absolute`(`z-10`)를 `position: fixed` + 캡처한 `anchorRect`로. 전체폭 버튼 앵커라 `top = anchorRect.bottom + 4`, `left = anchorRect.left`, `width = anchorRect.width`(저장목록과 달리 클램프 불필요).
- **스타일**: floating-surface 캐논으로 정렬 — `bg-card` + `border-border-strong` + `--radius-lg` + 그림자 `0 8px 24px rgba(0,0,0,0.4)`(현행 `bg-bg-subtle`/`rounded-md`/`shadow-lg`에서 교체). `role="menu"`/`menuitem`·카탈로그 항목 유지.

## 컴포넌트 / 파일 변경 요약

| 파일 | 변경 |
|---|---|
| `frontend/src/screener/ConfirmModal.tsx` | **신규** — 덮어쓰기·삭제 공유 센터 확인 모달(LiveSettingsModal 패턴) |
| `frontend/src/screener/SavedScreenerList.tsx` | `window.prompt/confirm` 제거 → 인라인 편집 상태(`editing`) + 확인 모달 상태(`confirm`) + 임시 생성 행 렌더. 안전 의미론 유지 |
| `frontend/src/screener/ConditionBuilder.tsx` | `조건 추가` 드롭다운에 useDismissablePopover + fixed positioning + 캐논 스타일 |
| `frontend/src/pages/Screener.tsx` | 기본 조건 시드 제거, 미사용 `makeLeaf` import 정리 |
| `frontend/src/screener/ConditionRow.tsx` | 접힘/펼침 토글 제거 — `open`·caret 삭제, ParamForm 항상 렌더 |
| `frontend/src/screener/SavedScreenerList.test.tsx` | 인라인 편집 + 확인 모달 상호작용으로 재작성 |
| `frontend/src/pages/Screener.test.tsx` | race 테스트의 prompt spy를 인라인 입력 구동으로 교체 |
| `frontend/src/screener/ConditionBuilder.test.tsx` | 대개 무변경 + 외부클릭 닫힘 테스트 추가 |

> `SavedScreenerActionPopover`(앵커 popover)는 **만들지 않는다** — 인라인 편집 + ConfirmModal로 대체.
> 선택: 행의 인라인 편집이 커지면 `SavedScreenerRow` 컴포넌트로 분리할 수 있으나(편집 모드는 부모의 `editing`이 조정), 구현 계획에서 판단.

## 테스트 영향

### 재작성 (입력 수단만 교체 — 단언 유지)

- [SavedScreenerList.test.tsx](frontend/src/screener/SavedScreenerList.test.tsx) — `window.prompt`/`window.confirm` spy(현재 prompt 3 + confirm 4) 제거. 대신: 생성/이름변경은 **인라인 입력**에 타이핑 + blur(또는 Enter); 덮어쓰기/삭제는 **모달 확정 버튼** 클릭. **단언 유지**: `onBeginSave` 동기 호출, rename이 save 자신 conds 사용, 덮어쓰기·삭제 모달이 대상명 포함, create/overwrite re-anchor, delete anchor 처리.
- [Screener.test.tsx](frontend/src/pages/Screener.test.tsx) — create-in-flight race 테스트(L85–105)의 `window.prompt` spy를 인라인 입력(+ commit) 구동으로 교체. race 의미론(in-flight 편집 → `수정됨`) 유지.

### 추가

- 생성: ＋ → 추천 이름(`새조건N`)이 박힌 편집 행 등장 → blur/Enter → `createSave` 호출.
- 생성 Esc → 임시 행 폐기(저장 안 됨).
- 이름변경 Esc → 원래 이름 복귀(호출 없음).
- 인라인 빈/공백 이름 → 저장 안 함(create 폐기 / rename 복귀).
- [ConditionBuilder.test.tsx](frontend/src/screener/ConditionBuilder.test.tsx) — 기존 메뉴 테스트는 대개 무변경(`role=menu`/`menuitem` 유지); **외부클릭 시 닫힘** 테스트 추가.

## 결정 로그

- **설계 진화** (사용자 재설계): 앵커형 popover 4종 → **생성·이름변경 = 인라인 편집**, **덮어쓰기·삭제 = 센터 확인 모달**, **조건추가 = 드롭다운 + 닫기 수정**.
- **덮어쓰기 = 확인 모달** (사용자 최종): 즉시 실행을 검토했다가, 삭제와 동일하게 센터 확인 모달로(확정 버튼만 accent). 대상명 명시 안전장치 유지.
- **추천 이름 = `새조건N`** (사용자 선택): 겹치지 않는 가장 작은 번호.
- **저장 시점 = blur/Enter commit** (Option B): ＋는 임시 편집 행만 띄우고, 이름 확정 순간 `createSave`. Esc = 폐기.
- **확인 모달 = LiveSettingsModal/IndicatorPanel 패턴 재사용**(공유 `ConfirmModal`): Esc useEffect + 백드롭 클릭, 캐논 카드 스타일, 너비만 작게.
- **조건추가 = 드롭다운 유지 + 바깥클릭 닫힘 수정**(사용자 버그 리포트) + 클리핑 방지(fixed+anchorRect) + 캐논 스타일.
- **앵커 popover positioning 난제 소거**: 저장목록이 더 이상 앵커형이 아니라 `anchorRect`/클램프/수직폴백/포털 불필요. fixed+anchorRect는 조건추가 메뉴에만 남음.
- **rename 데이터손실 가드 유지**: 인라인이어도 PUT은 save 자신 conds.
- **빌더 기본값(변경 2·3)**: 빈 시작 + 접힘 토글 제거.
- **미리보기 검증**: 디자인 컴패니언으로 실제 토큰 기반 목업 렌더 후 사용자 승인(앵커 popover 버전). 이후 인라인/모달로 재설계됨 — 새 동작 미리보기는 필요 시 재렌더.
