import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import PeakWallsConfig from './PeakWallsConfig';
import { useLivePageStore } from '../../state/livePage';

/**
 * 매트릭스의 **스코프 문법** — 무엇이 열의 것이고, 무엇이 방향 공용이고, 무엇이
 * 방향까지 공용인가.
 *
 * 종전엔 이 파일이 "매수 탭으로 넘어가서" 를 매번 거쳤다. 탭이 사라지면서 두 방향이
 * 한 화면에 있으므로 그 왕복이 없어졌고, 그 자체가 이 전환의 요점이다 —
 * **절반의 상태가 항상 숨어 있지 않다.**
 */
describe('PeakWallsConfig — 매트릭스의 스코프 문법', () => {
  beforeEach(() => {
    useLivePageStore.setState({
      peakWallPaneEnabled: false,
      askPeakEnabled: true,
      askPeakHidden: false,
      bidPeakEnabled: true,
      bidPeakHidden: false,
      indicatorsByTimeframe: {},
    });
  });
  afterEach(cleanup);

  it('방향 공용 행은 두 방향의 스위치를 나란히 둔다 — 탭 왕복이 없다', () => {
    render(<PeakWallsConfig />);
    expect(screen.getByTestId('settings-toggle-askPeakCandleLine')).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-bidPeakCandleLine')).toBeTruthy();
  });

  // 방향까지 공용이라 매트릭스 **밖**이다 — 한 pane 을 양방향이 공유하므로 어느
  // 열에 두든 거짓말이 된다.
  it('강도 pane 토글은 매트릭스 밖에 하나만 있고, 공용 배지를 단다', () => {
    render(<PeakWallsConfig />);
    expect(screen.getAllByTestId('settings-toggle-peakWallPaneEnabled')).toHaveLength(1);
    expect(screen.getByText('매도 · 매수 공용')).toBeTruthy();

    fireEvent.click(screen.getByTestId('settings-toggle-peakWallPaneEnabled'));
    expect(useLivePageStore.getState().peakWallPaneEnabled).toBe(true);
  });

  it('「캔들 수평선」 끔 = 기존 눈(hidden) 켬 — 새 키가 아니라 같은 상태', () => {
    render(<PeakWallsConfig />);
    fireEvent.click(screen.getByTestId('settings-toggle-askPeakCandleLine'));
    expect(useLivePageStore.getState().askPeakHidden).toBe(true);
    fireEvent.click(screen.getByTestId('settings-toggle-askPeakCandleLine'));
    expect(useLivePageStore.getState().askPeakHidden).toBe(false);
  });

  it('캔들 수평선은 방향별 — 한쪽을 만져도 반대쪽은 그대로다', () => {
    render(<PeakWallsConfig />);
    fireEvent.click(screen.getByTestId('settings-toggle-bidPeakCandleLine'));
    expect(useLivePageStore.getState().bidPeakHidden).toBe(true);
    expect(useLivePageStore.getState().askPeakHidden).toBe(false);
  });

  it('그 방향 마스터가 꺼져 있으면 그 열의 캔들 수평선만 dim 된다', () => {
    useLivePageStore.setState({ askPeakEnabled: false });
    render(<PeakWallsConfig />);
    expect(screen.getByTestId('settings-toggle-askPeakCandleLine')).toBeDisabled();
    // 반대 열은 살아 있다 — dim 이 방향별이라는 것이 요점이다.
    expect(screen.getByTestId('settings-toggle-bidPeakCandleLine')).not.toBeDisabled();
    // pane 은 방향까지 공용이라 side 마스터에 물리지 않는다.
    expect(screen.getByTestId('settings-toggle-peakWallPaneEnabled')).not.toBeDisabled();
  });

  // 셀의 스위치는 **그 방향 × 그 계열**만 움직인다. 여섯 칸이 서로 새면 매트릭스가
  // 말하는 스코프가 거짓이 된다.
  it('셀 스위치 6칸이 각자 자기 키만 움직인다', () => {
    render(<PeakWallsConfig />);
    const cells = [
      { side: 'ask', label: '매도 체결된 벽', key: 'askPeakTradedLineEnabled' },
      { side: 'ask', label: '매도 미도달 벽', key: 'askPeakUnreachedLineEnabled' },
      { side: 'ask', label: '매도 전체 최대벽', key: 'askPeakAllWallLineEnabled' },
      { side: 'bid', label: '매수 체결된 벽', key: 'bidPeakTradedLineEnabled' },
      { side: 'bid', label: '매수 미도달 벽', key: 'bidPeakUnreachedLineEnabled' },
      { side: 'bid', label: '매수 전체 최대벽', key: 'bidPeakAllWallLineEnabled' },
    ] as const;

    // 계열마다 공장 기본값이 달라(미도달·전체는 꺼짐) 순서로 추론할 수 없다 —
    // 클릭 직전 여섯 값을 통째로 찍어 두고 **그 스냅샷과** 비교한다.
    const snapshot = () => Object.fromEntries(
      cells.map((c) => [c.key, useLivePageStore.getState()[c.key]]),
    ) as Record<(typeof cells)[number]['key'], boolean>;

    for (const cell of cells) {
      const before = snapshot();
      fireEvent.click(screen.getByRole('switch', { name: cell.label }));
      const after = snapshot();

      expect(after[cell.key]).toBe(!before[cell.key]);
      for (const other of cells) {
        if (other.key === cell.key) continue;
        expect(after[other.key]).toBe(before[other.key]);
      }
    }
  });

  it('셀을 고르면 세부 존이 그 칸으로 따라간다', () => {
    render(<PeakWallsConfig />);
    expect(screen.getByTestId('peak-wall-detail-zone-ask-Traded')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '매수 미도달 벽' }));
    expect(screen.getByTestId('peak-wall-detail-zone-bid-Unreached')).toBeTruthy();
    expect(screen.queryByTestId('peak-wall-detail-zone-ask-Traded')).toBeNull();
  });
});

/**
 * 두 열을 다 끄면 지표 자체가 사라진다(패널의 존재 판정이 `ask || bid`). 매트릭스
 * 에서는 그 삭제가 **평범해 보이는 두 번의 클릭**으로 도달하므로, 레전드 칩 ✕ 와
 * 같은 복구 수단이 인수 조건이다.
 */
describe('PeakWallsConfig — 마지막 방향을 끄면 undo 토스트', () => {
  beforeEach(() => {
    useLivePageStore.setState({
      askPeakEnabled: true,
      bidPeakEnabled: true,
      askPeakHidden: false,
      bidPeakHidden: false,
      indicatorUndoToast: null,
      indicatorsByTimeframe: {},
    });
  });
  afterEach(cleanup);

  it('한쪽만 끄는 클릭에는 토스트가 없다 — 지표는 아직 있다', () => {
    render(<PeakWallsConfig />);
    fireEvent.click(screen.getByRole('switch', { name: '매도 최대벽 표시' }));

    expect(useLivePageStore.getState().askPeakEnabled).toBe(false);
    expect(useLivePageStore.getState().bidPeakEnabled).toBe(true);
    expect(useLivePageStore.getState().indicatorUndoToast).toBeNull();
  });

  it('마지막 방향을 끄면 토스트가 뜨고, 되돌리면 그 방향이 살아난다', () => {
    render(<PeakWallsConfig />);
    fireEvent.click(screen.getByRole('switch', { name: '매도 최대벽 표시' }));
    fireEvent.click(screen.getByRole('switch', { name: '매수 최대벽 표시' }));

    const toast = useLivePageStore.getState().indicatorUndoToast;
    expect(toast?.label).toBe('당일 매수 최대벽 삭제됨');
    expect(useLivePageStore.getState().bidPeakEnabled).toBe(false);

    useLivePageStore.getState().restoreIndicatorUndoToast();
    expect(useLivePageStore.getState().bidPeakEnabled).toBe(true);
  });

  // **`Hidden` 도 스냅샷해야 한다.** 복원은 op 를 우회하는 raw patch 인데
  // `set{Side}PeakEnabled(true)` 는 `Hidden: false` 를 같이 쓴다 — 토스트가 떠 있는
  // 동안 다시 켰다가 undo 를 누르면 눈 상태가 스냅샷과 어긋난다.
  it('undo 는 눈(hidden) 상태까지 삭제 시점으로 되돌린다', () => {
    useLivePageStore.setState({ askPeakEnabled: false, bidPeakHidden: true });
    render(<PeakWallsConfig />);
    fireEvent.click(screen.getByRole('switch', { name: '매수 최대벽 표시' }));

    // 토스트가 떠 있는 동안 사용자가 다시 켠다 — 그 op 이 hidden 을 false 로 만든다.
    fireEvent.click(screen.getByRole('switch', { name: '매수 최대벽 표시' }));
    expect(useLivePageStore.getState().bidPeakHidden).toBe(false);

    useLivePageStore.getState().restoreIndicatorUndoToast();
    expect(useLivePageStore.getState().bidPeakHidden).toBe(true);
  });
});
