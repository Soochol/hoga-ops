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
 * 필터는 아코디언 3단 깊이에 있었다. 파이프라인 전환 뒤에는 그 답이 **단계 ③** 에
 * 모인다 — 헤더의 `필터 N/2` 와 그 아래 흐름 리드아웃.
 *
 * **`N/2` 로 적는 이유**: 필터 둘의 공장값이 둘 다 켜짐이라 손대지 않은 칸이 2로
 * 시작한다. 맨숫자 `2` 는 "내가 뭘 많이 켜 뒀나" 로 읽히는데 실제 뜻은 **기본이
 * 최대**다 — 분모가 그 극성을 숫자 안으로 들여온다.
 *
 * 이 파일은 **패널 밖**(Provider 없음)에서 렌더하므로 창 스코프는 `null` 이다 —
 * 레지스트리도 그 스코프로 심는다.
 */
const seed = (side: 'ask' | 'bid', family: 'Traded' | 'Unreached' | 'AllWall', shown: number, hiddenByFilter: number) => {
  usePeakWallCountsRegistry.getState().register(null, peakWallCountsKey(side, family), { shown, hiddenByFilter });
};

describe('최대벽 필터 가시화 — 단계 ③ 의 필터 수와 흐름 리드아웃', () => {
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

  // 손대지 않은 칸이 2/2 로 시작한다는 것이 바로 그 조사의 결론이다. 파이프라인은
  // 한 번에 한 칸이므로 여섯 칸을 **돌면서** 전부 그런지 잰다.
  it('기본 상태에서는 여섯 칸 전부 필터 2/2 다 (기본이 최대)', () => {
    render(<PeakWallsConfig />);
    for (const side of ['매도', '매수'] as const) {
      fireEvent.click(screen.getByRole('button', { name: `${side} 설정 열기` }));
      for (const family of ['체결된 벽', '미도달 벽', '전체 최대벽'] as const) {
        fireEvent.click(screen.getByRole('button', { name: `${side} ${family}` }));
        expect(screen.getByText('필터 2/2')).toBeTruthy();
      }
    }
  });

  it('필터를 하나 끄면 그 칸만 1/2 로 내려간다', () => {
    render(<PeakWallsConfig />);
    // 기본 선택(매도 · 체결된 벽)의 분봉 MA 필터를 끈다. `IndicatorPrefRows` 는
    // testId 를 **행 래퍼**에 달고 핸들러는 안쪽 스위치에 있다.
    const row = screen.getByTestId('settings-toggle-askPeakTradedAboveMaEnabled');
    fireEvent.click(row.querySelector('[role="switch"]') as HTMLElement);
    expect(screen.getByText('필터 1/2')).toBeTruthy();

    // 옆 칸은 그대로다 — 필터가 계열별이라는 것이 이 단언의 요점이다.
    fireEvent.click(screen.getByRole('button', { name: '매도 미도달 벽' }));
    expect(screen.getByText('필터 2/2')).toBeTruthy();
  });

  // warn 은 셋을 모두 만족할 때만 — 그러지 않으면 "그날 벽이 없던 날" 에도 경보가
  // 떠서 곧 무시된다. 조합표로 그 셋을 각각 잰다.
  it('warn 은 「켜져 있고 · 0개 표시 · 필터가 실제로 걸렀다」 셋을 모두 만족할 때만', () => {
    const warnText = '후보가 전부 필터에 걸렸습니다';

    // ① 셋 다 만족 → warn
    seed('ask', 'Traded', 0, 2);
    const first = render(<PeakWallsConfig />);
    expect(screen.getAllByText(warnText)).toHaveLength(1);
    first.unmount();

    // ② 벽이 그려지고 있으면 → warn 없음
    seed('ask', 'Traded', 1, 2);
    const second = render(<PeakWallsConfig />);
    expect(screen.queryByText(warnText)).toBeNull();
    second.unmount();

    // ③ **후보가 애초에 없던 날** → warn 없음(필터 탓이 아니다)
    seed('ask', 'Traded', 0, 0);
    const third = render(<PeakWallsConfig />);
    expect(screen.queryByText(warnText)).toBeNull();
    third.unmount();

    // ④ 계열이 꺼져 있으면 → warn 없음(안 그리기로 한 것이다)
    seed('ask', 'Traded', 0, 2);
    useLivePageStore.setState({ askPeakTradedLineEnabled: false });
    render(<PeakWallsConfig />);
    expect(screen.queryByText(warnText)).toBeNull();
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
  //
  // 문구가 「수평선 숨김」 이 아니라 「숨김」 인 이유: 눈은 선만이 아니라 라벨·화살표도
  // 끈다(2026-08-26 실측). 종전 문구는 그 배선을 잘못 요약하고 있었다.
  it('눈이 꺼져 있으면 「표시」 대신 후보 어법으로 바꾼다', () => {
    seed('ask', 'Traded', 3, 1);
    useLivePageStore.setState({ askPeakHidden: true });
    render(<PeakWallsConfig />);
    expect(screen.getByTestId('peak-wall-readout-ask-Traded').textContent)
      .toBe('숨김 — 후보 3개 · 1개 필터로 제외');
  });
});
