import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_STORAGE_KEY } from '../state/workspace';
import type { SavedRangeFocus } from '../state/livePage';

/**
 * `/live` 저장뷰 기간 슬롯의 **해제 경계** — 무엇이 풀고 무엇이 안 푸는가.
 *
 * ── 이 파일이 막는 방향 ────────────────────────────────────────────────────
 * 해제가 **너무 자주** 일어나는 쪽이다. 저장뷰를 열어 둔 채 화면을 둘러보는 동안
 * 슬롯이 조용히 사라지는 실수는 세 가지 모양으로 온다:
 *   ① 해제를 `projectActiveView` 에 걸기 → 창 포커스 전환 미러가 같은 경로를 타므로
 *      다른 종목 창을 **클릭만 해도** 풀린다.
 *   ② `code` 비교 없이 무조건 지우기 → 관심종목에서 **같은 종목**을 다시 눌러도 풀린다.
 *   ③ blocked early-return 앞에 두기 → 전 창이 핀이라 **아무 일도 안 일어난 클릭**이
 *      슬롯을 지운다.
 * 셋 다 "종목 변경 시 해제" 라는 결정(2026-08-21)과 어긋나고, 셋 다 타입으로는
 * 드러나지 않는다.
 *
 * ── 이 파일이 못 보는 것 ───────────────────────────────────────────────────
 * **드롭 경로(`setWindowSymbol`)는 재지 않는다.** 드롭은 `activateLiveInstrument` 를
 * 타지 않으므로(CONTEXT.md "드롭은 여기를 타지 않는다") 슬롯이 그대로 남는다. 그것이
 * 의도다 — 저장뷰는 종목에 묶이고 창 여럿에 동시에 걸릴 수 있어서, 창 하나에 드롭했다고
 * 전체 슬롯을 지우면 다른 창의 밴드까지 함께 사라진다. 대신 그 창은 code 게이트로
 * 밴드가 꺼지고, 같은 종목으로 되돌리면 되살아난다.
 *
 * 봉 전환도 트리거가 아니다 — 일봉 밴드와 분봉 벽은 **같은 슬롯의 두 표현**이라
 * 봉을 오갈 수 있어야 기능이 성립한다. 봉은 이 진입점을 지나지 않으므로 여기서는
 * 구조적으로 안전하고, 별도 단언을 두지 않는다.
 */

const FOCUS: SavedRangeFocus = {
  viewId: 'sv-1',
  code: '005930',
  label: '삼성전자',
  fromMs: 1_780_000_000_000,
  toMs: 1_781_000_000_000,
  fromDate: '20260701',
  toDate: '20260708',
  savedTimeframe: '1m',
  savedBarSpan: 240,
};

function seedWorkspace(windows: { id: string; group: number; pinned?: { code: string; name: string } }[]) {
  sessionStorage.setItem(
    WORKSPACE_STORAGE_KEY,
    JSON.stringify({
      schema_version: 2,
      windows: windows.map((w) => ({
        id: w.id,
        kind: 'chart',
        group: w.group,
        rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
        chart: { timeframe: '1m' },
        ...(w.pinned ? { pinned: w.pinned } : {}),
      })),
      zOrder: windows.map((w) => w.id),
      groupSymbols: { 1: { code: '005930', name: '삼성전자' } },
    }),
  );
}

async function load() {
  window.history.replaceState({}, '', '/live');
  vi.resetModules();
  const page = await import('../state/livePage');
  const workspace = await import('../state/workspace');
  const navigate = await import('./liveNavigate');
  page.useLivePageStore.getState().focusSavedRange(FOCUS);
  return { ...page, ...workspace, ...navigate };
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  // ⚠ **슬롯을 명시적으로 비운다.** `load()` 의 `vi.resetModules()` 는 모듈 레지스트리를
  // 비울 뿐이고, zustand 스토어는 **모듈 스코프 싱글턴**이라 같은 워커에서 이미 import 된
  // 인스턴스가 살아 있는 경로가 있다. storage 만 지우면 앞 테스트가 세운 `savedRangeFocus`
  // 가 다음 테스트의 주입을 가려, **혼자 돌리면 초록인데 파일 전체에서 깨진다**.
  const { useLivePageStore } = await import('../state/livePage');
  useLivePageStore.setState({ savedRangeFocus: null });
});

describe('저장뷰 슬롯 해제 — activateLiveInstrument', () => {
  it('다른 종목으로 바꾸면 해제된다', async () => {
    seedWorkspace([{ id: 'w1', group: 1 }]);
    const { useLivePageStore, activateLiveCode } = await load();
    expect(useLivePageStore.getState().savedRangeFocus).not.toBeNull();

    activateLiveCode('000660', 'SK하이닉스');

    expect(useLivePageStore.getState().savedRangeFocus).toBeNull();
  });

  it('**같은 종목**을 다시 클릭해도 유지된다 — "종목 변경 시" 이지 "클릭 시" 가 아니다', async () => {
    seedWorkspace([{ id: 'w1', group: 1 }]);
    const { useLivePageStore, activateLiveCode } = await load();

    activateLiveCode('005930', '삼성전자');

    expect(useLivePageStore.getState().savedRangeFocus?.viewId).toBe('sv-1');
  });

  it('전 창이 핀이라 클릭이 막히면 유지된다 — 아무 일도 안 일어난 클릭은 지우지 않는다', async () => {
    seedWorkspace([{ id: 'w1', group: 1, pinned: { code: '035720', name: '카카오' } }]);
    const { useLivePageStore, useWorkspaceStore, activateLiveCode } = await load();

    activateLiveCode('000660', 'SK하이닉스');

    // **전제를 함께 잰다.** blocked 가 발화하지 않으면 아래 단언은 "해제 안 함" 이
    // 아니라 "그냥 통과" 를 재게 되고, 그러면 이 테스트는 아무것도 증명하지 않는다.
    expect(useWorkspaceStore.getState().blockedActivation).toEqual({ name: 'SK하이닉스' });
    expect(useLivePageStore.getState().savedRangeFocus?.viewId).toBe('sv-1');
  });

  it('지수로 바꾸면 해제된다 — 지수 차트엔 저장뷰 종목이 없다', async () => {
    seedWorkspace([{ id: 'w1', group: 1 }]);
    const { useLivePageStore, activateLiveInstrument } = await load();

    activateLiveInstrument({ kind: 'index', id: 'KOSPI', label: 'KOSPI' });

    expect(useLivePageStore.getState().savedRangeFocus).toBeNull();
  });
});

describe('저장뷰 슬롯 해제 — 지나가면 안 되는 경로', () => {
  it('창 포커스 전환 미러는 해제하지 않는다 — 다른 창 클릭이 저장뷰를 죽이면 안 된다', async () => {
    seedWorkspace([{ id: 'w1', group: 1 }, { id: 'w2', group: 2 }]);
    const { useLivePageStore, mirrorActiveGroupToLivePage } = await load();

    // 그룹 2 창(다른 종목)으로 포커스가 옮겨간 상황의 미러.
    mirrorActiveGroupToLivePage({ code: '000660', name: 'SK하이닉스' }, '1m');

    // activeCode 는 따라 바뀌지만(미러의 본업) 슬롯은 살아 있어야 한다.
    expect(useLivePageStore.getState().activeCode).toBe('000660');
    expect(useLivePageStore.getState().savedRangeFocus?.viewId).toBe('sv-1');
  });

  it('슬롯은 영속되지 않는다 — 새로고침(=하이드레이션)은 저장뷰를 되살리지 않는다', async () => {
    seedWorkspace([{ id: 'w1', group: 1 }]);
    const { useLivePageStore } = await load();

    // 슬롯이 선 상태로 저장이 일어나도 `live.page.v1` 에 실리지 않는다.
    useLivePageStore.getState().extendHistoricalRange('20260101');
    const raw = localStorage.getItem('live.page.v1') ?? '{}';

    expect(raw).not.toContain('savedRangeFocus');
    expect(raw).not.toContain('sv-1');
  });
});
