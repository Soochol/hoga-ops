import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import PeakWallsConfig from './PeakWallsConfig';
import { useLivePageStore } from '../../state/livePage';
import { useChartPrefsStore } from '../../state/chartPrefs';
import { usePeakWallCountsRegistry, peakWallCountsKey } from './peakWallCountsRegistry';

/**
 * 「당일 최대벽이 왜 안 보이나」에 **화면이 직접 답하는가**.
 *
 * 2026-08-26 조사의 실제 원인은 MA 필터 4종이 전부 기본 ON 이라는 것이었고, 그
 * 필터는 아코디언 3단 깊이에 있었다. 깔때기(셀)와 리드아웃(존 헤더)이 그 사실을
 * 표면으로 끌어올린다.
 *
 * 이 파일은 **패널 밖**(Provider 없음)에서 렌더하므로 창 스코프는 `null` 이다 —
 * 레지스트리도 그 스코프로 심는다.
 */
const seed = (side: 'ask' | 'bid', family: 'Traded' | 'Unreached' | 'AllWall', shown: number, hiddenByFilter: number) => {
  usePeakWallCountsRegistry.getState().register(null, peakWallCountsKey(side, family), { shown, hiddenByFilter });
};

describe('최대벽 필터 가시화 — 깔때기와 리드아웃', () => {
  beforeEach(() => {
    useLivePageStore.setState({
      askPeakEnabled: true,
      bidPeakEnabled: true,
      askPeakHidden: false,
      bidPeakHidden: false,
      askPeakTradedLineEnabled: true,
      indicatorsByTimeframe: {},
    });
    useChartPrefsStore.getState().resetToDefaults();
    usePeakWallCountsRegistry.getState().clearScope(null);
  });
  afterEach(cleanup);

  // 필터 둘의 공장값이 **둘 다 켜짐**이다 — 손대지 않은 칸이 2로 시작한다는 것이
  // 바로 그 조사의 결론이고, 숫자가 크다는 게 사용자가 뭘 했다는 뜻이 아니다.
  it('기본 상태에서 모든 칸의 깔때기가 2를 든다 (기본이 최대)', () => {
    render(<PeakWallsConfig />);
    const funnels = screen.getAllByTitle('후보 필터 2개 작동 중');
    expect(funnels).toHaveLength(6);
  });

  it('필터를 하나 끄면 그 칸의 깔때기만 1로 내려간다', () => {
    render(<PeakWallsConfig />);
    // 기본 선택(매도 · 체결된 벽)의 분봉 MA 필터를 끈다. `IndicatorPrefRows` 는
    // testId 를 **행 래퍼**에 달고 핸들러는 안쪽 스위치에 있다.
    const row = screen.getByTestId('settings-toggle-askPeakTradedAboveMaEnabled');
    fireEvent.click(row.querySelector('[role="switch"]') as HTMLElement);

    expect(screen.getAllByTitle('후보 필터 2개 작동 중')).toHaveLength(5);
    expect(screen.getAllByTitle('후보 필터 1개 작동 중')).toHaveLength(1);
  });

  // warn 은 셋을 모두 만족할 때만 — 그러지 않으면 "그날 벽이 없던 날" 에도 경보가
  // 떠서 곧 무시된다. 조합표로 그 셋을 각각 잰다.
  it('warn 은 「켜져 있고 · 0개 표시 · 필터가 실제로 걸렀다」 셋을 모두 만족할 때만', () => {
    const warnTitle = '켜져 있는데 지금 그려진 벽이 없습니다 — 후보가 전부 필터에 걸렸습니다';

    // ① 셋 다 만족 → warn
    seed('ask', 'Traded', 0, 2);
    const first = render(<PeakWallsConfig />);
    expect(screen.getAllByTitle(warnTitle)).toHaveLength(1);
    first.unmount();

    // ② 벽이 그려지고 있으면 → warn 없음
    seed('ask', 'Traded', 1, 2);
    const second = render(<PeakWallsConfig />);
    expect(screen.queryByTitle(warnTitle)).toBeNull();
    second.unmount();

    // ③ **후보가 애초에 없던 날** → warn 없음(필터 탓이 아니다)
    seed('ask', 'Traded', 0, 0);
    const third = render(<PeakWallsConfig />);
    expect(screen.queryByTitle(warnTitle)).toBeNull();
    third.unmount();

    // ④ 계열이 꺼져 있으면 → warn 없음(안 그리기로 한 것이다)
    seed('ask', 'Traded', 0, 2);
    useLivePageStore.setState({ askPeakTradedLineEnabled: false });
    render(<PeakWallsConfig />);
    expect(screen.queryByTitle(warnTitle)).toBeNull();
  });

  it('리드아웃이 지금 몇 개가 그려지고 몇 개가 걸렸는지 말한다', () => {
    seed('ask', 'Traded', 1, 2);
    render(<PeakWallsConfig />);
    expect(screen.getByTestId('peak-wall-readout-ask-Traded').textContent)
      .toBe('지금 1개 표시 · 2개 필터로 숨김');
  });

  // 엔트리 부재 = "차트가 발행하지 않았다"(일·주·월봉). **0 이 아니다** — 0 을
  // 보여 주면 "필터가 다 걸렀다" 와 구별되지 않는다.
  it('차트가 발행하지 않았으면 리드아웃이 아예 없다', () => {
    render(<PeakWallsConfig />);
    expect(screen.queryByTestId('peak-wall-readout-ask-Traded')).toBeNull();
  });

  it('계열이 꺼져 있으면 리드아웃이 없다 — 0 은 필터 탓이 아니다', () => {
    seed('ask', 'Traded', 0, 2);
    useLivePageStore.setState({ askPeakTradedLineEnabled: false });
    render(<PeakWallsConfig />);
    expect(screen.queryByTestId('peak-wall-readout-ask-Traded')).toBeNull();
  });

  // 세그먼트 계산은 눈(hidden)을 보지 않는다(`usePeakWallRender` 불변식). 그래서
  // 눈이 꺼진 상태에서 "표시" 라고 쓰면 거짓말이 된다 — 세어 둔 것은 후보다.
  it('눈이 꺼져 있으면 「표시」 대신 후보 어법으로 바꾼다', () => {
    seed('ask', 'Traded', 3, 1);
    useLivePageStore.setState({ askPeakHidden: true });
    render(<PeakWallsConfig />);
    expect(screen.getByTestId('peak-wall-readout-ask-Traded').textContent)
      .toBe('수평선 숨김 — 후보 3개 · 1개 필터로 제외');
  });
});
