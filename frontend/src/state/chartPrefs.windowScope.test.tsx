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
import { FACTORY_INDICATOR_SETTINGS } from './indicatorSettingsV2';
import type { LiveTimeframe } from './livePage';

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
    indicators: FACTORY_INDICATOR_SETTINGS,
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

describe('indicator-modal chartPrefs 창 스코프', () => {
  beforeEach(() => {
    act(() => {
      useChartPrefsStore.getState().resetToDefaults();
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

    const { indicatorModalByTimeframe: buckets } = useChartPrefsStore.getState();
    expect(buckets.D?.surgeMarkerEnabled).toBe(false);
    expect(buckets.minute?.surgeMarkerEnabled).toBeUndefined();
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

  it('"현재 봉 초기화"는 대상 창의 버킷만 비운다', async () => {
    act(() => {
      useChartPrefsStore.getState().setPrefAt('1m', 'surgeMarkerEnabled', false);
      useChartPrefsStore.getState().setPrefAt('D', 'surgeMarkerEnabled', false);
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

    const { indicatorModalByTimeframe: buckets } = useChartPrefsStore.getState();
    expect(buckets.D).toBeUndefined();
    expect(buckets.minute?.surgeMarkerEnabled).toBe(false);
  });
});
