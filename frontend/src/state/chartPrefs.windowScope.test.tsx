import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  useChartPrefsStore,
  useActivePrefs,
  useChartPrefActions,
  prefsForTimeframe,
  syncIndicatorModalTimeframe,
} from './chartPrefs';
import { WindowViewContext, type WindowViewValue } from '../live/workspace/windowViewContext';
import { LIVE_WINDOW_WORKSPACE } from '../live/workspace/windowView';
import type { LiveTimeframe } from './livePage';


/** Provider 밖(전역 경로) 스코프 — `/live` 페이지 세트. */
const AMBIENT = { page: null, windowKey: null } as const;
/**
 * indicator-modal chartPrefs 의 **창 스코프** 회귀 가드.
 *
 * 결함(수정 전): 버킷은 봉별(minute/D/W/M)인데 "어느 버킷을 적용할지"는 포커스를
 * 따라다니는 전역 슬롯(`indicatorModalTimeframe`)이 정했다. 그래서 분봉 창에서 끈
 * 「총잔량 급증 마커」가, 슬롯이 D 를 가리키는 동안(D 창 포커스·종목 클릭 직후)
 * 분봉 창에서도 기본값 ON 으로 되살아났다. 그 창을 클릭해 포커스를 주면 슬롯이
 * 재동기화되며 다시 사라져 "과거로 팬하면 없어진다"로 보였다.
 */

function windowView(timeframe: LiveTimeframe): WindowViewValue {
  return {
    windowId: `win-${timeframe}`,
    group: 1,
    code: '005930',
    timeframe,
    historicalFromDate: null,
    workspace: LIVE_WINDOW_WORKSPACE,
  };
}

function SurgeProbe({ label }: { label: string }) {
  const enabled = useActivePrefs((p) => p.surgeMarkerEnabled);
  return <span data-testid={label}>{enabled ? 'on' : 'off'}</span>;
}

function SurgeToggle({ label }: { label: string }) {
  const enabled = useActivePrefs((p) => p.surgeMarkerEnabled);
  const { setToggle } = useChartPrefActions();
  return (
    <button type="button" data-testid={label} onClick={() => setToggle('surgeMarkerEnabled', !enabled)}>
      toggle
    </button>
  );
}

/** 창 세트의 버킷 — 창 편집은 페이지 세트가 아니라 여기로 간다(ADR-0152). */
function windowBuckets(timeframe: LiveTimeframe) {
  return useChartPrefsStore.getState().indicatorModalByWindow[`live:win-${timeframe}`];
}

describe('indicator-modal chartPrefs 창 스코프', () => {
  beforeEach(() => {
    act(() => {
      useChartPrefsStore.getState().resetToDefaults();
      // 창 id 가 봉에서 파생돼 테스트 간 재사용되므로 창 맵도 비운다(ADR-0152).
      useChartPrefsStore.setState({ indicatorModalByWindow: {} });
      syncIndicatorModalTimeframe('1m');
    });
  });

  it('창의 봉 버킷을 읽는다 — 전역 슬롯이 다른 봉을 가리켜도 흔들리지 않는다', async () => {
    render(
      <>
        <WindowViewContext.Provider value={windowView('1m')}>
          <SurgeToggle label="toggle-minute" />
          <SurgeProbe label="minute" />
        </WindowViewContext.Provider>
        <WindowViewContext.Provider value={windowView('D')}>
          <SurgeProbe label="daily" />
        </WindowViewContext.Provider>
      </>,
    );

    expect(screen.getByTestId('minute')).toHaveTextContent('on');
    await userEvent.click(screen.getByTestId('toggle-minute'));

    // 분봉 창만 꺼진다 — D 창은 자기 버킷(기본값)을 계속 본다.
    expect(screen.getByTestId('minute')).toHaveTextContent('off');
    expect(screen.getByTestId('daily')).toHaveTextContent('on');

    // 핵심 회귀: 전역 슬롯이 D 로 넘어가도(다른 창 포커스·종목 클릭) 분봉 창은 off 유지.
    act(() => syncIndicatorModalTimeframe('D'));
    expect(screen.getByTestId('minute')).toHaveTextContent('off');
    expect(screen.getByTestId('daily')).toHaveTextContent('on');
  });

  it('쓰기는 대상 창의 봉 버킷으로 간다 — 전역 슬롯 버킷을 오염시키지 않는다', async () => {
    act(() => syncIndicatorModalTimeframe('1m'));
    render(
      <WindowViewContext.Provider value={windowView('D')}>
        <SurgeToggle label="toggle-daily" />
      </WindowViewContext.Provider>,
    );
    await userEvent.click(screen.getByTestId('toggle-daily'));

    // 대상 창의 D 버킷에 쓴다. 페이지 세트는 손대지 않는다 — 창 편집이 시드
    // 뿌리를 오염시키면 그 뒤 열리는 모든 새 창이 이 값을 물려받는다.
    expect(windowBuckets('D')?.D?.surgeMarkerEnabled).toBe(false);
    expect(windowBuckets('D')?.minute?.surgeMarkerEnabled).toBeUndefined();
    expect(useChartPrefsStore.getState().indicatorModalByTimeframe).toEqual({});
    // ambient(minute) 투영도 그대로 — 다른 봉을 편집했을 뿐이다.
    expect(useChartPrefsStore.getState().surgeMarkerEnabled).toBe(true);
  });

  it('Provider 밖에서는 ambient 투영을 읽는다 (/study·단일 차트 무변경 계약)', () => {
    act(() => {
      syncIndicatorModalTimeframe('1m');
      useChartPrefsStore.getState().setToggle('surgeMarkerEnabled', false);
    });
    render(<SurgeProbe label="global" />);
    expect(screen.getByTestId('global')).toHaveTextContent('off');
  });

  it('차트 전반(flat) 키는 봉과 무관하게 전역이다', () => {
    act(() => useChartPrefsStore.getState().setToggle('auctionWindowMask', false));
    const s = useChartPrefsStore.getState();
    expect(prefsForTimeframe(s, '1m').auctionWindowMask).toBe(false);
    expect(prefsForTimeframe(s, 'D').auctionWindowMask).toBe(false);
  });

  it('prefsForTimeframe 은 같은 (스냅샷, 봉)에 같은 객체를 준다 — 스냅샷 안정성', () => {
    const s = useChartPrefsStore.getState();
    expect(prefsForTimeframe(s, '1m')).toBe(prefsForTimeframe(s, '5m')); // 같은 minute 프로파일
    expect(prefsForTimeframe(s, '1m')).not.toBe(prefsForTimeframe(s, 'D'));
  });

  it('"현재 봉 초기화"는 대상 창의 그 봉 버킷만 비운다 — 페이지 세트는 안 건드린다', async () => {
    // 페이지 세트에 두 봉을 심어 두고 D 창에서 초기화한다. 창 엔트리가 아직
    // 없으므로 **초기화 경로가 먼저 엔트리를 보장**해야 한다 — 안 그러면 이
    // 초기화가 페이지 세트를 지워 그 뒤 열리는 모든 새 창에 번진다.
    act(() => {
      useChartPrefsStore.getState().setPrefScoped(AMBIENT, '1m', 'surgeMarkerEnabled', false);
      useChartPrefsStore.getState().setPrefScoped(AMBIENT, 'D', 'surgeMarkerEnabled', false);
    });
    function Reset() {
      const { resetIndicatorModalBucket } = useChartPrefActions();
      return <button type="button" data-testid="reset" onClick={resetIndicatorModalBucket}>reset</button>;
    }
    render(
      <WindowViewContext.Provider value={windowView('D')}>
        <Reset />
      </WindowViewContext.Provider>,
    );
    await userEvent.click(screen.getByTestId('reset'));

    // 창 세트: 시드로 두 봉을 받은 뒤 D 만 비었다.
    expect(windowBuckets('D')?.D).toBeUndefined();
    expect(windowBuckets('D')?.minute?.surgeMarkerEnabled).toBe(false);
    // 페이지 세트: 그대로.
    const { indicatorModalByTimeframe: page } = useChartPrefsStore.getState();
    expect(page.D?.surgeMarkerEnabled).toBe(false);
    expect(page.minute?.surgeMarkerEnabled).toBe(false);
  });
});
