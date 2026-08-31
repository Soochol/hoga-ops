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
      askPeakTradedPaneEnabled: true,
      askPeakUnreachedPaneEnabled: false,
      askPeakAllWallPaneEnabled: false,
      bidPeakTradedPaneEnabled: true,
      bidPeakUnreachedPaneEnabled: false,
      bidPeakAllWallPaneEnabled: false,
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
    // pane 슬롯은 방향 마스터에 물리지 않는다 — 계단은 「그날 어디에 벽이 있었나」가
    // 아니라 「그 벽이 언제 얼마나 자랐나」를 답하는 다른 표면이다.
    expect(screen.getByTestId('settings-toggle-askPeakTradedPaneEnabled')).not.toBeDisabled();
  });

  /**
   * ⑤ 에는 **스위치가 없다** — pane 의 있다/없다는 ② 의 여섯 칸이 정한다.
   *
   * **막는 방향**: 마스터 토글이 되살아나는 것. 그 스위치와 여섯 칸은 같은 질문에 두 번
   * 답해서, 화면에 함께 두는 한 어긋난 조합(빈 pane · 무효 저장값)이 반드시 생긴다.
   * 방향 공용이라는 사실은 배지가 계속 말한다.
   */
  it('⑤ 에는 pane 스위치가 없고, 공용 배지만 남는다', () => {
    render(<PeakWallsConfig />);
    expect(screen.queryByTestId('settings-toggle-peakWallPaneEnabled')).toBeNull();
    expect(screen.getByText('매도 · 매수 공용')).toBeTruthy();
  });

  /**
   * 강도 pane 의 슬롯 6칸(방향 × 계열) — `PEAK_WALL_STEP_SLOTS` 와 1:1 이고 캔들 선
   * 토글과 **다른 키**다.
   *
   * **막는 방향** 둘: (1) 이 여섯이 `{side}Peak{Family}LineEnabled` 로 다시 배선되는
   * 것 — 화면엔 스위치가 둘인데 상태는 하나라 서로를 조용히 덮는다. (2) 여섯이 방향을
   * 잃고 셋으로 합쳐지는 것 — 매도를 껐는데 매수도 꺼진다.
   *
   * 2026-08-27 부터 스위치가 ② 의 계열 행에 있으므로 **한 화면에는 셋뿐이다**.
   * 나머지 셋은 ① 에서 방향을 바꿔 닿는다 — 그래서 이 순회가 방향 카드를 함께 누른다.
   */
  it('강도 pane 슬롯 6칸이 각자 자기 키만 움직인다', () => {
    // 마스터를 먼저 연다 — 닫혀 있으면 표시가 `마스터 && 슬롯` 으로 접혀 클릭이
    // 언제나 「추가」가 된다(아래 테스트가 그 접힘을 잰다).
    useLivePageStore.setState({ peakWallPaneEnabled: true });
    render(<PeakWallsConfig />);
    const slots = [
      { side: 'ask', name: '매도 체결된 벽', key: 'askPeakTradedPaneEnabled', line: 'askPeakTradedLineEnabled' },
      { side: 'ask', name: '매도 미도달 벽', key: 'askPeakUnreachedPaneEnabled', line: 'askPeakUnreachedLineEnabled' },
      { side: 'ask', name: '매도 전체 최대벽', key: 'askPeakAllWallPaneEnabled', line: 'askPeakAllWallLineEnabled' },
      { side: 'bid', name: '매수 체결된 벽', key: 'bidPeakTradedPaneEnabled', line: 'bidPeakTradedLineEnabled' },
      { side: 'bid', name: '매수 미도달 벽', key: 'bidPeakUnreachedPaneEnabled', line: 'bidPeakUnreachedLineEnabled' },
      { side: 'bid', name: '매수 전체 최대벽', key: 'bidPeakAllWallPaneEnabled', line: 'bidPeakAllWallLineEnabled' },
    ] as const;

    for (const slot of slots) {
      fireEvent.click(screen.getByRole('button', { name: `${slot.side === 'ask' ? '매도' : '매수'} 설정 열기` }));
      const before = useLivePageStore.getState();
      const wasPane = before[slot.key];
      const wasLine = before[slot.line];
      fireEvent.click(screen.getByRole('switch', { name: `강도 pane ${slot.name}` }));
      const after = useLivePageStore.getState();

      expect(after[slot.key]).toBe(!wasPane);
      // 같은 칸의 **캔들 선**은 안 움직인다 — 두 표면이 독립이라는 것이 요점이다.
      expect(after[slot.line]).toBe(wasLine);
      // 다른 다섯 슬롯도 그대로다 — 방향이 합쳐지면 여기서 빨개진다.
      for (const other of slots) {
        if (other.key === slot.key) continue;
        expect(after[other.key]).toBe(before[other.key]);
      }
    }
  });

  /**
   * 슬롯의 스코프는 **고른 방향**이다 — ⑤ 매트릭스가 ② 로 내려오며 뒤집힌 단언.
   *
   * **막는 방향**: 여섯이 다시 한 화면에 모이는 것(그러면 ① 의 방향 선택이 pane 에만
   * 무의미해진다), 그리고 반대쪽이 **완전히 침묵하는 것** — 요약 줄이 그걸 막는다.
   * 요약이 없으면 「분명 껐는데 계단이 남아 있다」의 답이 화면 밖에 있게 된다.
   */
  it('슬롯은 고른 방향의 셋만 보이고, 반대쪽은 ⑤ 요약이 말한다', () => {
    useLivePageStore.setState({
      peakWallPaneEnabled: true,
      askPeakTradedPaneEnabled: true,
      bidPeakAllWallPaneEnabled: true,
    });
    render(<PeakWallsConfig />);

    expect(screen.getByTestId('settings-toggle-askPeakTradedPaneEnabled')).toBeTruthy();
    expect(screen.queryByTestId('settings-toggle-bidPeakTradedPaneEnabled')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '매수 설정 열기' }));
    expect(screen.getByTestId('settings-toggle-bidPeakTradedPaneEnabled')).toBeTruthy();
    expect(screen.queryByTestId('settings-toggle-askPeakTradedPaneEnabled')).toBeNull();

    // 요약은 방향을 가리지 않는다 — 지금 pane 에 들어 있는 것 전부를 든다.
    const summary = screen.getByTestId('peak-wall-pane-summary').textContent ?? '';
    expect(summary).toContain('매도 체결된 벽');
    expect(summary).toContain('매수 전체 최대벽');
  });

  /**
   * 마스터가 닫혀 있으면 저장값이 무엇이든 그 계단은 **pane 에 없다**. 스위치가
   * 저장값을 그대로 그리면 「켜져 있는데 pane 이 없는」 스위치가 첫 화면에 뜬다 —
   * 공장값이 정확히 그 조합이라(체결된 벽 슬롯 켜짐 · 마스터 꺼짐) 가정이 아니라
   * 기본 상태다(2026-08-27 실측).
   *
   * **막는 방향**: 표시가 저장값으로 되돌아가는 것. 그리고 그때의 클릭이 「끄기」로
   * 해석돼, 켜려고 누른 사용자가 pane 을 못 얻는 것.
   */
  it('마스터가 닫혀 있으면 슬롯은 꺼진 것으로 접히고, 누르면 pane 이 열린다', () => {
    useLivePageStore.setState({ peakWallPaneEnabled: false, askPeakTradedPaneEnabled: true });
    render(<PeakWallsConfig />);
    const traded = screen.getByTestId('settings-toggle-askPeakTradedPaneEnabled');
    expect(traded.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(traded);
    expect(useLivePageStore.getState().peakWallPaneEnabled).toBe(true);
    // 저장값은 이미 켜져 있었으므로 그대로다 — 클릭이 연 것은 마스터다.
    expect(useLivePageStore.getState().askPeakTradedPaneEnabled).toBe(true);
    expect(screen.getByTestId('settings-toggle-askPeakTradedPaneEnabled').getAttribute('aria-checked')).toBe('true');
  });

  /**
   * pane 이 없으면 요약도 **없다고 말한다** — 저장돼 있는 칸을 세지 않는다.
   *
   * 그 값들은 다음 클릭에 버려지기 때문이다(여는 클릭이 나머지 다섯을 함께 닫는다).
   * **막는 방향**: 요약이 「되켜면 이게 돌아온다」고 약속하는 것 — 그 약속은 지켜지지
   * 않는다.
   */
  it('pane 이 없으면 요약은 저장된 칸을 세지 않는다', () => {
    useLivePageStore.setState({
      peakWallPaneEnabled: false,
      askPeakTradedPaneEnabled: true,
      bidPeakAllWallPaneEnabled: true,
    });
    render(<PeakWallsConfig />);
    const summary = screen.getByTestId('peak-wall-pane-summary').textContent ?? '';
    expect(summary).toContain('pane 없음');
    expect(summary).not.toContain('매도 체결된 벽');
  });

  /**
   * **pane 의 존재 = 여섯 칸의 OR** (2026-08-27, 사용자 결정). 칸이 하나라도 켜지면
   * pane 이 있고, 여섯이 다 꺼지면 없다.
   *
   * **막는 방향** 둘: (1) 옛 게이트(`disabled`)가 되살아나는 것. (2) 마지막 칸을 껐는데
   * pane 이 남는 것 — 빈 pane 이 화면 부동산을 먹는다.
   */
  it('마지막 칸을 끄면 pane 이 사라지고, 켜면 생긴다', () => {
    useLivePageStore.setState({
      peakWallPaneEnabled: false,
      askPeakTradedPaneEnabled: false,
      askPeakUnreachedPaneEnabled: false,
      askPeakAllWallPaneEnabled: false,
      bidPeakTradedPaneEnabled: false,
      bidPeakUnreachedPaneEnabled: false,
      bidPeakAllWallPaneEnabled: false,
    });
    render(<PeakWallsConfig />);
    const traded = screen.getByTestId('settings-toggle-askPeakTradedPaneEnabled');
    expect(traded).not.toBeDisabled();

    fireEvent.click(traded);
    expect(useLivePageStore.getState().askPeakTradedPaneEnabled).toBe(true);
    expect(useLivePageStore.getState().peakWallPaneEnabled).toBe(true);

    fireEvent.click(traded);
    expect(useLivePageStore.getState().askPeakTradedPaneEnabled).toBe(false);
    expect(useLivePageStore.getState().peakWallPaneEnabled).toBe(false);
  });

  /**
   * 판정은 **여섯 전부**이지 화면에 보이는 셋이 아니다. pane 은 매도·매수가 공유하는
   * 하나라, 매수 칸이 살아 있는 동안 매도 셋을 다 꺼도 pane 은 남아야 한다.
   *
   * **막는 방향**: 판정이 「고른 방향의 셋」으로 좁아지는 것 — 그러면 매도를 비우는
   * 순간 매수 계단이 함께 사라진다.
   */
  it('반대 방향 칸이 살아 있으면 이쪽을 다 꺼도 pane 이 남는다', () => {
    useLivePageStore.setState({
      peakWallPaneEnabled: true,
      askPeakTradedPaneEnabled: true,
      askPeakUnreachedPaneEnabled: false,
      askPeakAllWallPaneEnabled: false,
      bidPeakTradedPaneEnabled: true,
      bidPeakUnreachedPaneEnabled: false,
      bidPeakAllWallPaneEnabled: false,
    });
    render(<PeakWallsConfig />);

    fireEvent.click(screen.getByTestId('settings-toggle-askPeakTradedPaneEnabled'));
    // 매도는 이제 셋 다 꺼졌지만 매수 체결된 벽이 남아 있다.
    expect(useLivePageStore.getState().peakWallPaneEnabled).toBe(true);
    // 그 사실이 화면에 있어야 한다 — 매수 칸은 이 방향 화면에 보이지 않는다.
    expect(screen.getByTestId('peak-wall-pane-summary').textContent).toContain('매수 체결된 벽');

    fireEvent.click(screen.getByRole('button', { name: '매수 설정 열기' }));
    fireEvent.click(screen.getByTestId('settings-toggle-bidPeakTradedPaneEnabled'));
    expect(useLivePageStore.getState().peakWallPaneEnabled).toBe(false);
  });

  /**
   * **닫혀 있던 pane 을 여는 클릭은 그 칸 하나만 넣는다.**
   *
   * 공장값이 양방향 체결된 벽 슬롯을 켜 둔 채라, 마스터만 열면 「미도달 벽 하나를 켰는데
   * 계단이 셋 뜨는」 일이 생긴다. **막는 방향**: 접혀 있던 저장값이 arm 과 함께 되살아나
   * 켜기와 끄기의 대칭이 깨지는 것.
   */
  it('닫혀 있던 pane 을 여는 클릭은 저장된 다른 칸을 되살리지 않는다', () => {
    useLivePageStore.setState({
      peakWallPaneEnabled: false,
      askPeakTradedPaneEnabled: true,   // 공장값 — 접혀 있어 화면엔 꺼짐
      bidPeakTradedPaneEnabled: true,   // 〃
      askPeakUnreachedPaneEnabled: false,
    });
    render(<PeakWallsConfig />);

    fireEvent.click(screen.getByTestId('settings-toggle-askPeakUnreachedPaneEnabled'));
    const after = useLivePageStore.getState();
    expect(after.peakWallPaneEnabled).toBe(true);
    expect(after.askPeakUnreachedPaneEnabled).toBe(true);
    expect(after.askPeakTradedPaneEnabled).toBe(false);
    expect(after.bidPeakTradedPaneEnabled).toBe(false);
    expect(screen.getByTestId('peak-wall-pane-summary').textContent).toBe('1칸: 매도 미도달 벽');
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
