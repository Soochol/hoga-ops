# /live 헤더 "실시간/LIVE" 디클러터 — Design

**Date**: 2026-06-12
**Status**: Draft
**Scope**: `frontend/src/live/collectionStatus.ts`, `frontend/src/live/CollectionDot.tsx` (신규), `frontend/src/live/LiveStatusBar.tsx`, `frontend/src/live/LiveSidebar.tsx`, `frontend/src/watchlist/WatchlistDrawer.tsx` (`captureHealthPill.ts`는 호출부만 바뀌고 함수는 불변)

## Problem

`/live` 화면에 "실시간 / LIVE● / live" 류 표시가 정상 상태에서도 동시에 5곳 이상 떠 있어
사용자가 중복·노이즈로 인지한다. 사용자 표현: *"·LIVE● ·LIVE● 실시간 실시간 live 너무 많아.
그리고 우측 관심종목 패널에서 종목명 리스트에도 실시간이라고 있어."*

조사 결과 각 표시는 **기능적으로는 중복이 아니라** 서로 다른 5개 신호다:

1. **연결(LiveStatusBar)** — 브라우저↔백엔드 WS 연결. `LiveStatusBar.tsx:120` `live ? 'LIVE●' : '재연결 중…'`,
   `useConnectionLiveness(LIVE_STALE_MS)` (WS heartbeat).
2. **수집방식(LiveStatusBar)** — 현재 종목이 WS 수집(`실시간`)인가 REST 표시폴링(`준실시간`)인가.
   `LiveStatusBar.tsx:142`, `deriveCollectionStatus(...)`.
3. **소스칩(LiveStatusBar)** — 이 캔들을 만든 데이터 출처. `kis_live · 10s` (`SourceChip`). 데이터
   provenance — 연결/실시간과 무관한 별개 신호.
4. **차트 커서모드(LiveSidebar)** — 차트가 최신 시점인가 hover한 과거 시점인가.
   `LiveSidebar.tsx:219` `LIVE` / `:204` `과거 시점`, `cursorMs`.
5. **행 수집상태(WatchlistDrawer)** — 관심종목 각 행의 개별 수집 상태. `WatchlistDrawer.tsx:445`
   `실시간`/`준실시간`/`저녁대기`.

추가로 **6번째 신호**가 사용자가 본 "LIVE● 2개"의 진짜 원인이다:

6. **캡처 데몬 건강(LiveStatusBar)** — 백엔드 캡처 데몬이 KIS에서 데이터를 받고 있나.
   `captureHealthPill.ts:23` `if (healthy) return 'LIVE●'` — healthy일 때 ①과 **똑같은 글자
   `LIVE●`** 를 우측 pill에 표시해 시각적 중복을 만든다.

문제의 본질은 *세 가지 다른 개념(연결/수집/커서모드)을 모두 "실시간·LIVE"라는 동의어로 라벨링*
하고, *정상 상태에서도 전부 표시*한다는 것이다. label collision + always-on noise.

부수 문제:
- 수집상태 배지가 `LiveStatusBar`와 `WatchlistDrawer`에 **인라인으로 두 번** 그려져 있고 둘 다
  `// TODO(label): 배지 문구 확정` 미해결 — 라벨·색이 따로 논다(코드 중복).
- 비관심종목을 볼 때 같은 안내가 두 곳에 중복: `LiveStatusBar.tsx:112-118` CTA + `LiveSidebar.tsx:128-142`
  rest-notice 배너.

## Invariants

이 spec이 건드리는 표면들이 현재 보존하고 있는 속성:

- **캡처 데몬 가시성**: 캡처가 비정상(`offline`/`closed`/`reconnecting`/`subscribing`/`sub_failed`/`stale`)
  이면 사용자가 그 상태를 알 수 있다. 근거: `LiveStatusBar.tsx:125-141` capture-health-pill,
  `captureHealthPill.ts` (spec 2026-06-08 §2.2 — cycle_lag_ms 대신 정직한 헬스 신호).
- **연결-검출 전송로 일치**: "재연결 중" 판정은 그 종목 데이터가 실제로 흐르는 전송로의 정지를
  반영한다. realtime은 WS(`useConnectionLiveness`=heartbeat), polling은 REST(`useQuotes`)로 **독립**.
  근거: `useConnectionLiveness.ts`(eventStream.lastHeartbeat), `liveQuotes.ts`(REST 폴링).
- **드로어 행 = collection-only**: WatchlistDrawer 각 행은 connection liveness가 아니라 그 종목의
  collection 상태만 본다(WS 끊김이 전 행을 뒤집지 않는다). 근거: `WatchlistDrawer.tsx:432`
  `deriveCollectionStatus(entry.code, liveSet, codes, viewedCodes)` — `live` 미참조.
- **색 3분리 규율**: UI상태(teal `--accent`) / 상태 semantic(`--success`·`--error`·`--warn`) /
  가격방향(`--price-up`·`--price-down`)은 상호배타. 상태 신호에 새 색을 도입하지 않는다.
  근거: `DESIGN.md` Color §, 2026-06-08 "색 추가 없는 A안" 결정.
- **소스칩 = provenance 식별자**: `kis_live`/`hogaplay`는 도메인 식별자로 영문 lowercase mono 유지,
  연결/실시간 신호와 별개 카테고리. 근거: `DESIGN.md` Copy tone §, Source identity chips §.
- **사이드바 커서모드 표현**: 최신 모드는 accent 펄스 점으로 "지금 흐름"을 표시, 과거 시점에서는
  pin된 타임스탬프를 우측에 고정(모드 전환 시 컬럼 점프 없음). 근거: `LiveSidebar.tsx:183-225`,
  ADR-0044, Design review B2.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| 캡처 데몬 가시성 | preserves | 비정상 라벨(`장 마감`/`구독 실패`/`수신 끊김` 등)은 그대로 텍스트 표시. healthy일 때만 `LIVE●` 텍스트 → 초록 점으로 교체(정보 보존, 표현만 축소). |
| 연결-검출 전송로 일치 | preserves | `deriveDisplayStatus`가 `realtime`일 때만 `!live`를 `disconnected`로 매핑. polling/waiting_eod는 connection 무관하게 그대로. |
| 드로어 행 = collection-only | preserves | WatchlistDrawer는 `deriveDisplayStatus`에 `live`를 넘기지 않음(=connected 가정) → `disconnected` 발생 불가. 표현만 `CollectionDot`으로 교체. |
| 색 3분리 규율 | preserves | 새 색 없음. `--success`(정상 점)·`--warn`(재연결)·`--error`(캡처 에러)·`--fg-dimmer`(준실시간/저녁대기)·`--accent`(사이드바 펄스) 재사용. |
| 소스칩 = provenance 식별자 | preserves | `SourceChip` 변경 없음. |
| 사이드바 커서모드 표현 | preserves | 펄스 점·타임스탬프 위치 유지. 영문 `LIVE`→`최신`, `과거 시점`→`과거` 카피만 변경. |

이 spec은 어떤 invariant도 깨지 않는다. 모든 변경은 *정보 보존 + 표현 축소*(텍스트→점) 또는
*카피 변경*이다.

## Goals

- 정상 상태에서 화면의 "실시간/LIVE/live" **텍스트 단어 수 0개** (현재 5개+). 데이터가 정상으로
  흐를 때 화면은 조용하다.
- 예외 상태(연결끊김·준실시간·캡처이상)는 **즉시 텍스트**로 드러난다 — no news = good news,
  bad news = loud.
- 층위별 어휘 분리: 연결/수집=점(예외시 텍스트), 커서모드=`최신`/`과거`, 출처=`kis_live`.
- UI 중복(두 배지) + 코드 중복(인라인 2곳·`TODO(label)` 2건)을 `CollectionDot` + `deriveDisplayStatus`
  단일 출처로 제거.

## Non-Goals

- 색 팔레트·디자인 토큰 변경. (새 색 도입 금지)
- 캡처 데몬 건강 신호 자체의 로직(`captureHealthSeverity`)·임계값 변경.
- 연결 liveness 임계값(`LIVE_STALE_MS` 등) 변경.
- 밀도 모드 토글, 범례 패널 등 신규 UI 추가(YAGNI — 단일 사용자 로컬 도구).
- `live_set` 산정·KIS 수집 정책(ADR-0067) 변경.
- nav `StatusDot`("실시간 연결 활성", `StatusDot.tsx`)은 hover `title` 전용이라 *눈에 보이는*
  클러터가 아님 → 범위 밖(누락이 아니라 의식적 판단).

## Design

### 1. `collectionStatus.ts` — 표시상태 도출 + 라벨/색 단일화

기존 `deriveCollectionStatus`(순수함수)는 유지. 그 위에 표시 전용 도출 함수와 매핑을 추가한다.

```ts
export type DisplayStatus =
  | 'realtime' | 'polling' | 'waiting_eod' | 'disconnected' | 'uncollected';

/** 표시상태 = collection 상태 + (realtime 한정) WS 연결.
 *  realtime 종목만 WS에 의존하므로 !live → disconnected.
 *  polling(REST)·waiting_eod는 connection과 독립이라 그대로 통과. */
export function deriveDisplayStatus(
  live: boolean,
  status: CollectionStatus,
): DisplayStatus {
  if (status === 'realtime' && !live) return 'disconnected';
  return status;
}

/** 점/라벨/색 단일 출처. uncollected는 렌더 안 함(null). */
export const DISPLAY_PRESENTATION: Record<DisplayStatus, {
  label: string | null;   // null = 점만(정상)
  colorVar: string;       // CSS 변수명
  ariaLabel: string;      // 점만일 때 의미 전달
}> = {
  realtime:     { label: null,        colorVar: 'var(--success)',   ariaLabel: '실시간 수집 중' },
  polling:      { label: '준실시간',   colorVar: 'var(--fg-dimmer)', ariaLabel: '준실시간(REST) 표시' },
  waiting_eod:  { label: '저녁대기',   colorVar: 'var(--fg-dimmer)', ariaLabel: '관심종목 대기 중' },
  disconnected: { label: '재연결 중',  colorVar: 'var(--warn)',      ariaLabel: '연결 재시도 중' },
  uncollected:  { label: null,        colorVar: 'var(--fg-dimmer)', ariaLabel: '' },
};
```

`저녁대기` 라벨은 기존 `TODO(label)` 대상 — 본 spec에서 현행 표현으로 확정한다(정상 운영에선
드문 26초과 폴백이라 변경 가치 낮음, Non-critical).

### 2. `CollectionDot.tsx` (신규) — 표현 컴포넌트

```tsx
interface Props {
  status: DisplayStatus;
  /** true면 라벨이 있어도 점만 표시(현재 미사용, 확장 여지). */
  dotOnly?: boolean;
}
```

동작: `DISPLAY_PRESENTATION[status]` 조회 → `label === null`이면 **점만**(6px, `colorVar`,
`aria-label`=ariaLabel, `title`=ariaLabel), `label`이 있으면 **점 + 라벨 텍스트**(`colorVar`).
`uncollected`는 `null` 반환(렌더 안 함). 점은 `DESIGN.md` "Status dot (general)" 6px 패턴 재사용.

이 컴포넌트를 LiveStatusBar(종목명 앞)와 WatchlistDrawer(행 우측)가 공유한다.

### 3. `LiveStatusBar.tsx`

- **종목명 앞 점 추가**: `symbolLabel` span 앞에 `<CollectionDot status={deriveDisplayStatus(live, collectionStatus)} />`.
  연결(①)+수집(②)을 한 점으로 통합. realtime+연결정상=초록 점, polling=`◐ 준실시간`,
  realtime+WS끊김=`⚠ 재연결 중`.
- **제거**: 우측 `live ? 'LIVE●' : '재연결 중…'` 블록(L119-123)과 collection-status-badge 블록(L142-159).
- **비관심종목(member=false) CTA 정리**(L112-118): `과거 차트 · 실시간 ✕ … 눌러 실시간 추적`
  → `<CollectionDot status="polling" />` + `❤ 관심 추가 시 실시간` (하트 CTA는 유지, 액션 근접).
  member=false는 polling/uncollected 상태이므로 종목 앞 점이 이미 `◐ 준실시간`을 표현 → CTA는
  하트 유도 문구만 남긴다.
- **capture-health-pill(L125-141) → healthy면 점**: `captureHealthSeverity(healthy, reason)`이
  `ok`이고 `healthy===true`이면 텍스트 pill 대신 작은 초록 점(우측 위치 유지). 그 외(비정상 또는
  `closed`/`offline` 같은 healthy=false·severity=ok)는 기존 텍스트 pill 그대로. 좌측 점(종목 앞)과
  위치가 달라 구분된다. **`captureHealthPill.ts`(함수 3종)는 변경하지 않는다** — 호출부(LiveStatusBar)
  에서만 분기하므로 `captureHealthLabel`의 `healthy → 'LIVE●'` 경로는 미사용 dead path가 되나 함수
  계약·기존 테스트(`captureHealthPill.test.ts:7`)는 보존된다. 프로덕션 호출처는 LiveStatusBar 단일로
  grep 확인됨.
- **separator 위생**: 위 블록들을 제거/이동하면서 `·` 구분점이 고아로 남지 않게 한다 — 특히
  member=false 경로에서 `kis_live·10s · · 캡처`처럼 이중 구분점이 생기지 않도록 구분점 렌더를
  표시 요소 존재 여부에 묶는다.
- **유지**: `SourceChip`(③), 현재가, 등락률, timeframe, 하트버튼.

### 4. `LiveSidebar.tsx`

- `SidebarHeader`: `<span>LIVE</span>`(L219) → `<span>최신</span>`, `<span>과거 시점</span>`(L204)
  → `<span>과거</span>`. accent 펄스 점·우측 타임스탬프 위치 유지.
- **rest-notice 배너 제거**(L128-142, `showRestNotice` 블록): 비관심종목 안내는 LiveStatusBar CTA로
  일원화. `showRestNotice` 계산·관련 prop도 정리.

### 5. `WatchlistDrawer.tsx`

- 행 배지(L433-447) → `<CollectionDot status={deriveDisplayStatus(true, status)} />`. `live`를 넘기지
  않아(=connected 가정) `disconnected` 발생 불가 → 드로어 행 = collection-only invariant 보존.
  realtime=점만, polling=`◐ 준실시간`, waiting_eod=`저녁대기`, uncollected=null.
- 인라인 배지 JSX·`TODO(label)` 제거.

### 데이터 흐름 요약

```
useConnectionLiveness(WS) ─┐
                           ├─ deriveDisplayStatus(live, status) ─→ CollectionDot ─→ 종목 앞 점 (LiveStatusBar)
deriveCollectionStatus ────┘                                          │
                                          deriveDisplayStatus(true, status) ─→ CollectionDot ─→ 행 (WatchlistDrawer)

captureHealth(healthy,reason) ─→ severity ─→ (healthy&ok? 점 : 텍스트 pill) (LiveStatusBar 우측)
```

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| realtime + 연결정상 | `deriveDisplayStatus(true, 'realtime')` | `'realtime'` (점만) |
| realtime + WS끊김 | `deriveDisplayStatus(false, 'realtime')` | `'disconnected'` |
| polling + WS끊김 | `deriveDisplayStatus(false, 'polling')` | `'polling'` (REST 독립, 재연결 아님) |
| waiting_eod + WS끊김 | `deriveDisplayStatus(false, 'waiting_eod')` | `'waiting_eod'` |
| uncollected | `deriveDisplayStatus(true, 'uncollected')` | `'uncollected'` (렌더 null) |
| CollectionDot realtime | `<CollectionDot status="realtime" />` | 점만, label 텍스트 없음, `aria-label`="실시간 수집 중" |
| CollectionDot polling | `<CollectionDot status="polling" />` | 점 + "준실시간" 텍스트 |
| CollectionDot uncollected | `<CollectionDot status="uncollected" />` | `null`(미렌더) |
| captureHealthLabel 불변 | `captureHealthLabel(true, 'healthy')` | `'LIVE●'` 반환(계약 보존, `captureHealthPill.test.ts:7` 유지) — healthy 표시는 LiveStatusBar 호출부가 점으로 처리 |
| capture pill 비정상 | severity `warn`/`error` | 텍스트 pill 유지(`재연결 중…`/`구독 실패` 등) |

**Invariant 회귀 테스트**:
- *연결-검출 전송로 일치*: `deriveDisplayStatus(false, 'polling') === 'polling'` (위 표) — WS 끊김이
  REST 종목을 재연결로 오표시하지 않음을 고정.
- *드로어 행 = collection-only*: WatchlistDrawer 렌더 테스트에서 `live=false`(연결끊김) 주입해도
  realtime 행이 `disconnected`가 아닌 점만으로 표시됨을 검증(드로어는 `live` 미참조).
- *캡처 데몬 가시성*: `sub_failed`/`stale`/`closed` 각각에서 텍스트 pill이 표시됨을 검증.

### Manual verification

`/live` (dev 서버 = local main 화면)에서:
- 정상 장중: 종목 앞 초록 점 + 우측 캡처 초록 점, 텍스트 "실시간/LIVE" 0개.
- WS 강제 끊김(네트워크 차단): realtime 종목 → `⚠ 재연결 중`, 캡처 pill은 reason 따라.
- 비관심종목 클릭: `◐ 준실시간` + `❤ 관심 추가 시 실시간` CTA, **사이드바 배너 없음**.
- 차트 캔들 hover: 사이드바 `최신` → `과거` 전환, 타임스탬프 pin.
- 관심패널: realtime 행=점, 준실시간/저녁대기 행=텍스트.
- 헤드리스 검증 한계: crosshair hover는 `/browse`로 트리거 불가 → 커서모드 전환은 실 hover 사용자 검증.

## Risks / Open questions

- **점만 표시의 학습성**: 정상 종목이 점 하나뿐이라 신규 사용자가 의미를 모를 수 있음 → `title`+
  `aria-label`로 충분(단일 사용자 로컬 도구, 별도 범례는 YAGNI로 기각). 사용자 합의됨.
- **좌/우 두 점 공존**: 종목 앞 점(연결+수집)과 우측 캡처 점이 둘 다 초록일 때 의미 구분은 위치로만.
  사용자 선택(Q1 "정상이면 점만") — 합의됨.
- **capture severity `ok` & healthy=false 케이스**(`closed`/`offline`): healthy=false라 점이 아닌
  텍스트(`장 마감`/`오프라인`) 표시 — 의도된 동작(밤·주말 정상 상태도 사용자에게 명시).
- **예외 상태 '재연결 중' 이중 표시 여지**: WS 끊김 시 종목 앞 점(`disconnected → 재연결 중`)과 캡처
  pill(reason `reconnecting → 재연결 중…`)이 동시에 뜰 수 있다. 두 신호는 다른 구간을 가리킨다 —
  종목 앞 점 = 브라우저↔백엔드 WS, 캡처 pill = 백엔드↔KIS 수집. 다만 캡처 health 갱신도 같은 WS
  스트림으로 전달되므로 WS가 죽으면 pill이 stale로 멈춰 실제 동시발생은 드물 것으로 예상. "예외는
  시끄럽게" 원칙상 허용하되, 구현 시 manual로 동시표시 빈도·문구 중복 인상을 확인한다.

## Out of Scope (Backlog)

- 밀도 토글(Compact/Comfortable)에서의 점 크기 재보정.
- 캡처 pill과 종목 앞 점을 hover 툴팁으로 통합한 단일 상태 패널(공격적 통합 C안 — 이번엔 기각).
