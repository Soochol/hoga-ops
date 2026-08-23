import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  WindowViewContext,
  useIndicatorActions,
  useSeedWindowIndicatorScope,
  useWindowIndicator,
  useWindowIndicatorScope,
  type WindowViewValue,
} from './windowView';
import { useLivePageStore, type LiveTimeframe } from '../../state/livePage';
import { useWorkspaceStore, type WorkspaceWindow } from '../../state/workspace';
import {
  FACTORY_INDICATOR_SETTINGS,
  INDICATORS_V2_STORAGE_KEY,
  normalizeIndicatorsV2,
} from '../../state/indicatorSettingsV2';
import { normalizePaneOrder } from '../../chart/paneOrder';
import {
  useActivePrefs,
  useChartPrefActions,
  useChartPrefsStore,
} from '../../state/chartPrefs';

/**
 * 지표 스코프(페이지 × 창 × 봉)의 계약 가드 (ADR-0146 + ADR-0152).
 *
 * 사용자가 실제로 하는 검수가 이 파일의 뼈대다: **창 두 개를 띄우고 한쪽 지표를
 * 바꿔서 다른 쪽이 안 따라오는지 보는 것**, 그리고 `/live` ↔ `/study` 의 같은 검수.
 * 그래서 여기서 못 박는 것이 넷이다.
 *
 *  ① **페이지 격리** — 한 페이지의 편집이 다른 페이지에 새지 않는다(양방향).
 *  ② **창 격리** — 같은 페이지·같은 봉의 두 창이 서로를 따라가지 않는다(ADR-0152).
 *     이 축은 #1327 로 열렸다가 같은 날 걷혔고(ADR-0146), ADR-0146 이 예고한
 *     재검토 트리거가 실제로 와서 다시 얹었다. **기본이 독립**이라는 것이 그때와
 *     갈리는 지점이다 — opt-in 이면 검수 시나리오가 그때처럼 실패한다.
 *  ③ **시드** — 창은 빈손으로 열리지 않는다. 새 창은 포커스 창을, 그 밖의 창은
 *     앱 세트를 복사한다. 시드가 없으면 "창별 독립" 의 대가가 "새 창마다
 *     지표를 처음부터" 가 되어 멀티창의 주 용도에 마찰만 더한다.
 *  ④ **회수** — 창이 사라지면 그 세트도 사라진다(창 id 는 재사용되지 않는다).
 *
 * ⚠ `renderWindow` 는 **시드 훅을 함께 돌린다** — 실제 창 컴포넌트가 그렇기
 * 때문이다. 이걸 빼면 모든 창이 엔트리 없이 페이지 세트로 폴백해, 창 축이 있든
 * 없든 파일 전체가 초록이 된다(= 아무것도 증명하지 못한다).
 */

function chartWindow(id: string, timeframe: LiveTimeframe = '1m'): WorkspaceWindow {
  return {
    id,
    kind: 'chart',
    group: 3,
    rect: { x: 0, y: 0, w: 400, h: 300 },
    chart: { timeframe },
  };
}

function seedWorkspace(windows: WorkspaceWindow[]): void {
  useWorkspaceStore.setState({
    windows,
    zOrder: windows.map((w) => w.id),
    groupSymbols: { 3: { code: '000660', name: 'SK하이닉스' } },
    chartRuntime: {},
  });
}

function windowValue(
  windowId: string,
  timeframe: LiveTimeframe = '1m',
): WindowViewValue {
  return {
    windowId,
    group: 3,
    code: '000660',
    timeframe,
    historicalFromDate: null,
  };
}

function provider(value: WindowViewValue) {
  return ({ children }: { children: ReactNode }) => (
    <WindowViewContext.Provider value={value}>{children}</WindowViewContext.Provider>
  );
}

/** 한 창에서 읽고 쓰는 표면 한 묶음(지표 + 드로어 안 chartPrefs 항목).
 *  실제 창 컴포넌트(`ChartWindow`)와 같이 **시드 훅을 함께**
 *  돌린다 — 파일 상단 주석의 ⚠ 참조. */
function renderWindow(value: WindowViewValue) {
  return renderHook(() => {
    useSeedWindowIndicatorScope(value.windowId);
    return {
      scope: useWindowIndicatorScope(),
      actions: useIndicatorActions(),
      volumeEnabled: useWindowIndicator((s) => s.volumeEnabled),
      maPeriod: useWindowIndicator((s) => s.movingAverages[0]?.period),
      surgeMarkerEnabled: useActivePrefs((p) => p.surgeMarkerEnabled),
      prefActions: useChartPrefActions(),
    };
  }, { wrapper: provider(value) });
}

function storedV2() {
  return normalizeIndicatorsV2(JSON.parse(localStorage.getItem(INDICATORS_V2_STORAGE_KEY) ?? '{}'));
}

beforeEach(() => {
  localStorage.clear();
  useLivePageStore.setState({
    ...FACTORY_INDICATOR_SETTINGS,
    indicatorsByTimeframe: {},
    indicatorsByWindow: {},
    indicatorTimeframe: '1m',
    paneOrder: normalizePaneOrder([]),
    paneStretch: {},
  });
  useChartPrefsStore.setState({
    indicatorModalByTimeframe: {},
    indicatorModalByWindow: {},
    indicatorModalTimeframe: '1m',
    surgeMarkerEnabled: true,
  });
  seedWorkspace([chartWindow('w1'), chartWindow('w2')]);
});

// 여기 「두 페이지는 서로 동기화하지 않는다」 5케이스가 있었다. 그 축(`IndicatorPageScope`)
// 이 ADR-0157 후속으로 걷히면서 **가드가 지킬 대상 자체가 사라졌다** — 지난 세션에는
// 축이 살아 있어 영속 데이터 가드로 남겼지만, 이번엔 축과 함께 간다. 「창 격리」는
// 아래 블록이 그대로 지킨다.

describe('한 페이지 안에서도 창들은 독립이다 (ADR-0152)', () => {
  // 이 파일의 헤드라인 — 사용자가 검수하는 바로 그 시나리오다.
  it('같은 페이지·같은 봉의 두 창이 서로를 따라가지 않는다', () => {
    const a = renderWindow(windowValue('w1'));
    const b = renderWindow(windowValue('w2'));

    a.result.current.actions.setVolumeEnabled(false);
    a.rerender();
    b.rerender();

    expect(a.result.current.volumeEnabled).toBe(false);
    expect(b.result.current.volumeEnabled).toBe(true);
  });

  it('드로어 안 chartPrefs 항목도 창별이다 — 같은 패널의 절반만 갈리면 안 된다', () => {
    // 두 스토어의 멤버십이 어긋나면 화면에는 안 보이는 채로 절반만 창별이 된다
    // (ADR-0072 — 두 스토어의 값이 한 드로어에 함께 뜬다).
    const a = renderWindow(windowValue('w1'));
    const b = renderWindow(windowValue('w2'));

    a.result.current.prefActions.setToggle('surgeMarkerEnabled', false);
    a.rerender();
    b.rerender();

    expect(a.result.current.surgeMarkerEnabled).toBe(false);
    expect(b.result.current.surgeMarkerEnabled).toBe(true);
  });

  it('창 편집은 앱 세트를 오염시키지 않는다 — 시드 뿌리가 흔들리면 안 된다', () => {
    // 여기가 흔들리면 그 뒤 열리는 **모든** 새 창이 남의 창 설정을 물려받는다.
    const a = renderWindow(windowValue('w1'));
    a.result.current.actions.setVolumeEnabled(false);

    const s = useLivePageStore.getState();
    expect(s.indicatorsByTimeframe.minute).toBeUndefined();
    // 최상위 ambient 투영도 그대로 — Provider 밖 소비자가 남의 창 값을 보면 안 된다.
    expect(s.volumeEnabled).toBe(true);
  });

  // 「스코프 키 = 페이지 접두 + 창 id」 케이스가 있었다 — 두 워크스페이스가 창 id 를
  // 독립 발급하던 시절의 충돌 가드다. 워크스페이스가 하나가 되어 충돌이 불가능하다.
  // 접두(`live:`) 자체는 영속 키의 화석으로 남는다(`windowScopeKey` 주석).
  it('봉 축은 창 **안에서** 그대로 산다 — 창 × 봉 버킷', () => {
    const minute = renderWindow(windowValue('w1', '1m'));
    const daily = renderWindow(windowValue('w1', 'D'));

    minute.result.current.actions.setVolumeEnabled(false);
    minute.rerender();
    daily.rerender();

    // 같은 창(w1)이라도 봉 버킷이 다르면 값이 갈린다.
    expect(minute.result.current.volumeEnabled).toBe(false);
    expect(daily.result.current.volumeEnabled).toBe(true);
  });
});

describe('창 시드 — 빈손으로 열리지 않는다', () => {
  it('엔트리가 없는 창은 마운트 시 앱 세트를 복사한다 — 화면 무변경', () => {
    // 업그레이드 직후의 기존 창·프리셋 적용·딥링크 탭이 전부 이 경로다.
    useLivePageStore.getState().patchIndicatorsScoped(
      { windowKey: null }, '1m', { volumeEnabled: false },
    );

    const w = renderWindow(windowValue('w1'));

    expect(w.result.current.volumeEnabled).toBe(false);
    expect(useLivePageStore.getState().indicatorsByWindow['live:w1'])
      .toEqual({ minute: { volumeEnabled: false } });
  });

  it('시드는 멱등이다 — 재마운트가 사용자 값을 시드로 되돌리지 않는다', () => {
    // 마운트 effect 가 안전망이라 탭 전환·재마운트마다 불린다. 여기서 덮으면
    // 사용자가 만진 값이 매번 사라진다.
    const w = renderWindow(windowValue('w1'));
    w.result.current.actions.setVolumeEnabled(false);
    w.unmount();

    const again = renderWindow(windowValue('w1'));
    expect(again.result.current.volumeEnabled).toBe(false);
  });

  it('시드는 깊은 사본이다 — 버킷 참조를 공유하면 편집이 새어 간다', () => {
    useLivePageStore.getState().patchIndicatorsScoped(
      { windowKey: null }, '1m', { volumeEnabled: false },
    );
    renderWindow(windowValue('w1'));

    const s = useLivePageStore.getState();
    expect(s.indicatorsByWindow['live:w1'].minute).not.toBe(s.indicatorsByTimeframe.minute);
  });

  it('새 창은 포커스 창의 지표를 복사해서 열린다', () => {
    // "창별 독립" 의 유일한 마찰(새 창마다 지표를 처음부터)을 없애는 규칙.
    const a = renderWindow(windowValue('w1'));
    a.result.current.actions.setVolumeEnabled(false);

    // 시드 원본은 **포커스(zOrder 최상단) 차트 창**이다 — 시드에서 w1 을 원하면
    // 먼저 포커스를 줘야 한다(beforeEach 의 zOrder 는 w1, w2 라 기본은 w2).
    useWorkspaceStore.getState().focusWindow('w1');
    const newId = useWorkspaceStore.getState().addWindow('chart');

    expect(useLivePageStore.getState().indicatorsByWindow[`live:${newId}`])
      .toEqual({ minute: { volumeEnabled: false } });
    const fresh = renderWindow(windowValue(newId));
    expect(fresh.result.current.volumeEnabled).toBe(false);
  });

  it('창 초기화는 엔트리를 **남긴다** — 조용히 페이지 세트로 되붙으면 안 된다', () => {
    const w = renderWindow(windowValue('w1'));
    w.result.current.actions.setVolumeEnabled(false);
    w.result.current.actions.resetIndicators();

    const byWindow = useLivePageStore.getState().indicatorsByWindow;
    expect(Object.hasOwn(byWindow, 'live:w1')).toBe(true);
    expect(byWindow['live:w1'].minute).toBeUndefined();

    // 되붙지 않았다: 페이지 세트를 바꿔도 이 창은 따라오지 않는다.
    useLivePageStore.getState().patchIndicatorsScoped(
      { windowKey: null }, '1m', { volumeEnabled: false },
    );
    w.rerender();
    expect(w.result.current.volumeEnabled).toBe(true);
  });
});

describe('창 회수 — 사라진 창의 세트는 남지 않는다', () => {
  it('창을 닫으면 두 스토어에서 함께 걷힌다', () => {
    const w = renderWindow(windowValue('w1'));
    w.result.current.actions.setVolumeEnabled(false);
    w.result.current.prefActions.setToggle('surgeMarkerEnabled', false);
    expect(useLivePageStore.getState().indicatorsByWindow['live:w1']).toBeTruthy();
    expect(useChartPrefsStore.getState().indicatorModalByWindow['live:w1']).toBeTruthy();

    useWorkspaceStore.getState().closeWindow('w1');

    // 한쪽만 걷히면 "절반만 창별" 상태가 되고, 그건 화면에 안 보인다.
    expect(useLivePageStore.getState().indicatorsByWindow['live:w1']).toBeUndefined();
    expect(useChartPrefsStore.getState().indicatorModalByWindow['live:w1']).toBeUndefined();
    // 살아 있는 창은 그대로다 — 회수가 과하면 남의 설정을 지운다.
    expect(useLivePageStore.getState().indicatorsByWindow['live:w2']).toBeUndefined();
  });

  it('스냅샷 교체는 **사라진 id 만** 걷는다 — 살아남은 창의 설정은 지키다', () => {
    renderWindow(windowValue('w1')).result.current.actions.setVolumeEnabled(false);
    renderWindow(windowValue('w2')).result.current.actions.setVolumeEnabled(false);

    // w1 은 프리셋 payload 에 그대로 있고 w2 만 사라진다. rect 는 **비율**이어야
    // 한다 — 프리셋 payload 는 v2(비율)만 인정하고, px 는 검증에서 떨어져 공장
    // 기본 배치로 폴백한다(ADR-0122). 폴백하면 w1 도 사라져 이 테스트의 의미가
    // "전량 회수" 로 바뀐다.
    useWorkspaceStore.getState().applyWorkspaceSnapshot({
      windows: [{ ...chartWindow('w1'), rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }],
      zOrder: ['w1'],
    });

    expect(useLivePageStore.getState().indicatorsByWindow['live:w1']).toBeTruthy();
    expect(useLivePageStore.getState().indicatorsByWindow['live:w2']).toBeUndefined();
  });
});

describe('시드·왕복 — 저장값이 그대로 실린다', () => {
  // 여기 `/study` 세트의 시드·왕복 케이스 셋이 있었다(키 부재 시 `/live` 에서 시드,
  // 공장값 사용자의 빈 엔트리 보존, 두 세트 동시 hydrate). 페이지 축이 걷히면서
  // **시드할 두 번째 세트가 없어졌다** — 남는 것은 창 세트의 왕복이고 아래가 그것이다.
  it('저장된 창 세트는 왕복에서 살아남는다 — 빈 엔트리까지', () => {
    // 빈 엔트리를 걷어내면 공장값 상태의 창이 다음 로드에 페이지 세트로 되붙고,
    // 증상은 한참 뒤 다른 창을 편집한 순간에야 나타난다.
    localStorage.setItem(INDICATORS_V2_STORAGE_KEY, JSON.stringify({
      paneOrder: [], paneStretch: {},
      byTimeframe: { minute: { volumeEnabled: false } },
      byWindow: {
        'live:w1': { minute: { ratioEnabled: true } },
        'live:w2': {},
      },
    }));

    const normalized = storedV2();

    expect(normalized.byWindow['live:w1']).toEqual({ minute: { ratioEnabled: true } });
    expect(Object.hasOwn(normalized.byWindow, 'live:w2')).toBe(true);
    expect(normalized.byTimeframe.minute?.volumeEnabled).toBe(false);
  });

  it('크로스탭 재수화가 창 세트까지 덮는다 — #712 와 갈리는 지점', () => {
    // 내용물이 전역 localStorage 에 있고 창은 키만 갖기 때문에 성립한다. 여기가
    // 빨개지면 설정이 창(탭별 저장소)으로 되돌아간 것이다.
    const w = renderWindow(windowValue('w1'));
    expect(w.result.current.volumeEnabled).toBe(true);

    localStorage.setItem(INDICATORS_V2_STORAGE_KEY, JSON.stringify({
      paneOrder: [], paneStretch: {}, byTimeframe: {}, studyByTimeframe: {},
      byWindow: { 'live:w1': { minute: { volumeEnabled: false } } },
    }));
    useLivePageStore.getState().hydrateIndicatorsFromStorage();
    w.rerender();

    expect(w.result.current.volumeEnabled).toBe(false);
  });
});

describe('영속화', () => {
  it('두 축이 같은 블롭에 함께 저장된다 — 한쪽 편집이 다른 쪽을 지우지 않는다', () => {
    // `persistIndicators()` 가 인자를 안 받는 이유가 이것이다 — 호출부가 블롭을
    // 손으로 조립하면 축이 늘 때마다 빠뜨린 곳이 저장소를 통째로 날린다
    // (`setPaneOrder` 한 번에 창 설정이 사라지는 모양).
    //
    // 축이 셋(앱·`/study`·창)에서 **둘**(앱·창)로 줄었다 — 페이지 축이 걷혔다.
    const w1 = renderWindow(windowValue('w1'));
    const w2 = renderWindow(windowValue('w2'));

    w2.result.current.actions.setVolumeEnabled(false);
    useLivePageStore.getState().patchIndicatorsScoped({ windowKey: null }, '1m', { ratioEnabled: true });
    w1.result.current.actions.setPaneOrder(['candle', 'volume']);

    const stored = storedV2();
    expect(stored.byWindow['live:w2']?.minute?.volumeEnabled).toBe(false);
    expect(stored.byTimeframe.minute?.ratioEnabled).toBe(true);
    expect(stored.paneOrder).toEqual(normalizePaneOrder(['candle', 'volume']));
  });

  /**
   * 기존 사용자의 디스크에 남은 `studyByTimeframe` 이 **다음 쓰기에서 사라지는가**.
   *
   * 마이그레이션을 따로 쓰지 않은 근거가 이것이다 — `persistIndicators` 가 스토어에서
   * 필드를 **명시로 조립**하므로, 정규화가 안 읽고 여기가 안 쓰면 키가 자연 소멸한다.
   * 이 성질이 깨지면 죽은 키가 사용자 디스크에 영구히 남는다(기능은 안 깨지지만
   * 「자연 소멸」이라고 적은 주석·PR 설명이 거짓이 된다).
   */
  it('저장된 `studyByTimeframe` 은 다음 쓰기에서 블롭에서 사라진다', () => {
    localStorage.setItem(INDICATORS_V2_STORAGE_KEY, JSON.stringify({
      paneOrder: [], paneStretch: {},
      byTimeframe: { minute: { volumeEnabled: false } },
      studyByTimeframe: { minute: { ratioEnabled: true } },
    }));
    useLivePageStore.getState().hydrateIndicatorsFromStorage();

    // 양성 대조 — 하이드레이션이 실제로 일어났는가(살아 있는 축이 실렸다).
    const w = renderWindow(windowValue('w1'));
    expect(w.result.current.volumeEnabled).toBe(false);

    w.result.current.actions.setPaneOrder(['candle', 'volume']);

    const raw = JSON.parse(localStorage.getItem(INDICATORS_V2_STORAGE_KEY) as string);
    expect(Object.hasOwn(raw, 'studyByTimeframe')).toBe(false);
  });
});
