import { useLocation } from 'react-router';
import type { MouseEvent } from 'react';
import { WORKSPACE_NAV_ITEMS } from './items';
import TopNavItem from './TopNavItem';
import { CaptureInlineStatus } from './CaptureInlineStatus';
import StatusDot from './StatusDot';
import { LiveSymbolSearch } from '../live/LiveSymbolSearch';
import ClockLabel from './ClockLabel';
import { useRightRailStore } from '../state/rightRail';

const NAV_BUTTON_CLASS = [
  'h-full inline-flex items-center whitespace-nowrap transition-colors',
  'text-sm text-fg-dim font-semibold hover:text-fg',
].join(' ');

/**
 * 이 탭에서 실제로 이동이 일어나는 클릭인가.
 *
 * ctrl/meta/shift/alt + 클릭은 새 탭·새 창·다운로드라 **여기 있는 페이지는 그대로**
 * 인데, 그냥 열면 이 탭의 우측 패널만 바뀐다. react-router 의 NavLink 도 정확히 같은
 * 네 키로 라우팅을 건너뛰므로 조건을 맞춰 둔다(가운데 버튼은 button !== 0).
 */
function navigatesInThisTab(e: MouseEvent<HTMLAnchorElement>): boolean {
  return e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
}

export default function TopNav({ onOpenSettings }: { onOpenSettings: () => void }) {
  // 종목 검색은 /live 전용이므로 해당 라우트에서만 헤더에 마운트한다. 검색창의
  // ＋버튼·"/" 키 포커스 배선은 liveSearchFocus 이벤트 버스로 위치와 무관하게 동작한다.
  const isLive = useLocation().pathname === '/live';
  const setActivePanel = useRightRailStore((s) => s.setActivePanel);
  return (
    <nav
      aria-label="주요 메뉴"
      className="h-top-nav min-w-0 bg-bg px-lg"
    >
      {/* 3열 대칭 그리드 — **시계를 상단바 정중앙에 앉히기 위한 구조다**.
          양옆이 같은 `1fr` 이므로 가운데 `auto` 열의 중심 = 상단바의 중심이 된다.
          이전 `auto auto minmax(0,1fr) auto` 는 좌측(로고+메뉴 528px)이 우측(42px)
          보다 훨씬 넓어 중앙 열의 중심이 871px 로 밀려 있었다(상단바 중심 616px).

          `minmax(0,1fr)` 이 아니라 **`1fr`(= minmax(auto,1fr))** 인 것이 핵심이다:
          공간이 모자라면 좌측 열이 min-content 아래로 안 줄어들어 **메뉴가 잘리는
          대신 시계가 오른쪽으로 밀린다**. 화면이 좁을 때 기능(메뉴)을 잃느니 정렬을
          양보한다. 실측 임계는 상단바 폭 ~1274px(화면 ~1322px) — 그 위로는 정확히
          중앙, 아래로는 점진적으로 밀린다. */}
      <div className="grid h-full min-w-0 grid-cols-[1fr_auto_1fr] items-center gap-xl">
        {/* ⚠ **`overflow-hidden` 을 다시 넣지 말 것.** 그리드 항목은 overflow 가
            visible 이 아니면 자동 최소 크기가 0 이 되어 위 `1fr` 의 min-content 바닥이
            무력화된다 — 실측 1280px 에서 `캡처` 항목이 **통째로 사라졌고** `보관함`
            도 걸쳤다(잘림이 조용해서 화면만 봐선 못 알아본다). 지금은 min-content 가
            바닥이라 좁아지면 메뉴가 잘리는 대신 시계가 오른쪽으로 밀린다.
            좌측 최소 552px + 시계 138 + 우측 ~90 + 간격 80 = 860px 이 상단바 최소
            폭이고, 앱 셸 최소 폭(993px, DESIGN.md)보다 작아 오버플로가 나지 않는다.
            메뉴 항목을 늘릴 땐 이 여유(≈85px)를 다시 계산할 것. */}
        <div className="flex h-full items-center gap-xl">
          <div className="inline-flex shrink-0 items-center gap-sm whitespace-nowrap">
            <span
              aria-hidden="true"
              className="grid h-[22px] w-[22px] place-items-center rounded bg-fg text-bg text-xs font-extrabold leading-none"
            >
              H
            </span>
            <span className="text-lg font-extrabold leading-none text-fg">hoga-ops</span>
          </div>

          {WORKSPACE_NAV_ITEMS.map((item) => (
            <TopNavItem
              key={item.to}
              to={item.to}
              label={item.label}
              // 라우트로 가면서 그 페이지의 주력 패널을 함께 연다(items.ts 의 `panel`).
              // **toggle 이 아니라 set** 이다 — 이미 그 페이지에 있는데 nav 를 또 눌렀을 때
              // 열려 있던 패널이 닫히면 "누르면 열린다" 와 정반대로 동작한다. set 은 덤으로
              // lastPanel 까지 갱신해 레일 쉐브론의 재열기 대상도 방금 연 패널이 된다.
              onClick={'panel' in item
                ? (e) => { if (navigatesInThisTab(e)) setActivePanel(item.panel); }
                : undefined}
            />
          ))}
        </div>

        {/* 가운데 열은 시계 전용이다 — 여기 무언가를 더 넣으면 그 폭의 절반만큼
            시계가 밀려 위 대칭이 깨진다. 새 항목은 좌/우 열로. */}
        <ClockLabel />

        {/* 종목 검색은 2026-08-21 에 중앙 열에서 이 우측 클러스터로 옮겼다(사용자 결정) —
            가운데를 시계에 내주기 위해서다. 트리거만 옮겨지고 **팝오버는 그대로**다:
            `fixed left-1/2 top-[12vh]` 로 뷰포트에 붙는 오버레이라 트리거 위치와 무관하다.
            **`min-w-0` 을 넣지 않는다.** 열이 내용 아래로 줄면 `justify-end` 때문에
            항목들이 **왼쪽으로 넘쳐 시계를 덮는다** — 실측: 옛 셸 바닥 912px 에서 캡처
            진행 중(`수집 3 · 대기 12`)일 때 상태 텍스트가 시계와 겹쳤다. 축소가 필요한
            것은 검색 트리거뿐이고 그건 자기 안에 `flex-1 min-w-0 max-w-[360px]` 로 이미
            갖고 있다.
            ⚠ 다만 정직하게: 바닥을 59rem(944px)으로 올린 지금은 `min-w-0` 을 되돌려도
            겹침이 재현되지 않는다(red-check 실측 — 초록이었다). 즉 **이건 테스트가
            지키는 계약이 아니라 여유에 기대지 않으려는 선택**이다. 바닥을 다시 내리면
            둘의 결합이 되살아난다. */}
        <div className="flex items-center justify-end gap-lg text-xs font-semibold text-fg-dim">
          {isLive && <LiveSymbolSearch />}
          <CaptureInlineStatus />
          {/* 설정은 **라우트가 아니라 드로어**다. 목록 기반 렌더(`SYSTEM_NAV_ITEMS`)와
              그 안의 `/settings` 분기는 항목이 하나뿐인 죽은 일반화였고, 페이지가
              사라지면서 함께 지웠다. */}
          <button type="button" onClick={onOpenSettings} className={NAV_BUTTON_CLASS}>
            설정
          </button>
          <StatusDot />
        </div>
      </div>
    </nav>
  );
}
