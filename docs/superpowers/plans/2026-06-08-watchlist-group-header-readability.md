# 관심종목 그룹 헤더 가독성 개선 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 관심종목 패널의 그룹 헤더를 종목 행과 시각적으로 구분 — 크기 교환(그룹 14.4px/600, 종목명 13.1px) + 개수 인라인 + chevron 좌측(▼/▶) + sticky 헤더.

**Architecture:** 프레젠테이션 전용 변경 2파일 — `WatchlistDrawer.tsx`의 `GroupHeader`/`ChevronIcon` 재구성, `QuoteRow.tsx` 종목명 클래스 1곳. API·상태·접기 영속 로직은 불변. 스펙: `docs/superpowers/specs/2026-06-08-watchlist-group-header-readability-design.md`.

**Tech Stack:** React + Tailwind 유틸리티(디자인 토큰 클래스), vitest + Testing Library, `/browse`(gstack) 실화면 검증.

**비범위:** WatchlistEditModal의 FolderRow(편집 모달 내 폴더 행)는 변경하지 않는다 — 편집 표면이라 위계 문제가 다름.

---

### Task 1: GroupHeader 재구성 (개수 인라인 + chevron 좌측 + 타이포 + sticky)

**Files:**
- Modify: `frontend/src/watchlist/WatchlistDrawer.tsx:34-114` (ChevronIcon, GroupHeader)
- Test: `frontend/src/watchlist/WatchlistDrawer.test.tsx`

- [ ] **Step 1: 실패하는 테스트 작성**

`WatchlistDrawer.test.tsx`의 `describe('WatchlistDrawer', ...)` 블록 안(기존 it들 뒤)에 추가:

```tsx
  it('개수가 라벨 버튼 안에 인라인 — 접근성 이름이 "스윙 1"이고 클릭하면 접힌다', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    // 개수(1)가 라벨 버튼 내부 자식이면 접근성 이름은 "스윙 1"로 합성된다.
    // 우측 정렬 mono 개수(가격 컬럼과 충돌)가 사라졌음을 보장하는 구조 단언.
    fireEvent.click(screen.getByRole('button', { name: '스윙 1' }));
    expect(screen.queryByText('삼성전자')).toBeNull();
    // 미분류 그룹(SK하이닉스)은 영향 없음
    expect(screen.getByText('SK하이닉스')).toBeInTheDocument();
  });
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/watchlist/WatchlistDrawer.test.tsx -t '스윙 1'`
Expected: FAIL — `Unable to find an accessible element with the role "button" and name "스윙 1"` (현재 라벨 버튼 이름은 "스윙", 개수는 버튼 밖 형제 span)

- [ ] **Step 3: ChevronIcon을 폴더 관용구(▼/▶)로 변경**

`WatchlistDrawer.tsx:34-42`의 ChevronIcon을 통째로 교체:

```tsx
/** 접기 chevron — 펼침=▼(클릭하면 접기), 접힘=▶. 폴더 관용구(VS Code·TradingView),
 *  좌측 배치와 세트. 유니코드 대신 SVG(폰트별 렌더 불일치 회피). */
function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {collapsed ? <path d="M9 6l6 6-6 6" /> : <path d="M6 9l6 6 6-6" />}
    </svg>
  );
}
```

- [ ] **Step 4: GroupHeader 본문 재구성**

`WatchlistDrawer.tsx`의 GroupHeader `return` 블록(현재 65-113행)을 교체. props·메뉴 state·itemClass는 그대로 두고 JSX만:

```tsx
  return (
    // sticky + bg-bg-card: 패널 배경과 동일색이라 평시엔 투명처럼 보이고, 스크롤
    // 시에만 불투명이 드러나 행을 가린다(스펙 §1). 각 그룹 div가 컨테이닝 블록이라
    // 헤더는 자기 그룹 범위에서만 고정된다. 메뉴가 열리면 z를 올려 다음 sticky
    // 헤더(z-10)가 이 헤더의 메뉴(z-30, 헤더 스태킹 컨텍스트 내부)를 덮지 않게 한다.
    <div className={`group sticky top-0 ${menuOpen ? 'z-20' : 'z-10'} flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold text-fg-dim bg-bg-card hover:bg-bg-input-hover`}>
      <button type="button" aria-label={`${props.label} ${props.collapsed ? '펼치기' : '접기'}`}
        onClick={props.onToggle} className="px-1 leading-none text-fg-dimmer hover:text-fg">
        <ChevronIcon collapsed={props.collapsed} />
      </button>
      {/* 개수를 라벨 버튼 안에 — 우측 정렬 mono 개수가 가격 컬럼과 같은 x에 떨어져
          종목 행처럼 읽히던 충돌을 해소하고(스펙 §문제 1), 클릭 타깃도 키운다. */}
      <button type="button" onClick={props.onToggle}
        className="flex-1 min-w-0 text-left flex items-baseline gap-1.5">
        <span className="truncate">{props.label}</span>
        {' '/* 접근성 이름 단어 분리 — 없으면 "스윙1"로 합성 */}
        <span className="flex-none text-xs font-normal text-fg-dimmer">{props.count}</span>
      </button>
      {props.onRename && (
        <div className="relative" ref={menuRef}>
          {/* opacity(레이아웃 유지)로 숨겨 Tab 포커스가 닿게 한다 — display:none이면
              키보드 사용자가 접근 불가. group-focus-within으로 헤더 내 포커스 시 노출,
              메뉴가 열려 있는 동안엔 계속 보여 앵커를 유지한다(마우스가 떠나도). */}
          <button type="button" aria-label={`${props.label} 그룹 메뉴`}
            aria-haspopup="menu" aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className={`${menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'} px-1 leading-none hover:text-fg`}>
            ⋯
          </button>
          {menuOpen && (
            <AnchoredMenu label={props.label}>
              <button type="button" role="menuitem"
                onClick={() => { setMenuOpen(false); props.onRename?.(); }}
                className={itemClass}>
                <span className="w-4 grid place-items-center">✎</span> 그룹 이름 변경
              </button>
              <button type="button" role="menuitem" disabled={!props.canMoveUp}
                onClick={() => { setMenuOpen(false); props.onMoveUp?.(); }}
                className={itemClass}>
                <span className="w-4 grid place-items-center">▲</span> 위로 이동
              </button>
              <button type="button" role="menuitem" disabled={!props.canMoveDown}
                onClick={() => { setMenuOpen(false); props.onMoveDown?.(); }}
                className={itemClass}>
                <span className="w-4 grid place-items-center">▼</span> 아래로 이동
              </button>
              <button type="button" role="menuitem"
                onClick={() => { setMenuOpen(false); props.onDelete?.(); }}
                className={itemClass}>
                <span className="w-4 grid place-items-center"><TrashIcon className="w-[1em] h-[1em]" /></span> 그룹 삭제
              </button>
            </AnchoredMenu>
          )}
        </div>
      )}
    </div>
  );
```

변경 요점(기존 대비): ① 우측 끝 chevron 버튼 삭제 → 좌측 선두로 이동(`ChevronIcon collapsed=` 시그니처), ② 개수 span을 라벨 버튼 내부로 이동 + `font-mono tabular-nums` 제거, ③ 컨테이너 `text-xs` → `text-sm font-semibold`, `gap-1` → `gap-1.5`, ④ `sticky top-0 z-10/20 bg-bg-card` 추가. GroupHeader 상단 doc 주석의 "chevron만" 표현은 그대로 유효(미분류 = chevron+라벨만). ⑤ 라벨/개수 사이 `{' '}` — 접근성 이름 "스윙 1" 합성

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd frontend && npx vitest run src/watchlist/WatchlistDrawer.test.tsx`
Expected: 전부 PASS — 기존 테스트는 aria-label('미분류 접기', '스윙 그룹 메뉴') 기반이라 불변, 신규 테스트 GREEN

- [ ] **Step 6: Commit**

```bash
git add frontend/src/watchlist/WatchlistDrawer.tsx frontend/src/watchlist/WatchlistDrawer.test.tsx
git commit -m "feat(watchlist): 그룹 헤더 시각 위계 — 개수 인라인·chevron 좌측·text-sm/600·sticky"
```

---

### Task 2: QuoteRow 종목명 축소 (text-sm → text-xs)

**Files:**
- Modify: `frontend/src/rightrail/QuoteRow.tsx:79`

프레젠테이션 전용(클래스 1곳)이라 신규 테스트 없음 — jsdom에서 단언할 행동 변화가 없고, 기존 코드베이스도 유틸리티 클래스 단언을 쓰지 않는다. 시각 검증은 Task 4의 `/browse`.

- [ ] **Step 1: 클래스 변경**

`QuoteRow.tsx:79`:

```tsx
      <span className="flex-1 truncate text-xs text-fg">{name}</span>
```

(기존 `text-sm` → `text-xs`. 같은 행의 가격 `text-sm` mono·등락 `text-xs` mono는 그대로.)

- [ ] **Step 2: 사용처 2곳 테스트로 회귀 확인**

Run: `cd frontend && npx vitest run src/rightrail/QuoteRow.test.tsx src/screener/ScreenerDrawer.test.tsx src/watchlist/WatchlistDrawer.test.tsx`
Expected: 전부 PASS

- [ ] **Step 3: Commit**

```bash
git add frontend/src/rightrail/QuoteRow.tsx
git commit -m "feat(rightrail): QuoteRow 종목명 text-xs — 그룹 헤더(text-sm/600)와 위계 형성, 가격은 유지"
```

---

### Task 3: DESIGN.md 패턴 기록

**Files:**
- Modify: `DESIGN.md` (Components 절 + Decisions Log)

- [ ] **Step 1: Components 절에 패턴 추가**

`### Status dot (general)` 블록 바로 앞에 삽입:

```markdown
### Watchlist group header (관심종목 패널)
- 구조: `[chevron ▼(펼침)/▶(접힘), 좌측] [그룹명 + 개수 인라인] ··· [⋯ hover 메뉴, 우측]`
- 그룹명: `sm`/600 — 종목명(`xs`/400)보다 크고 굵게. 색은 `--fg-dim` 유지(크기·굵기만으로 위계).
- 개수: `xs` `--fg-dimmer`, **mono 금지** — 우측 정렬 mono 숫자는 종목 행의 가격 컬럼과
  같은 x에 떨어져 행으로 오독되므로 라벨 옆 인라인 고정.
- sticky `top-0` + `--bg-card` 배경 — 패널과 동일색이라 평시엔 투명처럼 보이고
  스크롤 시에만 행을 가린다.
- 종목 행(QuoteRow) 종목명은 `xs` — 가격(`sm` mono)이 1차 콘텐츠, 종목명은 식별자.
```

- [ ] **Step 2: Decisions Log에 행 추가**

`| 2026-05-30 | Global Right Rail ...` 행 아래에:

```markdown
| 2026-06-08 | 관심종목 그룹 헤더 위계: 크기 교환(그룹 sm/600, 종목명 xs) + 개수 인라인 + chevron 좌측 ▼/▶ + sticky | 그룹·종목이 같은 "좌 텍스트 + 우 mono 숫자" 패턴으로 오독되던 문제. 디자인 컴패니언 4안 비교로 색 추가 없는 A안 선택 — 틸 라벨은 색상 규율(UI 상태 전용) 이탈로 기각. |
```

- [ ] **Step 3: Commit**

```bash
git add DESIGN.md
git commit -m "docs(design): Watchlist group header 패턴 기록 (크기 위계·인라인 개수·sticky)"
```

---

### Task 4: 전체 테스트 + 실화면 검증

**Files:**
- Create(임시): `frontend/vite.config.verify.ts` — 검증 후 삭제, 커밋 금지

- [ ] **Step 1: 전체 프런트 테스트 + 타입체크**

Run: `cd frontend && npx vitest run && npx tsc -b`
Expected: 전체 PASS, tsc 무출력(에러 0)

- [ ] **Step 2: 백엔드 확인**

Run: `curl -s http://127.0.0.1:8000/api/events | head -c 80`
Expected: JSON 응답. 죽어 있으면 CLAUDE.md의 uvicorn 명령으로 메인 repo에서 기동(워크트리에서 두 번째 백엔드를 띄우지 말 것 — DB 공유 충돌).

- [ ] **Step 3: 일회용 검증 vite 설정 작성**

backend CORS가 `:5173`만 허용하므로(메인 vite가 점유) 워크트리는 5174 + same-origin 프록시로 우회한다 — `/config.json`을 `api_url:""`로 오버라이드하면 모든 API 호출이 5174 동일 출처가 되어 vite가 서버사이드 프록시(CORS 비적용)로 전달한다.

`frontend/vite.config.verify.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 일회용 검증 설정(커밋 금지) — 워크트리를 5174에서 띄우고 /config.json을
// same-origin(api_url:"")으로 오버라이드해 backend CORS(:5173 전용)를 우회한다.
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'verify-config-override',
      configureServer(server) {
        server.middlewares.use('/config.json', (_req, res) => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ api_url: '' }));
        });
      },
    },
  ],
  server: {
    port: 5174,
    proxy: { '/api': { target: 'http://localhost:8000', ws: true } },
  },
});
```

- [ ] **Step 4: 워크트리 vite 기동 + `/browse` 검증**

```bash
cd frontend && npm install   # 새 워크트리는 node_modules 비어 있음
npx vite --config vite.config.verify.ts   # 백그라운드로 실행
```

`/browse` 체크리스트 (`B=~/.claude/skills/gstack/browse/dist/browse`):

1. `$B goto http://localhost:5174/live` → 관심 패널 토글(`snapshot -i`로 "관심종목 패널 토글" 클릭)
2. `$B screenshot --selector "#right-rail-watchlist-panel"` — 그룹 헤더가 종목 행과 구분되는지, 개수가 라벨 옆 인라인인지, chevron이 좌측 ▼인지
3. sticky: `$B js "const p=document.querySelector('#right-rail-watchlist-panel'); p.children[1].scrollTop=300"` 후 재스크린샷 — 첫 보이는 그룹 헤더가 상단 고정 + 행 비침 없음
4. 접기: 그룹 라벨 클릭 → 행 사라짐 + chevron ▶, 다시 클릭 → 복원
5. ⋯ 메뉴: 그룹 호버 → ⋯ 클릭 → 메뉴 정상(이름 변경/이동/삭제 항목)
6. `$B console --errors` — JS 에러 0

- [ ] **Step 5: 임시 파일 정리**

```bash
rm frontend/vite.config.verify.ts
# 백그라운드 vite 종료 (해당 셸 작업 kill)
git status   # 워킹트리 클린 확인
```

- [ ] **Step 6: 마무리**

superpowers:finishing-a-development-branch 스킬로 머지/PR 선택지 제시.
