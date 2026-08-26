import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import PeakWallsConfig from './PeakWallsConfig';
import { useLivePageStore } from '../../state/livePage';

/**
 * 파이프라인의 **스코프 문법** — 단계 번호가 곧 스코프의 깊이다.
 *
 * ① 방향 · ② 그 방향의 계열 · ③④ 고른 칸(방향×계열) · ⑤ 지표 전체(양방향 공용).
 *
 * 2026-08-26 매트릭스 → 파이프라인 전환으로 **교환이 하나 뒤집혔다.** 매트릭스는 두
 * 방향을 한 화면에 두는 것(= 절반이 숨지 않는 것)을 샀고, 파이프라인은 그 대신
 * **진단성**을 산다 — 「왜 안 보이지」의 답이 단계 ③ 의 리드아웃으로 나온다. 그래서
 * 이 파일의 단언도 "두 방향이 나란히" 가 아니라 "고른 방향의 것만" 으로 뒤집힌다.
 * 반대쪽이 완전히 침묵하지 않도록 ① 의 카드가 각자 개수를 드는 것이 그 교환의 대가다.
 */
describe('PeakWallsConfig — 파이프라인의 스코프 문법', () => {
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

  // ① 은 방향 **선택**이자 방향 **스코프**다 — 두 카드가 항상 함께 있어야 반대쪽을
  // 켜고 끄는 데 단계를 오갈 필요가 없다.
  it('단계 ① 은 두 방향의 마스터와 눈을 함께 둔다', () => {
    render(<PeakWallsConfig />);
    expect(screen.getByTestId('settings-toggle-askPeakEnabled')).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-bidPeakEnabled')).toBeTruthy();
    expect(screen.getByTestId('peak-wall-eye-ask')).toBeTruthy();
    expect(screen.getByTestId('peak-wall-eye-bid')).toBeTruthy();
  });

  /**
   * **막는 방향**: 눈이 새 키를 만드는 것.
   *
   * 종전 이 자리의 라벨은 「캔들 수평선」이었고 그 이름이 거짓이었다 —
   * `{side}PeakHidden` 은 선만이 아니라 라벨·화살표까지 끈다. 배선은 그대로 두고
   * 이름만 고친 것이므로, **같은 상태를 가리킨다**는 사실이 이 테스트의 전부다.
   */
  it('눈 = 기존 hidden — 새 키가 아니라 같은 상태', () => {
    render(<PeakWallsConfig />);
    fireEvent.click(screen.getByTestId('peak-wall-eye-ask'));
    expect(useLivePageStore.getState().askPeakHidden).toBe(true);
    fireEvent.click(screen.getByTestId('peak-wall-eye-ask'));
    expect(useLivePageStore.getState().askPeakHidden).toBe(false);
  });

  it('눈은 방향별 — 한쪽을 만져도 반대쪽은 그대로다', () => {
    render(<PeakWallsConfig />);
    fireEvent.click(screen.getByTestId('peak-wall-eye-bid'));
    expect(useLivePageStore.getState().bidPeakHidden).toBe(true);
    expect(useLivePageStore.getState().askPeakHidden).toBe(false);
  });

  it('그 방향 마스터가 꺼져 있으면 그 카드의 눈만 잠긴다', () => {
    useLivePageStore.setState({ askPeakEnabled: false });
    render(<PeakWallsConfig />);
    expect(screen.getByTestId('peak-wall-eye-ask')).toBeDisabled();
    // 반대 카드는 살아 있다 — 잠금이 방향별이라는 것이 요점이다.
    expect(screen.getByTestId('peak-wall-eye-bid')).not.toBeDisabled();
    // pane 은 방향까지 공용이라 side 마스터에 물리지 않는다.
    expect(screen.getByTestId('settings-toggle-peakWallPaneEnabled')).not.toBeDisabled();
  });

  // 방향까지 공용이라 **마지막 단계**다 — 한 pane 을 양방향이 공유하므로 어느 방향
  // 아래에 두든 거짓말이 된다.
  it('강도 pane 토글은 단계 ⑤ 에 하나만 있고, 공용 배지를 단다', () => {
    render(<PeakWallsConfig />);
    expect(screen.getAllByTestId('settings-toggle-peakWallPaneEnabled')).toHaveLength(1);
    expect(screen.getByText('매도 · 매수 공용')).toBeTruthy();

    fireEvent.click(screen.getByTestId('settings-toggle-peakWallPaneEnabled'));
    expect(useLivePageStore.getState().peakWallPaneEnabled).toBe(true);
  });

  // 계열 스위치는 **그 방향 × 그 계열**만 움직인다. 여섯이 서로 새면 단계가 말하는
  // 스코프가 거짓이 된다. 파이프라인은 한 번에 한 방향이므로 방향을 고르며 순회한다.
  it('계열 스위치 6칸이 각자 자기 키만 움직인다', () => {
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
      fireEvent.click(screen.getByRole('button', { name: `${cell.side === 'ask' ? '매도' : '매수'} 설정 열기` }));
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

  it('방향·계열을 고르면 단계 ③④ 가 그 칸으로 따라간다', () => {
    render(<PeakWallsConfig />);
    expect(screen.getByTestId('peak-wall-detail-zone-ask-Traded')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '매수 설정 열기' }));
    fireEvent.click(screen.getByRole('button', { name: '매수 미도달 벽' }));
    expect(screen.getByTestId('peak-wall-detail-zone-bid-Unreached')).toBeTruthy();
    expect(screen.queryByTestId('peak-wall-detail-zone-ask-Traded')).toBeNull();
  });

  // 방향을 고르는 것은 **표현 상태**다 — 스토어를 건드리면 카드를 눌러 본 것만으로
  // 지표 설정이 바뀐다.
  it('방향 카드를 고르는 것만으로는 아무 pref 도 안 바뀐다', () => {
    render(<PeakWallsConfig />);
    const before = JSON.stringify(useLivePageStore.getState().indicatorsByTimeframe);
    fireEvent.click(screen.getByRole('button', { name: '매수 설정 열기' }));
    expect(useLivePageStore.getState().bidPeakEnabled).toBe(true);
    expect(JSON.stringify(useLivePageStore.getState().indicatorsByTimeframe)).toBe(before);
  });
});

/**
 * 두 방향을 다 끄면 지표 자체가 사라진다(패널의 존재 판정이 `ask || bid`). 파이프라인
 * 에서도 그 삭제는 **평범해 보이는 두 번의 클릭**으로 도달하므로, 레전드 칩 ✕ 와
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
  // 동안 다시 켰다가 undo 를 누르면 눈 상태가 스냅샷과 어긋난다. 파이프라인에서는
  // 마스터와 눈이 같은 카드 안이라 그 결합이 화면에서 보이지만, 결합 자체는 그대로다.
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
