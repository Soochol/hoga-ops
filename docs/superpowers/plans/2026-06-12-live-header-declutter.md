# /live 헤더 "실시간/LIVE" 디클러터 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** /live 화면에서 정상 상태일 때 "실시간/LIVE/live" 텍스트를 0개로 줄이고(연결+수집=점, 예외만 텍스트), 의미별 어휘를 분리하며, 수집상태 표시의 UI·코드 중복을 단일 컴포넌트로 통합한다.

**Architecture:** `deriveDisplayStatus(live, collectionStatus)` 순수함수가 표시상태를 도출(realtime일 때만 WS 연결 반영, REST 폴링은 독립)하고, `DISPLAY_PRESENTATION` 단일 매핑이 점/라벨/색/aria를 정의한다. 신규 `CollectionDot` 표현 컴포넌트가 LiveStatusBar(종목명 앞)와 WatchlistDrawer(행 우측)에서 공유되어 인라인 배지 중복 2곳을 제거한다. 캡처 데몬 pill은 함수 불변 + 호출부 분기(healthy면 점)로 정리한다.

**Tech Stack:** React + TypeScript, vitest 4 + @testing-library/react, Tailwind + CSS 변수 토큰(DESIGN.md). 권위 타입체크는 `tsc -p tsconfig.app.json`(메모리: root tsconfig는 인자 없이 아무것도 안 봄).

스펙: `docs/superpowers/specs/2026-06-12-live-header-declutter-design.md`

---

## File Structure

| 파일 | 역할 | 변경 |
|------|------|------|
| `frontend/src/live/collectionStatus.ts` | 수집/표시 상태 순수함수 + 표현 매핑 | Modify: `DisplayStatus`, `deriveDisplayStatus`, `DISPLAY_PRESENTATION` 추가 |
| `frontend/src/live/collectionStatus.test.ts` | 위 단위 테스트 | Modify: `deriveDisplayStatus` describe 추가 |
| `frontend/src/live/CollectionDot.tsx` | 점/점+라벨 표현 컴포넌트 (공유) | **Create** |
| `frontend/src/live/CollectionDot.test.tsx` | 위 render 테스트 | **Create** |
| `frontend/src/live/LiveStatusBar.tsx` | /live 상태바 | Modify: 종목 앞 점, LIVE● 제거, 캡처 점, CTA·separator 정리 |
| `frontend/src/live/LiveStatusBar.test.tsx` | 상태바 테스트 | Modify: 깨지는 단언을 점 기준으로 업데이트 |
| `frontend/src/live/LiveSidebar.tsx` | /live 사이드바 | Modify: `최신`/`과거` 카피, rest-notice 배너 제거 |
| `frontend/src/watchlist/WatchlistDrawer.tsx` | 관심종목 패널 | Modify: 행 배지 → `CollectionDot` |
| `frontend/src/watchlist/WatchlistDrawer.test.tsx` | 패널 테스트 | Modify(필요시): realtime=점 기준으로 업데이트 |

**불변(건드리지 않음):** `frontend/src/live/captureHealthPill.ts`(함수 3종), `captureHealthPill.test.ts`. 호출부(LiveStatusBar)만 분기하므로 `captureHealthLabel`의 `healthy → 'LIVE●'`는 dead path가 되나 계약·테스트는 보존된다(프로덕션 단일 호출처 grep 확인됨).

---

## Task 1: `deriveDisplayStatus` + `DISPLAY_PRESENTATION`

**Files:**
- Modify: `frontend/src/live/collectionStatus.ts`
- Test: `frontend/src/live/collectionStatus.test.ts`

- [ ] **Step 1: 실패하는 테스트 추가**

`collectionStatus.test.ts` 상단 import를 수정하고 파일 끝에 describe를 추가한다.

import 라인 교체:
```ts
import { deriveCollectionStatus, deriveDisplayStatus } from './collectionStatus';
```

파일 끝에 추가:
```ts
describe('deriveDisplayStatus', () => {
  it('realtime + 연결정상 → realtime (점만)', () => {
    expect(deriveDisplayStatus(true, 'realtime')).toBe('realtime');
  });
  it('realtime + WS끊김 → disconnected', () => {
    expect(deriveDisplayStatus(false, 'realtime')).toBe('disconnected');
  });
  it('polling은 연결과 무관 (REST 독립 전송로)', () => {
    expect(deriveDisplayStatus(false, 'polling')).toBe('polling');
    expect(deriveDisplayStatus(true, 'polling')).toBe('polling');
  });
  it('waiting_eod는 연결과 무관', () => {
    expect(deriveDisplayStatus(false, 'waiting_eod')).toBe('waiting_eod');
  });
  it('uncollected → uncollected', () => {
    expect(deriveDisplayStatus(true, 'uncollected')).toBe('uncollected');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run src/live/collectionStatus.test.ts`
Expected: FAIL — `deriveDisplayStatus is not a function` (또는 import 에러)

- [ ] **Step 3: 최소 구현 추가**

`collectionStatus.ts` 파일 끝에 추가(기존 `deriveCollectionStatus`·`CollectionStatus`는 그대로):
```ts
/** 표시상태 = collection 상태 + (realtime 한정) WS 연결.
 *  realtime 종목만 WS(live_set)에 의존하므로 !live → disconnected.
 *  polling(REST)·waiting_eod는 connection과 독립이라 그대로 통과(오표시 방지). */
export type DisplayStatus =
  | 'realtime' | 'polling' | 'waiting_eod' | 'disconnected' | 'uncollected';

export function deriveDisplayStatus(
  live: boolean,
  status: CollectionStatus,
): DisplayStatus {
  if (status === 'realtime' && !live) return 'disconnected';
  return status;
}

export interface DisplayPresentation {
  /** null이면 점만(정상). 문자열이면 점 + 라벨(예외). */
  label: string | null;
  colorVar: string;
  ariaLabel: string;
}

/** 점/라벨/색/aria 단일 출처. CollectionDot이 소비. */
export const DISPLAY_PRESENTATION: Record<DisplayStatus, DisplayPresentation> = {
  realtime:     { label: null,       colorVar: 'var(--success)',   ariaLabel: '실시간 수집 중' },
  polling:      { label: '준실시간',  colorVar: 'var(--fg-dimmer)', ariaLabel: '준실시간(REST) 표시' },
  waiting_eod:  { label: '저녁대기',  colorVar: 'var(--fg-dimmer)', ariaLabel: '관심종목 대기 중' },
  disconnected: { label: '재연결 중', colorVar: 'var(--warn)',      ariaLabel: '연결 재시도 중' },
  uncollected:  { label: null,       colorVar: 'var(--fg-dimmer)', ariaLabel: '' },
};
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run src/live/collectionStatus.test.ts`
Expected: PASS (deriveCollectionStatus 6 + deriveDisplayStatus 5 = 11 통과)

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/live/collectionStatus.ts frontend/src/live/collectionStatus.test.ts
git commit -F - <<'EOF'
feat: deriveDisplayStatus + DISPLAY_PRESENTATION 추가

연결+수집을 단일 표시상태로 도출(realtime일 때만 WS 연결 반영, REST 독립).
점/라벨/색/aria 단일 매핑.
EOF
```
> 주의: 메모리상 `&&`-체이닝/heredoc commit이 훅에 오탐 차단될 수 있다. 차단되면 메시지를 파일로 쓰고 단독 `git commit -F <파일>`로 우회.

---

## Task 2: `CollectionDot` 컴포넌트

**Files:**
- Create: `frontend/src/live/CollectionDot.tsx`
- Test: `frontend/src/live/CollectionDot.test.tsx`

- [ ] **Step 1: 실패하는 테스트 작성**

`CollectionDot.test.tsx` 생성:
```tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { CollectionDot } from './CollectionDot';

afterEach(cleanup);

describe('CollectionDot', () => {
  it('realtime: 점만 — 라벨 텍스트 없음, aria-label로 의미', () => {
    render(<CollectionDot status="realtime" />);
    const el = screen.getByTestId('collection-dot-realtime');
    expect(el.textContent).toBe('');
    expect(el.getAttribute('aria-label')).toBe('실시간 수집 중');
  });
  it('polling: 점 + "준실시간" 텍스트', () => {
    render(<CollectionDot status="polling" />);
    expect(screen.getByText('준실시간')).toBeTruthy();
  });
  it('disconnected: 점 + "재연결 중" 텍스트', () => {
    render(<CollectionDot status="disconnected" />);
    expect(screen.getByText('재연결 중')).toBeTruthy();
  });
  it('uncollected: 렌더 안 함(null)', () => {
    const { container } = render(<CollectionDot status="uncollected" />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run src/live/CollectionDot.test.tsx`
Expected: FAIL — `Cannot find module './CollectionDot'`

- [ ] **Step 3: 컴포넌트 구현**

`CollectionDot.tsx` 생성:
```tsx
import { DISPLAY_PRESENTATION, type DisplayStatus } from './collectionStatus';

interface Props {
  status: DisplayStatus;
}

/** 수집/연결 상태를 점(정상) 또는 점+라벨(예외)로 표현. uncollected는 미렌더.
 *  DISPLAY_PRESENTATION 단일 매핑을 LiveStatusBar(종목 앞)·WatchlistDrawer(행)가
 *  공유한다. 점만 표시되는 정상 상태도 aria-label/title로 의미를 전달(접근성). */
export function CollectionDot({ status }: Props) {
  if (status === 'uncollected') return null;
  const { label, colorVar, ariaLabel } = DISPLAY_PRESENTATION[status];
  return (
    <span
      data-testid={`collection-dot-${status}`}
      title={ariaLabel}
      aria-label={ariaLabel}
      className="inline-flex items-center gap-1 font-mono"
      style={{ color: colorVar, fontSize: 'var(--text-xs)' }}
    >
      <span
        aria-hidden
        className="inline-block rounded-full"
        style={{
          width: '6px',
          height: '6px',
          background: colorVar,
          boxShadow: status === 'realtime' ? `0 0 4px ${colorVar}` : undefined,
        }}
      />
      {label && <span>{label}</span>}
    </span>
  );
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run src/live/CollectionDot.test.tsx`
Expected: PASS (4 통과)

- [ ] **Step 5: 커밋**

메시지 파일 방식:
```bash
printf '%s\n' 'feat: CollectionDot — 수집/연결 상태 점+라벨 공유 컴포넌트' '' '정상=점만(aria-label), 예외=점+라벨. uncollected는 미렌더.' > /tmp/cd-msg.txt
git add frontend/src/live/CollectionDot.tsx frontend/src/live/CollectionDot.test.tsx
git commit -F /tmp/cd-msg.txt
```

---

## Task 3: `LiveStatusBar` 통합 (종목 앞 점 + LIVE● 제거 + 캡처 점 + CTA/separator 정리)

**Files:**
- Modify: `frontend/src/live/LiveStatusBar.tsx`
- Test: `frontend/src/live/LiveStatusBar.test.tsx`

- [ ] **Step 1: 기존 테스트 현황 확인(베이스라인)**

Run: `cd frontend && npx vitest run src/live/LiveStatusBar.test.tsx`
Expected: 현재 PASS. 어떤 단언이 `LIVE●`/`collection-status-badge`/`실시간`/`준실시간`을 참조하는지 출력에서 파악(Step 6에서 업데이트 대상).

- [ ] **Step 2: import 추가**

`LiveStatusBar.tsx` L15:
```ts
import { deriveCollectionStatus } from './collectionStatus';
```
교체:
```ts
import { deriveCollectionStatus, deriveDisplayStatus } from './collectionStatus';
import { CollectionDot } from './CollectionDot';
```

- [ ] **Step 3: 종목명 앞에 통합 점 추가**

L82-84 현재:
```tsx
      <span className="font-mono" style={{ color: 'var(--fg)' }}>
        {symbolLabel}
      </span>
```
교체:
```tsx
      <CollectionDot status={deriveDisplayStatus(live, collectionStatus)} />
      <span className="font-mono" style={{ color: 'var(--fg)' }}>
        {symbolLabel}
      </span>
```

- [ ] **Step 4: SourceChip 뒤 separator·member 분기·LIVE● 블록 정리**

L110-123 현재:
```tsx
      <SourceChip source={lastSegmentSource} />
      <span aria-hidden>·</span>
      {activeCode && !member ? (
        <span style={{ color: 'var(--fg-dimmer)' }}>
          과거 차트 · 실시간 ✕
          <span className="ml-2 inline-flex items-center gap-1" style={{ color: 'var(--accent)' }}>
            <HeartIcon filled={false} className="w-[1em] h-[1em]" /> 눌러 실시간 추적
          </span>
        </span>
      ) : (
        <span style={{ color: live ? 'var(--success)' : 'var(--warn)' }}>
          {live ? 'LIVE●' : '재연결 중…'}
        </span>
      )}
      <span aria-hidden>·</span>
```
교체(SourceChip 뒤 고아 `·` 제거, CTA는 `· CTA` 조건부, LIVE● else 삭제 — 연결+수집은 종목 앞 점이 표현):
```tsx
      <SourceChip source={lastSegmentSource} />
      {activeCode && !member && (
        <>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1" style={{ color: 'var(--accent)' }}>
            <HeartIcon filled={false} className="w-[1em] h-[1em]" /> 관심 추가 시 실시간
          </span>
        </>
      )}
      <span aria-hidden>·</span>
```

- [ ] **Step 5: 캡처 pill → healthy면 점**

L125-141 현재 IIFE 블록 전체:
```tsx
      {(() => {
        const sev = captureHealthSeverity(captureHealthy, captureReason);
        const capPill = captureHealthPillColor(sev);
        return (
          <span
            data-testid="capture-health-pill"
            title={`capture_reason = ${captureReason}`}
            className="font-mono px-2 py-0.5 rounded"
            style={{
              background: capPill.bg, border: `1px solid ${capPill.border}`,
              color: capPill.fg, fontSize: 'var(--text-xs)',
            }}
          >
            {captureHealthLabel(captureHealthy, captureReason)}
          </span>
        );
      })()}
```
교체(healthy+ok면 점, 그 외 기존 텍스트 pill 유지):
```tsx
      {(() => {
        const sev = captureHealthSeverity(captureHealthy, captureReason);
        if (captureHealthy && sev === 'ok') {
          return (
            <span
              data-testid="capture-health-dot"
              title={`capture_reason = ${captureReason}`}
              aria-label="캡처 정상"
              className="inline-block rounded-full"
              style={{
                width: '6px', height: '6px',
                background: 'var(--success)', boxShadow: '0 0 4px var(--success)',
              }}
            />
          );
        }
        const capPill = captureHealthPillColor(sev);
        return (
          <span
            data-testid="capture-health-pill"
            title={`capture_reason = ${captureReason}`}
            className="font-mono px-2 py-0.5 rounded"
            style={{
              background: capPill.bg, border: `1px solid ${capPill.border}`,
              color: capPill.fg, fontSize: 'var(--text-xs)',
            }}
          >
            {captureHealthLabel(captureHealthy, captureReason)}
          </span>
        );
      })()}
```

- [ ] **Step 6: collection-status-badge 블록 제거**

L142-159 현재 블록 전체(`{activeCode && (collectionStatus === 'realtime' || collectionStatus === 'polling') && (() => { ... '실시간' : '준실시간' ... })()}`)를 삭제한다. 이 정보는 Step 3의 종목 앞 점이 표현한다. (`collectionStatus` 변수는 Step 3에서 계속 사용되므로 그 선언 L48-53은 유지.)

- [ ] **Step 7: 기존 테스트 업데이트**

Step 1에서 파악한 깨지는 단언을 수정한다. 매핑 가이드:
- `getByText('LIVE●')` 또는 연결 pill 단언 → 정상이면 종목 앞 `getByTestId('collection-dot-realtime')`, WS끊김이면 `collection-dot-disconnected`로.
- `getByTestId('collection-status-badge')` + `실시간`/`준실시간` → `getByTestId('collection-dot-realtime' | 'collection-dot-polling')`로. realtime은 텍스트가 아니라 점이므로 `getByText('실시간')` 단언은 제거하고 testid 존재로 검증.
- capture 정상 단언이 `capture-health-pill`+`LIVE●` 텍스트였다면 → `getByTestId('capture-health-dot')`로. 비정상 케이스는 `capture-health-pill` 유지.

Run: `cd frontend && npx vitest run src/live/LiveStatusBar.test.tsx`
Expected: PASS (업데이트 후)

- [ ] **Step 8: 커밋**

```bash
printf '%s\n' 'feat: LiveStatusBar — 연결+수집을 종목 앞 점으로 통합, LIVE● 2개 제거' '' '종목명 앞 CollectionDot이 연결+수집 표현(정상=점). 우측 LIVE●(연결)와' '수집 배지 제거, 캡처 pill은 healthy면 점. 비관심 CTA·separator 정리.' > /tmp/lsb-msg.txt
git add frontend/src/live/LiveStatusBar.tsx frontend/src/live/LiveStatusBar.test.tsx
git commit -F /tmp/lsb-msg.txt
```

---

## Task 4: `LiveSidebar` — 카피 변경 + rest-notice 배너 제거

**Files:**
- Modify: `frontend/src/live/LiveSidebar.tsx`

- [ ] **Step 1: rest-notice 계산·import 제거**

L23 삭제:
```ts
import { useLiveStatus } from '../api/liveStatus';
```
L53-56 삭제:
```ts
  // ADR-0067: REST 준실시간 안내 — code가 live_set(WS 실시간 수집) 밖이면 안내 표시.
  const { data: liveStatusData } = useLiveStatus();
  const liveSet = liveStatusData?.live_set ?? [];
  const showRestNotice = !!code && !liveSet.includes(code);
```
> 확인: `liveSet`/`showRestNotice`는 이 파일에서 배너에만 쓰인다(grep으로 재확인). 다른 사용처가 있으면 그 줄만 남긴다.

- [ ] **Step 2: 배너 JSX 제거**

L128-142 현재:
```tsx
      {showRestNotice && (
        // TODO(label): 안내 문구 확정
        <div
          data-testid="live-sidebar-rest-notice"
          style={{
            padding: 'var(--space-xs) var(--space-md)',
            fontSize: 'var(--text-xs)',
            color: 'var(--fg-dimmer)',
            borderBottom: '1px solid var(--border)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          관심종목 밖 · 준실시간(REST) 표시 · 관심종목에 추가하면 실시간
        </div>
      )}
```
→ 블록 전체 삭제(비관심 안내는 LiveStatusBar CTA로 일원화).

- [ ] **Step 3: SidebarHeader 카피 변경**

L204 현재 `<span>과거 시점</span>` → `<span>과거</span>`
L219 현재 `<span>LIVE</span>` → `<span>최신</span>`
(accent 펄스 점 L207-218, 우측 타임스탬프 L223-225는 유지.)

- [ ] **Step 4: 타입체크 + 관련 테스트**

Run: `cd frontend && npx tsc -p tsconfig.app.json --noEmit`
Expected: 에러 없음(미사용 import/변수 제거 확인).
Run: `cd frontend && npx vitest run src/live/LiveSidebar.test.tsx` (존재 시)
Expected: PASS. `live-sidebar-rest-notice`/`과거 시점`/`LIVE` 텍스트 단언이 있으면 `과거`/`최신`/배너제거 기준으로 업데이트.

- [ ] **Step 5: 커밋**

```bash
printf '%s\n' 'feat: LiveSidebar — LIVE→최신/과거 시점→과거, rest-notice 배너 제거' '' '차트 커서모드 어휘를 최신/과거로 분리(LIVE 영문 제거). 비관심 REST 안내' '배너는 LiveStatusBar CTA와 중복이라 제거.' > /tmp/lsbar-msg.txt
git add frontend/src/live/LiveSidebar.tsx
# (테스트 수정했다면) git add frontend/src/live/LiveSidebar.test.tsx
git commit -F /tmp/lsbar-msg.txt
```

---

## Task 5: `WatchlistDrawer` 행 배지 → `CollectionDot`

**Files:**
- Modify: `frontend/src/watchlist/WatchlistDrawer.tsx`
- Test: `frontend/src/watchlist/WatchlistDrawer.test.tsx`

- [ ] **Step 1: 기존 테스트 베이스라인**

Run: `cd frontend && npx vitest run src/watchlist/WatchlistDrawer.test.tsx`
Expected: 현재 PASS. `실시간`/`준실시간`/`저녁대기` 텍스트 단언 위치 파악.

- [ ] **Step 2: import 추가**

`WatchlistDrawer.tsx`에서 `deriveCollectionStatus`를 import하는 줄(`from '../live/collectionStatus'`)에 `deriveDisplayStatus`를 추가하고, `CollectionDot` import를 추가:
```ts
import { deriveCollectionStatus, deriveDisplayStatus } from '../live/collectionStatus';
import { CollectionDot } from '../live/CollectionDot';
```

- [ ] **Step 3: 인라인 배지 → CollectionDot**

L432-447 현재:
```tsx
                      const status = deriveCollectionStatus(entry.code, liveSet, codes, viewedCodes);
                      const badge = status === 'uncollected' ? null : (
                        <span
                          className="font-mono px-1.5 py-0.5 rounded"
                          style={{
                            background: status === 'realtime' ? 'var(--tint-success)' : 'transparent',
                            border: `1px solid ${status === 'realtime' ? 'var(--tint-success-border)' : 'var(--border)'}`,
                            color: status === 'realtime' ? 'var(--success)' : 'var(--fg-dimmer)',
                            fontSize: 'var(--text-xs)',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {/* TODO(label): 배지 문구 확정 */}
                          {status === 'realtime' ? '실시간' : status === 'polling' ? '준실시간' : '저녁대기'}
                        </span>
                      );
```
교체(드로어 행은 connection 미참조 → `deriveDisplayStatus(true, status)`로 disconnected 발생 불가, collection-only invariant 보존):
```tsx
                      const status = deriveCollectionStatus(entry.code, liveSet, codes, viewedCodes);
                      const badge = <CollectionDot status={deriveDisplayStatus(true, status)} />;
```

- [ ] **Step 4: 타입체크 + 테스트 업데이트**

Run: `cd frontend && npx tsc -p tsconfig.app.json --noEmit`
Expected: 에러 없음.

Step 1에서 파악한 단언 업데이트:
- `getByText('실시간')`(realtime 행) → realtime은 점만이라 텍스트 없음. `getByTestId('collection-dot-realtime')`로.
- `getByText('준실시간')`/`getByText('저녁대기')` → 그대로 유지(점+라벨이라 텍스트 존재). 필요시 `collection-dot-polling`/`collection-dot-waiting_eod` testid 병행.

Run: `cd frontend && npx vitest run src/watchlist/WatchlistDrawer.test.tsx`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
printf '%s\n' 'feat: WatchlistDrawer 행 배지를 CollectionDot으로 통합' '' '인라인 배지 제거(TODO(label) 해소). realtime=점만, 예외만 텍스트.' 'connection 미참조 유지(collection-only).' > /tmp/wd-msg.txt
git add frontend/src/watchlist/WatchlistDrawer.tsx frontend/src/watchlist/WatchlistDrawer.test.tsx
git commit -F /tmp/wd-msg.txt
```

---

## Task 6: 통합 검증

**Files:** 없음(검증만)

- [ ] **Step 1: 전체 타입체크**

Run: `cd frontend && npx tsc -p tsconfig.app.json --noEmit`
Expected: 에러 0.

- [ ] **Step 2: 전체 단위 테스트**

Run: `cd frontend && npx vitest run`
Expected: 전체 PASS. 특히 `captureHealthPill.test.ts`(함수 불변이라 그대로 통과), `collectionStatus`, `CollectionDot`, `LiveStatusBar`, `WatchlistDrawer`.

- [ ] **Step 3: 프로덕션 빌드**

Run: `cd frontend && npm run build`
Expected: 성공(메모리: `npm run build`가 그린이어야 함).

- [ ] **Step 4: dev 서버 manual 검증**

백엔드+프론트 dev 서버 기동(CLAUDE.md 참조) 후 `/browse`로:
```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/live
$B text          # "LIVE●"/"실시간"/"준실시간" 텍스트가 정상 상태에서 안 보이는지
$B console --errors
$B snapshot -i
```
확인 시나리오(스펙 Testing §):
- 정상 장중: 종목 앞 초록 점 + 우측 캡처 초록 점, "LIVE●/실시간" 텍스트 0개.
- 비관심종목 클릭: `◐ 준실시간` + `❤ 관심 추가 시 실시간` CTA, **사이드바 배너 없음**.
- 관심패널: realtime 행=점, 준실시간/저녁대기=텍스트.
- 차트 hover(실 사용자): 사이드바 `최신`↔`과거` 전환. (헤드리스 crosshair 트리거 불가 — 메모리)
- separator: `kis_live·10s · ·` 이중 구분점 없음.

- [ ] **Step 5: 최종 점검 커밋(필요시)**

manual에서 미세 조정이 있으면 수정 후 커밋. 없으면 스킵.

---

## Self-Review

**1. Spec coverage** (스펙 각 요구 → 태스크):
- 연결+수집 종목 앞 점 통합 → Task 3 Step 3 ✓
- LIVE●(연결) 제거 → Task 3 Step 4 ✓
- 캡처 pill healthy=점(함수 불변) → Task 3 Step 5 ✓
- 수집 배지 제거 → Task 3 Step 6 ✓
- `deriveDisplayStatus` realtime-only → Task 1 ✓
- `CollectionDot` 공유 → Task 2, 사용 Task 3·5 ✓
- 차트 커서모드 최신/과거 → Task 4 Step 3 ✓
- rest-notice 배너 제거 → Task 4 Step 1-2 ✓
- 드로어 행 collection-only + CollectionDot → Task 5 ✓
- separator 위생 → Task 3 Step 4 ✓
- 색 3분리(새 색 0) → 모든 태스크 토큰 재사용 ✓
- invariant 회귀(전송로 일치·collection-only·캡처 가시성) → Task 1(polling 독립), Task 5(true 고정), Task 6 Step 2(captureHealthPill 통과) ✓

**2. Placeholder scan:** 모든 코드 스텝에 실제 코드 포함. "TODO(label)" 언급은 *기존 코드 제거 대상*으로만 등장(신규 placeholder 아님). ✓

**3. Type consistency:** `DisplayStatus`·`deriveDisplayStatus`·`DISPLAY_PRESENTATION`·`CollectionDot`·`collection-dot-${status}`·`capture-health-dot` 명칭이 Task 1→2→3→5에서 일관. `deriveDisplayStatus(live, status)` 시그니처가 Task 3(`live, collectionStatus`)·Task 5(`true, status`)에서 동일. ✓

## Risks (구현 중 주의)
- Task 3/5의 기존 `.test.tsx`가 어떤 단언을 쓰는지는 **베이스라인 실행(Step 1)으로 먼저 확인** — 추측 금지.
- `deriveDisplayStatus(true, status)`는 `status`가 이미 `CollectionStatus`라 타입 호환(서브셋). tsc로 확인.
- 캡처 점과 종목 앞 점이 둘 다 초록일 때 위치로만 구분 — 사용자 승인된 동작(Q1).
