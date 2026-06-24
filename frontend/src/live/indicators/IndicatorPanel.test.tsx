import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import IndicatorPanel from './IndicatorPanel';
import { useLivePageStore } from '../../state/livePage';

describe('IndicatorPanel', () => {
  it('활성 10개 체크박스(비활성 0), 호가 5종 포함', () => {
    useLivePageStore.setState({ quoteTotalsEnabled: true, ratioEnabled: true, fillStrengthEnabled: true });
    render(<IndicatorPanel onClose={() => {}} />);
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(10); // 상단 5 + 호가 5(매도/매수 최대벽 포함), 회색 placeholder 삭제됨
    expect(checkboxes.filter((c) => (c as HTMLButtonElement).disabled)).toHaveLength(0);
    for (const name of ['총잔량', '호가비', '체결강도']) {
      const cb = screen.getByRole('checkbox', { name }) as HTMLButtonElement;
      expect(cb.disabled).toBe(false);
      expect(cb.getAttribute('aria-checked')).toBe('true'); // 기본 ON
    }
  });

  it('삭제된 placeholder는 더 이상 렌더되지 않는다', () => {
    render(<IndicatorPanel onClose={() => {}} />);
    for (const name of ['일목균형표', '볼린저밴드', '슈퍼트렌드', '매물대분석', '엔벨로프', '윌리엄스 프랙탈']) {
      expect(screen.queryByText(name)).toBeNull();
    }
  });

  it('"호가 지표" 서브헤더를 렌더', () => {
    render(<IndicatorPanel onClose={() => {}} />);
    expect(screen.getByText('호가 지표')).toBeTruthy();
    expect(screen.getByText('상단 지표')).toBeTruthy();
  });

  it('index capabilities hide every hoga indicator category', () => {
    render(<IndicatorPanel onClose={() => {}} capabilities={{ hogaPanes: false, investorNet: 'market', studySave: false }} />);
    expect(screen.queryByText('호가 지표')).toBeNull();
    for (const name of ['총잔량', '호가비', '체결강도', '당일 매도 최대벽', '당일 매수 최대벽']) {
      expect(screen.queryByRole('checkbox', { name })).toBeNull();
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.getByRole('checkbox', { name: '외국인 순매수량' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '기관 순매수량' })).toBeTruthy();
  });

  it('indices without investor support hide investor net categories too', () => {
    render(<IndicatorPanel onClose={() => {}} capabilities={{ hogaPanes: false, investorNet: 'none', studySave: false }} />);
    expect(screen.queryByRole('checkbox', { name: '외국인 순매수량' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: '기관 순매수량' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: '거래량' })).toBeTruthy();
  });

  it('당일 매도 최대벽은 호가 지표 그룹(체결강도 뒤)에 위치', () => {
    render(<IndicatorPanel onClose={() => {}} />);
    // 네비 라벨 버튼은 CATEGORIES 순서대로 렌더된다(체크박스는 role=checkbox라 제외).
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    const askPeak = labels.indexOf('당일 매도 최대벽');
    const fill = labels.indexOf('체결강도');
    const inst = labels.indexOf('기관 순매수량');
    expect(askPeak).toBeGreaterThan(fill); // 호가 그룹 안, 체결강도 뒤
    expect(askPeak).toBeGreaterThan(inst); // 상단 지표(기관 순매수량) 그룹 뒤
  });

  it('총잔량 토글 클릭 → quoteTotalsEnabled 반전', () => {
    useLivePageStore.setState({ quoteTotalsEnabled: true });
    render(<IndicatorPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: '총잔량' }));
    expect(useLivePageStore.getState().quoteTotalsEnabled).toBe(false);
  });

  it('호가비 라벨 클릭 → 우측에 RatioConfig(극단값 필터 토글) 노출', () => {
    render(<IndicatorPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '호가비' }));
    expect(screen.getByTestId('settings-toggle-ratioOutlierFilterEnabled')).toBeTruthy();
  });

  it('clicking 외국인 순매수량 toggles foreignNetEnabled', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({ foreignNetEnabled: false });
    render(<IndicatorPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: '외국인 순매수량' }));
    expect(useLivePageStore.getState().foreignNetEnabled).toBe(true);
  });

  it('clicking 기관 순매수량 toggles institutionNetEnabled', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({ institutionNetEnabled: false });
    render(<IndicatorPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: '기관 순매수량' }));
    expect(useLivePageStore.getState().institutionNetEnabled).toBe(true);
  });

  it('clicking 거래량 toggles volumeEnabled', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({ volumeEnabled: true });
    render(<IndicatorPanel onClose={() => {}} />);
    const vol = screen.getByRole('checkbox', { name: '거래량' }) as HTMLButtonElement;
    // 거래량은 active 카테고리 — 기본 켜짐(default true), 클릭하면 토글.
    expect(vol.disabled).toBe(false);
    fireEvent.click(vol);
    expect(useLivePageStore.getState().volumeEnabled).toBe(false);
    fireEvent.click(vol);
    expect(useLivePageStore.getState().volumeEnabled).toBe(true);
  });

  it('clicking 이동평균선 checkbox toggles movingAverageEnabled', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({ movingAverageEnabled: true });
    render(<IndicatorPanel onClose={() => {}} />);
    const ma = screen.getByRole('checkbox', { name: '이동평균선' });
    fireEvent.click(ma);
    expect(useLivePageStore.getState().movingAverageEnabled).toBe(false);
    fireEvent.click(ma);
    expect(useLivePageStore.getState().movingAverageEnabled).toBe(true);
  });

  it('renders MovingAverageConfig in the right pane', () => {
    render(<IndicatorPanel onClose={() => {}} />);
    expect(screen.getByText('지난 n일 동안 주가 평균값을 이은 선')).toBeTruthy();
  });

  it('clicking a category label navigates the right pane to that indicator detail', () => {
    render(<IndicatorPanel onClose={() => {}} />);
    // Default detail is 이동평균선.
    expect(screen.getByText(/지난 n일 동안/)).toBeTruthy();

    // 거래량 → 거래량 detail (MA detail gone). The label is a button; the
    // on/off control is the separate role=checkbox icon.
    fireEvent.click(screen.getByRole('button', { name: '거래량' }));
    expect(screen.getByText(/거래량을 막대로/)).toBeTruthy();
    expect(screen.queryByText(/지난 n일 동안/)).toBeNull();

    // 외국인 순매수량 → its detail.
    fireEvent.click(screen.getByRole('button', { name: '외국인 순매수량' }));
    expect(screen.getByText(/외국인.*순매수 수량/)).toBeTruthy();

    // 기관 순매수량 → its detail.
    fireEvent.click(screen.getByRole('button', { name: '기관 순매수량' }));
    expect(screen.getByText(/기관.*순매수 수량/)).toBeTruthy();
  });

  it('거래량 카테고리 이동 후 체결강도 누적 토글이 노출된다', () => {
    render(<IndicatorPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '거래량' }));
    expect(screen.getByTestId('settings-toggle-volumeFillStrengthCumulative')).toBeTruthy();
    expect(screen.getByText('거래량 — 체결강도 누적')).toBeTruthy();
  });

  it('navigating to a category does NOT toggle its master switch', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({ volumeEnabled: true });
    render(<IndicatorPanel onClose={() => {}} />);
    // Clicking the label navigates only — the checkbox is the toggle.
    fireEvent.click(screen.getByRole('button', { name: '거래량' }));
    expect(useLivePageStore.getState().volumeEnabled).toBe(true);
  });

  it('Escape calls onClose', () => {
    const onClose = vi.fn();
    render(<IndicatorPanel onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('✕ button calls onClose', () => {
    const onClose = vi.fn();
    render(<IndicatorPanel onClose={onClose} />);
    // Two "닫기" buttons exist: header ✕ (aria-label) and footer text button.
    // Both wire to onClose — clicking either verifies the wire-up.
    const closeBtns = screen.getAllByRole('button', { name: '닫기' });
    expect(closeBtns.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(closeBtns[0]);
    expect(onClose).toHaveBeenCalled();
  });

  it('backdrop click calls onClose, inside click does not', () => {
    const onClose = vi.fn();
    render(<IndicatorPanel onClose={onClose} />);
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
    // "이동평균선" appears both as a nav button label and as the MA config h3.
    // The nav button is the first occurrence; click its parent for an inside-content check.
    const navLabel = screen.getAllByText('이동평균선')[0];
    fireEvent.click(navLabel.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('당일 매도 최대벽 카테고리 토글', () => {
    useLivePageStore.setState({ askPeakEnabled: false });
    render(<IndicatorPanel onClose={() => {}} />);
    const cb = screen.getByRole('checkbox', { name: '당일 매도 최대벽' });
    fireEvent.click(cb);
    expect(useLivePageStore.getState().askPeakEnabled).toBe(true);
  });

  it('매도 최대벽 선택 시 스타일 pane(MAStylePicker) 표시', () => {
    render(<IndicatorPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '당일 매도 최대벽' }));
    expect(screen.getByRole('button', { name: '체결가격 기준 최대벽 스타일 선택' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '미체결 포함 최대벽 스타일 선택' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '보이는 영역 최대벽 스타일 선택' })).toBeTruthy();
  });

  it('당일 매수 최대벽 카테고리 토글', () => {
    useLivePageStore.setState({ bidPeakEnabled: false });
    render(<IndicatorPanel onClose={() => {}} />);
    const cb = screen.getByRole('checkbox', { name: '당일 매수 최대벽' });
    fireEvent.click(cb);
    expect(useLivePageStore.getState().bidPeakEnabled).toBe(true);
  });

  it('매수 최대벽 선택 시 스타일 pane과 토글 표시', () => {
    render(<IndicatorPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '당일 매수 최대벽' }));
    expect(screen.getByRole('button', { name: '체결가격 기준 최대벽 스타일 선택' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '미체결 포함 최대벽 스타일 선택' })).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-bidPeakIntraMax')).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-bidPeakShowAllPrices')).toBeTruthy();
  });

  it('일봉 이동평균선 체크박스 토글 → dailyMovingAverageEnabled 반전', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({ dailyMovingAverageEnabled: false });
    render(<IndicatorPanel onClose={() => {}} />);
    const cb = screen.getByRole('checkbox', { name: '일봉 이동평균선' });
    fireEvent.click(cb);
    expect(useLivePageStore.getState().dailyMovingAverageEnabled).toBe(true);
  });

  it('일봉 이동평균선 라벨 클릭 → DailyMovingAverageConfig 노출', () => {
    render(<IndicatorPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '일봉 이동평균선' }));
    expect(screen.getByText(/일봉 종가 기준 이평선을 분봉 차트에 투영/)).toBeTruthy();
  });
});
