# 스크리너 전역 사전필터 → 센터 모달 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/screener` 빌더 카드 하단에 인라인으로 박힌 전역 사전필터(시장·ETF제외·거래정지제외)를 헤더 버튼이 여는 센터 모달(좌측 nav 2그룹: 시장 / 제외)로 옮겨 빌더 카드를 정리한다.

**Architecture:** 순수 프론트엔드 표면 재배치. 새 컴포넌트 2개(`UniverseFilterButton` 트리거+배지, `UniverseFilterModal` ModalShell 기반 2-group 모달) + 순수 헬퍼 1개(`universeFilter.ts`). `ConditionBuilder`는 인라인 섹션을 제거하고 헤더에 버튼만 단다. 토글은 **즉시 적용**(`onUniverseChange` 동기 호출), 저장·백엔드·`ScreenerUniverse` 모델·우측 레일은 무변경. 모든 universe 편집은 기존 `editUniverse`→anchor dirty 경로를 그대로 탄다.

**Tech Stack:** React + TypeScript, Tailwind(디자인 토큰 `tokens.css`), Vitest + @testing-library/react, 기존 `ModalShell`(`src/ui/ModalShell.tsx`) 재사용.

**Spec:** `docs/superpowers/specs/2026-06-02-screener-prefilter-modal-design.md`
**Domain:** CONTEXT.md "전역 사전필터" 항목 — 두 하위 축(시장 선택 / 종목 제외), 시장(KOSPI/KOSDAQ) ≠ 지수(KOSPI200/KRX300, backlog).

---

## File Structure

| 파일 | 책임 |
|---|---|
| `frontend/src/screener/universeFilter.ts` (생성) | 순수 헬퍼 — `countActiveUniverse`(배지 카운트), `universeSummary`(aria-label 열거) |
| `frontend/src/screener/UniverseFilterModal.tsx` (생성) | ModalShell 기반 모달 — 좌측 nav 2그룹(시장/제외) + pane 전환 + 즉시-적용 컨트롤 |
| `frontend/src/screener/UniverseFilterButton.tsx` (생성) | 헤더 트리거 버튼 — 배지/accent 테두리/aria-label + open 상태 + 모달 렌더 |
| `frontend/src/screener/ConditionBuilder.tsx` (수정) | 헤더 2버튼 행으로, 하단 인라인 사전필터 섹션·`MARKETS`·`toggleMarket` 제거 |
| `frontend/src/pages/Screener.test.tsx` (수정) | 사전필터 편집 테스트 2건을 "모달 열기→제외 그룹→토글"로 마이그레이션 |
| `frontend/src/screener/ConditionBuilder.test.tsx` (수정) | 컴패니언 유닛 테스트 — 인라인 시장 토글 테스트 → 모달 위임 검증으로 교체 |
| `frontend/src/screener/universeFilter.test.ts` (생성) | 헬퍼 유닛 테스트 |
| `frontend/src/screener/UniverseFilterModal.test.tsx` (생성) | 모달 유닛 테스트 |
| `frontend/src/screener/UniverseFilterButton.test.tsx` (생성) | 버튼 유닛 테스트 |

**작업 디렉토리:** 모든 `npx` 명령은 `frontend/`에서 실행. 경로는 repo 루트 기준 표기.

---

## Task 1: universeFilter 헬퍼 (배지 카운트 + aria 요약)

**Files:**
- Create: `frontend/src/screener/universeFilter.ts`
- Test: `frontend/src/screener/universeFilter.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/src/screener/universeFilter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { countActiveUniverse, universeSummary } from './universeFilter';

describe('countActiveUniverse', () => {
  it('빈 universe → 0', () => expect(countActiveUniverse({})).toBe(0));
  it('활성 축마다 +1', () =>
    expect(countActiveUniverse({ markets: ['KOSPI'], exclude_etf: true })).toBe(2));
  it('시장 양쪽 선택도 1로 센다 (단순 규칙)', () =>
    expect(countActiveUniverse({ markets: ['KOSPI', 'KOSDAQ'] })).toBe(1));
  it('세 축 모두 → 3', () =>
    expect(countActiveUniverse({ markets: ['KOSPI'], exclude_etf: true, exclude_halted: true })).toBe(3));
});

describe('universeSummary', () => {
  it('빈 universe → ""', () => expect(universeSummary({})).toBe(''));
  it('활성 항목을 읽기 순서로 나열', () =>
    expect(universeSummary({ markets: ['KOSPI'], exclude_etf: true })).toBe('KOSPI · ETF 제외'));
  it('복수 시장은 · 로 결합', () =>
    expect(universeSummary({ markets: ['KOSPI', 'KOSDAQ'], exclude_halted: true })).toBe('KOSPI·KOSDAQ · 거래정지 제외'));
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/screener/universeFilter.test.ts`
Expected: FAIL — "Failed to resolve import './universeFilter'" / module not found.

- [ ] **Step 3: 최소 구현 작성**

`frontend/src/screener/universeFilter.ts`:

```ts
import type { ScreenerUniverse } from '../api/screener';

// 트리거 버튼 배지 카운트 — 활성 "축" 개수(0~3). 시장은 단일 축으로 취급
// (KOSPI/KOSDAQ 둘 다 선택해도 1; 실질 제한 없음이지만 사용자가 명시 토글했으니
// 활성으로 표시 — spec §배지 카운트 승인된 단순 규칙).
export function countActiveUniverse(u: ScreenerUniverse): number {
  return (u.markets?.length ? 1 : 0) + (u.exclude_etf ? 1 : 0) + (u.exclude_halted ? 1 : 0);
}

// aria-label/title 보조 — 닫힌 모달의 활성 상태를 풀어 표기(spec 그릴 #2).
// 읽기 순서: 시장 → ETF 제외 → 거래정지 제외.
export function universeSummary(u: ScreenerUniverse): string {
  const parts: string[] = [];
  if (u.markets?.length) parts.push(u.markets.join('·'));
  if (u.exclude_etf) parts.push('ETF 제외');
  if (u.exclude_halted) parts.push('거래정지 제외');
  return parts.join(' · ');
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/screener/universeFilter.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/screener/universeFilter.ts frontend/src/screener/universeFilter.test.ts
git commit -m "feat(screener-fe): universeFilter 헬퍼 (배지 카운트 + aria 요약)"
```

---

## Task 2: UniverseFilterModal (ModalShell 2-group)

**Files:**
- Create: `frontend/src/screener/UniverseFilterModal.tsx`
- Test: `frontend/src/screener/UniverseFilterModal.test.tsx`
- 참고: `frontend/src/screener/ConfirmModal.tsx`(ModalShell 소비 본보기), `frontend/src/live/indicators/IndicatorPanel.tsx`(좌측 nav + CheckIcon), `frontend/src/screener/paramForms.tsx`(`SectionLabel`)

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/src/screener/UniverseFilterModal.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ScreenerUniverse } from '../api/screener';
import { UniverseFilterModal } from './UniverseFilterModal';

const mount = (universe: ScreenerUniverse = {}) => {
  const onChange = vi.fn();
  const onClose = vi.fn();
  render(<UniverseFilterModal universe={universe} onChange={onChange} onClose={onClose} />);
  return { onChange, onClose };
};

describe('UniverseFilterModal', () => {
  it('기본은 시장 그룹 — KOSPI/KOSDAQ 보이고 제외 체크박스는 안 보임', () => {
    mount();
    expect(screen.getByRole('dialog', { name: '사전필터' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'KOSPI' })).toBeInTheDocument();
    expect(screen.queryByLabelText('ETF 제외')).not.toBeInTheDocument();
  });

  it('제외 그룹으로 pane 전환', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: '제외' }));
    expect(screen.getByLabelText('ETF 제외')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'KOSPI' })).not.toBeInTheDocument();
  });

  it('ETF 제외 토글 → onChange 즉시 호출', () => {
    const { onChange } = mount({});
    fireEvent.click(screen.getByRole('button', { name: '제외' }));
    fireEvent.click(screen.getByLabelText('ETF 제외'));
    expect(onChange).toHaveBeenCalledWith({ exclude_etf: true });
  });

  it('시장 토글 → onChange 에 markets 갱신', () => {
    const { onChange } = mount({});
    fireEvent.click(screen.getByRole('button', { name: 'KOSDAQ' }));
    expect(onChange).toHaveBeenCalledWith({ markets: ['KOSDAQ'] });
  });

  it('닫기 클릭 → onClose', () => {
    const { onClose } = mount();
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('제외 활성이면 제외 nav 행이 data-active=true', () => {
    mount({ exclude_halted: true });
    expect(screen.getByRole('button', { name: '제외' })).toHaveAttribute('data-active', 'true');
    expect(screen.getByRole('button', { name: '시장' })).toHaveAttribute('data-active', 'false');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/screener/UniverseFilterModal.test.tsx`
Expected: FAIL — module not found `./UniverseFilterModal`.

- [ ] **Step 3: 최소 구현 작성**

`frontend/src/screener/UniverseFilterModal.tsx`:

```tsx
import { useState } from 'react';
import type { ScreenerUniverse } from '../api/screener';
import { ModalShell } from '../ui/ModalShell';
import { SectionLabel } from './paramForms';

const MARKETS = ['KOSPI', 'KOSDAQ'] as const;
type Group = 'market' | 'exclude';

// 활성=accent 채운 원+체크, 비활성=hollow ring (IndicatorPanel CheckIcon 모양 복제).
function NavCheck({ active }: { active: boolean }) {
  return active ? (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="var(--accent)" />
      <path d="M7.5 12.5l3 3 6-6" stroke="var(--accent-fg)" strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="none" stroke="var(--fg-dimmer)" strokeWidth="1.5" />
    </svg>
  );
}

// 전역 사전필터 편집 모달. 좌측 nav 2그룹(시장/제외) + 우측 pane 전환.
// 토글은 즉시 onChange 호출(초안 버퍼 없음); 닫기/Esc/배경은 순수 dismiss.
export function UniverseFilterModal({ universe, onChange, onClose }: {
  universe: ScreenerUniverse;
  onChange: (u: ScreenerUniverse) => void;
  onClose: () => void;
}) {
  const [group, setGroup] = useState<Group>('market');
  const markets = universe.markets ?? [];
  const toggleMarket = (m: (typeof MARKETS)[number]) => {
    const next = markets.includes(m) ? markets.filter((x) => x !== m) : [...markets, m];
    onChange({ ...universe, markets: next.length ? next : undefined });
  };
  const NAV: { id: Group; label: string; active: boolean }[] = [
    { id: 'market', label: '시장', active: !!universe.markets?.length },
    { id: 'exclude', label: '제외', active: !!(universe.exclude_etf || universe.exclude_halted) },
  ];

  return (
    <ModalShell ariaLabel="사전필터" title="사전필터" width="w-[480px]" onClose={onClose}>
      <div className="flex">
        <nav className="w-[160px] py-2 border-r border-border" aria-label="필터 그룹">
          <div className="text-fg-dimmer text-xs uppercase tracking-wider px-4 pb-2">필터 그룹</div>
          {NAV.map((n) => (
            <button key={n.id} type="button" aria-current={group === n.id} data-active={n.active}
              onClick={() => setGroup(n.id)}
              className={`flex w-full items-center justify-between px-4 py-2 text-sm ${
                group === n.id ? 'bg-bg-input text-fg' : 'text-fg-dim hover:bg-bg-input'}`}>
              <span>{n.label}</span>
              <NavCheck active={n.active} />
            </button>
          ))}
        </nav>

        <div className="flex-1 px-5 py-4">
          {group === 'market' ? (
            <div className="flex flex-col gap-sm">
              <SectionLabel>시장</SectionLabel>
              <div className="flex gap-px p-[2px] bg-bg-input rounded-md w-fit">
                {MARKETS.map((m) => {
                  const active = markets.includes(m);
                  return (
                    <button key={m} type="button" aria-label={m} aria-pressed={active}
                      onClick={() => toggleMarket(m)}
                      className={`px-2.5 py-[0.15rem] rounded-sm font-mono text-xs transition-colors ${
                        active ? 'bg-accent text-accent-fg' : 'text-fg-dim hover:bg-bg-input-hover'}`}>
                      {m}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-sm">
              <label className="flex items-center gap-2 text-sm text-fg cursor-pointer select-none">
                <input type="checkbox" checked={!!universe.exclude_etf}
                  onChange={(e) => onChange({ ...universe, exclude_etf: e.target.checked || undefined })}
                  className="accent-[var(--accent)]" />ETF 제외</label>
              <label className="flex items-center gap-2 text-sm text-fg cursor-pointer select-none">
                <input type="checkbox" checked={!!universe.exclude_halted}
                  onChange={(e) => onChange({ ...universe, exclude_halted: e.target.checked || undefined })}
                  className="accent-[var(--accent)]" />거래정지 제외</label>
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-end px-4 py-3 border-t border-border">
        <button type="button" onClick={onClose}
          className="px-3 py-1.5 text-sm bg-bg-input hover:bg-bg-input-hover text-fg rounded">닫기</button>
      </div>
    </ModalShell>
  );
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/screener/UniverseFilterModal.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/screener/UniverseFilterModal.tsx frontend/src/screener/UniverseFilterModal.test.tsx
git commit -m "feat(screener-fe): UniverseFilterModal — ModalShell 2-group(시장/제외)"
```

---

## Task 3: UniverseFilterButton (트리거 + 배지)

**Files:**
- Create: `frontend/src/screener/UniverseFilterButton.tsx`
- Test: `frontend/src/screener/UniverseFilterButton.test.tsx`

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/src/screener/UniverseFilterButton.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ScreenerUniverse } from '../api/screener';
import { UniverseFilterButton } from './UniverseFilterButton';

const mount = (universe: ScreenerUniverse = {}) => {
  const onChange = vi.fn();
  render(<UniverseFilterButton universe={universe} onChange={onChange} />);
  return { onChange };
};

describe('UniverseFilterButton', () => {
  it('활성 없음 — 배지 없이 라벨만, aria-expanded=false', () => {
    mount({});
    const btn = screen.getByRole('button', { name: '사전필터' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn.textContent).not.toMatch(/\d/);
  });

  it('활성 — 카운트 배지 + 열거형 aria-label', () => {
    mount({ markets: ['KOSPI'], exclude_etf: true });
    const btn = screen.getByRole('button', { name: '사전필터, 2개: KOSPI · ETF 제외' });
    expect(btn.textContent).toContain('2');
  });

  it('클릭 시 모달 열림, 닫기 시 닫힘', () => {
    mount({});
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '사전필터' }));
    expect(screen.getByRole('dialog', { name: '사전필터' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/screener/UniverseFilterButton.test.tsx`
Expected: FAIL — module not found `./UniverseFilterButton`.

- [ ] **Step 3: 최소 구현 작성**

`frontend/src/screener/UniverseFilterButton.tsx`:

```tsx
import { useState } from 'react';
import type { ScreenerUniverse } from '../api/screener';
import { countActiveUniverse, universeSummary } from './universeFilter';
import { UniverseFilterModal } from './UniverseFilterModal';

// 깔때기 글리프 — 이모지 금지(LiveToolbar 보조지표 버튼과 같은 인라인 SVG 관습).
function FunnelIcon() {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4h18l-7 8v6l-4 2v-8z" />
    </svg>
  );
}

// 빌더 헤더의 전역 사전필터 트리거. 활성 개수 배지 + accent 테두리 + 열거형
// aria-label(닫힌 모달 상태 가시성). 클릭 시 UniverseFilterModal 렌더.
export function UniverseFilterButton({ universe, onChange }: {
  universe: ScreenerUniverse;
  onChange: (u: ScreenerUniverse) => void;
}) {
  const [open, setOpen] = useState(false);
  const count = countActiveUniverse(universe);
  const label = count > 0 ? `사전필터, ${count}개: ${universeSummary(universe)}` : '사전필터';

  return (
    <>
      <button type="button" aria-haspopup="dialog" aria-expanded={open}
        aria-label={label} title={label} onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-1.5 px-3 rounded-md text-sm bg-bg-input border hover:bg-bg-input-hover ${
          count > 0 ? 'border-accent text-fg' : 'border-border-strong text-fg-dim'}`}>
        <FunnelIcon />
        <span>사전필터</span>
        {count > 0 && (
          <span className="inline-flex items-center justify-center min-w-[1.05rem] h-[1.05rem] px-1 rounded-full bg-accent text-accent-fg text-[0.6rem] font-bold leading-none">
            {count}
          </span>
        )}
      </button>
      {open && <UniverseFilterModal universe={universe} onChange={onChange} onClose={() => setOpen(false)} />}
    </>
  );
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/screener/UniverseFilterButton.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/screener/UniverseFilterButton.tsx frontend/src/screener/UniverseFilterButton.test.tsx
git commit -m "feat(screener-fe): UniverseFilterButton — 트리거 버튼 + 카운트 배지"
```

---

## Task 4: ConditionBuilder 배선 + Screener.test 마이그레이션

**Files:**
- Modify: `frontend/src/screener/ConditionBuilder.tsx` (전체 교체 — 인라인 섹션·`MARKETS`·`toggleMarket`·`SectionLabel` import 제거, 헤더에 버튼)
- Modify: `frontend/src/pages/Screener.test.tsx:73-83`, `:85-106` (사전필터 편집 2건)
- Modify: `frontend/src/screener/ConditionBuilder.test.tsx` (`toggles a market pre-filter` → 모달 위임 검증으로 교체 — 인라인 KOSPI 버튼이 모달로 이동해 깨짐)

- [ ] **Step 1: 마이그레이션 테스트 먼저 수정 (이 시점엔 빨강)**

`frontend/src/pages/Screener.test.tsx` — **테스트 1** (현재 L73-83). 아래 블록을 통째로 교체:

기존:
```tsx
  fireEvent.click(await screen.findByText('급등주'));        // load → anchored, clean
  expect(screen.queryByText('수정됨')).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('ETF 제외'));         // edit a global pre-filter
  expect(await screen.findByText('수정됨')).toBeInTheDocument();
```
교체:
```tsx
  fireEvent.click(await screen.findByText('급등주'));        // load → anchored, clean
  expect(screen.queryByText('수정됨')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /사전필터/ }));  // 모달 열기
  fireEvent.click(screen.getByRole('button', { name: '제외' }));      // 제외 그룹 pane
  fireEvent.click(screen.getByLabelText('ETF 제외'));                 // edit a global pre-filter
  expect(await screen.findByText('수정됨')).toBeInTheDocument();
```

`frontend/src/pages/Screener.test.tsx` — **테스트 2** (현재 L85-106). 두 곳 수정:

(a) "페이지 로드" await 교체 —
기존:
```tsx
  renderPage();
  await screen.findByLabelText('ETF 제외');
  fireEvent.click(screen.getByRole('button', { name: '새 조건검색' }));  // open inline editor
```
교체:
```tsx
  renderPage();
  await screen.findByText('조회');                                      // 페이지 렌더 대기(항상 존재)
  fireEvent.click(screen.getByRole('button', { name: '새 조건검색' }));  // open inline editor
```

(b) in-flight 편집 단계 — 모달 열기 + 제외 그룹 추가 —
기존:
```tsx
  fireEvent.click(screen.getByLabelText('ETF 제외'));                   // edit DURING the in-flight create (bumps gen)
```
교체:
```tsx
  fireEvent.click(screen.getByRole('button', { name: /사전필터/ }));    // 모달 열기 (create in-flight 중)
  fireEvent.click(screen.getByRole('button', { name: '제외' }));        // 제외 그룹 pane
  fireEvent.click(screen.getByLabelText('ETF 제외'));                   // edit DURING the in-flight create (bumps gen)
```

- [ ] **Step 2: 테스트 실패 확인 (UI 아직 인라인 → 모달 버튼 없음)**

Run: `npx vitest run src/pages/Screener.test.tsx`
Expected: FAIL — `getByRole('button', { name: /사전필터/ })` 찾지 못함(아직 인라인 섹션).

- [ ] **Step 3: ConditionBuilder 전체 교체**

`frontend/src/screener/ConditionBuilder.tsx` (파일 전체를 아래로 교체):

```tsx
import { useRef, useState } from 'react';
import type { ConditionLeaf, ConditionType, ScreenerUniverse } from '../api/screener';
import { CONDITION_CATALOG, CONDITION_ORDER, makeLeaf } from './catalog';
import { ConditionRow } from './ConditionRow';
import { UniverseFilterButton } from './UniverseFilterButton';
import { useDismissablePopover } from '../util/useDismissablePopover';

export function ConditionBuilder({ conditions, universe, onConditionsChange, onUniverseChange }: {
  conditions: ConditionLeaf[]; universe: ScreenerUniverse;
  onConditionsChange: (c: ConditionLeaf[]) => void; onUniverseChange: (u: ScreenerUniverse) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // Outside-mousedown / Escape dismissal for the add-condition menu only.
  useDismissablePopover(menuOpen, wrapRef, () => setMenuOpen(false));

  const toggleMenu = () => {
    const next = !menuOpen;
    if (next && btnRef.current) setAnchorRect(btnRef.current.getBoundingClientRect());
    setMenuOpen(next);
  };
  const add = (t: ConditionType) => { onConditionsChange([...conditions, makeLeaf(t)]); setMenuOpen(false); };
  const replace = (id: string, next: ConditionLeaf) => onConditionsChange(conditions.map((c) => c.id === id ? next : c));
  const remove = (id: string) => onConditionsChange(conditions.filter((c) => c.id !== id));

  return (
    <div className="bg-bg-card border rounded-lg p-md flex flex-col gap-sm min-h-0 overflow-auto">
      {/* Header: [조건 추가 (flex-1)] [사전필터 버튼]. 전역 사전필터는 버튼이 여는
          UniverseFilterModal 로 이동(빌더 카드 정리). */}
      <div className="flex gap-sm items-stretch">
        <div ref={wrapRef} className="relative flex-1">
          <button ref={btnRef} type="button" aria-label="조건 추가" aria-expanded={menuOpen} onClick={toggleMenu}
            className="w-full border border-dashed border-border-strong rounded-md text-fg-dim text-sm py-2 hover:bg-bg-input-hover">
            ＋ 조건 추가 ▾
          </button>
          {menuOpen && anchorRect && (
            <ul role="menu"
              className="bg-bg-card border border-border-strong rounded-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.4)] overflow-hidden z-50"
              style={{ position: 'fixed', top: anchorRect.bottom + 4, left: anchorRect.left, width: anchorRect.width }}>
              {CONDITION_ORDER.map((t) => (
                <li key={t}><button type="button" role="menuitem" aria-label={CONDITION_CATALOG[t].label} onClick={() => add(t)}
                  className="w-full text-left px-3 py-2 text-sm text-fg hover:bg-bg-input-hover">{CONDITION_CATALOG[t].label}</button></li>
              ))}
            </ul>
          )}
        </div>
        <UniverseFilterButton universe={universe} onChange={onUniverseChange} />
      </div>

      {conditions.length > 0 && (
        <div className="text-[10px] tracking-[0.06em] text-fg-dimmer text-center">모두 충족 · AND</div>
      )}
      {conditions.map((leaf) => (
        <ConditionRow key={leaf.id} leaf={leaf} onChange={(n) => replace(leaf.id, n)} onRemove={() => remove(leaf.id)} />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Screener.test 통과 확인**

Run: `npx vitest run src/pages/Screener.test.tsx`
Expected: PASS (7 tests — 마이그레이션 2건 포함 전부 초록). (이 파일은 7개 테스트다.)

- [ ] **Step 4b: 컴패니언 유닛 테스트 마이그레이션 (`ConditionBuilder.test.tsx`)**

`frontend/src/screener/ConditionBuilder.test.tsx`의 `toggles a market pre-filter`는 인라인 KOSPI 버튼을 클릭하던 테스트라 인라인 섹션 제거로 깨진다. 모달 위임 검증으로 교체(같은 `onUniverseChange({ markets: ['KOSPI'] })` 단언 유지, 모달 경로로 라우팅):

```tsx
  it('delegates universe editing to the 사전필터 modal (header button → modal → onUniverseChange)', () => {
    const onUniverse = vi.fn();
    render(<ConditionBuilder {...base} onConditionsChange={vi.fn()} onUniverseChange={onUniverse} />);
    fireEvent.click(screen.getByRole('button', { name: /사전필터/ }));  // 모달 열기 (기본 '시장' pane)
    fireEvent.click(screen.getByRole('button', { name: 'KOSPI' }));      // 시장 토글
    expect(onUniverse).toHaveBeenCalledWith({ markets: ['KOSPI'] });
  });
```

Run: `npx vitest run src/screener/ConditionBuilder.test.tsx` → 5 pass.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/screener/ConditionBuilder.tsx frontend/src/pages/Screener.test.tsx frontend/src/screener/ConditionBuilder.test.tsx
git commit -m "feat(screener-fe): 빌더 헤더에 사전필터 버튼, 인라인 섹션 제거 + 테스트 마이그레이션"
```

---

## Task 5: 전체 검증 (타입 + 스코프 테스트 + 수동)

**Files:** 없음 (검증 전용)

- [ ] **Step 1: 타입체크**

Run: `cd frontend && npx tsc -b`
Expected: 에러 0. (`ConditionBuilder`에서 `SectionLabel`·`MARKETS` 제거 후 미사용 import 잔재 없음 확인 — 남아있으면 TS6133.)

- [ ] **Step 2: 스크리너 스코프 테스트 일괄**

Run: `cd frontend && npx vitest run src/screener src/pages/Screener.test.tsx`
Expected: 전부 PASS — 신규 3개 파일 + 기존 스크리너 테스트(드로어·저장목록·에디터 등) 회귀 없음.

- [ ] **Step 3: 변경 파일 lint (레포 전체 X — 사전 부채 회피)**

Run: `cd frontend && npx eslint src/screener/UniverseFilterButton.tsx src/screener/UniverseFilterModal.tsx src/screener/universeFilter.ts src/screener/ConditionBuilder.tsx`
Expected: 변경 파일 에러 0.

- [ ] **Step 4: 수동 확인 (`/screener`)**

백엔드+프론트 dev 서버 띄운 뒤(CLAUDE.md "Dev servers"):
1. 빌더 헤더 `사전필터` 버튼 클릭 → 모달 열림(기본 '시장' pane).
2. KOSPI 토글, nav '제외' → ETF 제외 체크 → 버튼 배지가 `2`로, 좌측 목록에 `수정됨` 표시 즉시 갱신.
3. `닫기`/Esc/배경 클릭 → 닫힘.
4. 저장 → 다른 조건검색 로드 → 다시 로드 시 universe 복원(조건검색별 필터 확인).
5. `거래정지 제외` 켜고 `조회` → 결과에서 거래정지 종목(9개 중 해당) 빠짐. `ETF 제외` 켜고 조회 → KODEX/TIGER 등 빠짐.

- [ ] **Step 5: 검증 완료 커밋(필요 시 빈 변경 없으면 생략)**

검증만 했고 코드 변경이 없으면 별도 커밋 불필요. dev 확인 중 미세 수정이 생기면 해당 파일만 add 후 커밋.

---

## Self-Review (작성자 체크 결과)

- **Spec coverage:** 배지 카운트+엣지(T1), aria 요약/그릴#2(T1·T3), ModalShell 2-group nav+pane 전환+즉시적용+닫기 dismiss(T2), nav 활성 체크(T2), 트리거 배지/accent/aria/open-close(T3), ConditionBuilder 헤더+인라인 제거+MARKETS 이동(T4), Screener.test 2건 + ConditionBuilder.test 컴패니언 마이그레이션(T4), 타입/스코프/수동(T5). 백엔드·모델·드로어 무변경 → 손대는 태스크 없음(의도적). ✔
- **Placeholder scan:** "적절히/TODO/유사하게" 없음. 모든 코드 step은 완전한 코드 포함. ✔
- **Type consistency:** `countActiveUniverse(u: ScreenerUniverse): number`, `universeSummary(u: ScreenerUniverse): string` — T1 정의, T3 사용 일치. `UniverseFilterModal` props `{universe,onChange,onClose}` / `UniverseFilterButton` props `{universe,onChange}` — T2·T3 정의, T4(`ConditionBuilder`)에서 `universe`/`onUniverseChange` 전달 일치. `Group='market'|'exclude'` 내부 일관. ✔
