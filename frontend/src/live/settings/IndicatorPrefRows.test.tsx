import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import IndicatorPrefRows from './IndicatorPrefRows';
import { useChartPrefsStore } from '../../state/chartPrefs';

describe('IndicatorPrefRows', () => {
  afterEach(cleanup);

  it('주어진 토글 키의 ToggleRow를 렌더', () => {
    render(<IndicatorPrefRows toggleKeys={['surgeMarkerEnabled']} />);
    expect(screen.getByTestId('settings-toggle-surgeMarkerEnabled')).toBeTruthy();
  });

  it('enabledBy로 묶인 numeric을 함께 렌더', () => {
    useChartPrefsStore.setState({ surgeMarkerEnabled: true });
    render(<IndicatorPrefRows toggleKeys={['surgeMarkerEnabled']} />);
    expect(screen.getByText(/급증 근접 문턱/)).toBeTruthy();
  });

  it('토글 클릭 → chartPrefs 갱신', () => {
    useChartPrefsStore.setState({ ratioOutlierFilterEnabled: true });
    render(<IndicatorPrefRows toggleKeys={['ratioOutlierFilterEnabled']} />);
    // ToggleRow puts data-testid on the outer wrapper div; the onClick handler
    // lives on the inner role="switch" button — drill in to fire it.
    const row = screen.getByTestId('settings-toggle-ratioOutlierFilterEnabled');
    fireEvent.click(row.querySelector('[role="switch"]') as HTMLElement);
    expect(useChartPrefsStore.getState().ratioOutlierFilterEnabled).toBe(false);
  });

  // 하위 **boolean** 토글 — `enabledBy` 는 원래 numeric 에만 실효했고, 레지스트리에
  // 적힌 boolean 부모-자식 관계는 렌더가 무시했다. 아래 셋은 그 관계가 실제로
  // 화면에 반영되는지를 양방향으로 잰다(부모 ON/OFF 각각).
  it('하위 boolean 토글을 부모 행과 함께 렌더 — 부모 키만 넘겨도 따라온다', () => {
    useChartPrefsStore.setState({ highLowLabelsEnabled: true });
    render(<IndicatorPrefRows toggleKeys={['highLowLabelsEnabled']} />);
    expect(screen.getByTestId('settings-toggle-highLowHighLineEnabled')).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-highLowLowLineEnabled')).toBeTruthy();
  });

  it('부모 ON → 하위 토글 클릭 가능', () => {
    useChartPrefsStore.setState({ highLowLabelsEnabled: true, highLowHighLineEnabled: false });
    render(<IndicatorPrefRows toggleKeys={['highLowLabelsEnabled']} />);
    const row = screen.getByTestId('settings-toggle-highLowHighLineEnabled');
    const sw = row.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(sw.disabled).toBe(false);
    fireEvent.click(sw);
    expect(useChartPrefsStore.getState().highLowHighLineEnabled).toBe(true);
  });

  it('부모 OFF → 하위 토글 dim + 클릭 불가 (값은 보존)', () => {
    useChartPrefsStore.setState({ highLowLabelsEnabled: false, highLowHighLineEnabled: true });
    render(<IndicatorPrefRows toggleKeys={['highLowLabelsEnabled']} />);
    const row = screen.getByTestId('settings-toggle-highLowHighLineEnabled');
    const sw = row.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    // dim 은 부모 SettingsRow 의 opacity 클래스로 표현된다.
    expect(row.className).toContain('opacity-50');
    expect(useChartPrefsStore.getState().highLowHighLineEnabled).toBe(true);
  });

  it('하위 토글의 색·두께 행(LineStyleRow)이 그 아래 따라온다', () => {
    useChartPrefsStore.setState({ highLowLabelsEnabled: true, highLowHighLineEnabled: true });
    render(<IndicatorPrefRows toggleKeys={['highLowLabelsEnabled']} />);
    expect(screen.getByTestId('settings-linestyle-highLowHighLine')).toBeTruthy();
    expect(screen.getByTestId('settings-linestyle-highLowPriorLowLine')).toBeTruthy();
  });

  it('선 토글이 꺼져 있으면 그 색·두께 행은 dim (값은 보존)', () => {
    useChartPrefsStore.setState({
      highLowLabelsEnabled: true,
      highLowHighLineEnabled: false,
      highLowHighLineWidth: 3,
    });
    render(<IndicatorPrefRows toggleKeys={['highLowLabelsEnabled']} />);
    const row = screen.getByTestId('settings-linestyle-highLowHighLine');
    expect(row.className).toContain('opacity-50');
    expect(useChartPrefsStore.getState().highLowHighLineWidth).toBe(3);
  });

  it('선 토글이 켜져 있으면 dim 되지 않는다 (게이트 양방향)', () => {
    useChartPrefsStore.setState({ highLowLabelsEnabled: true, highLowHighLineEnabled: true });
    render(<IndicatorPrefRows toggleKeys={['highLowLabelsEnabled']} />);
    const row = screen.getByTestId('settings-linestyle-highLowHighLine');
    expect(row.className).not.toContain('opacity-50');
  });

  it('하위 토글이 자기 numeric 을 가지면 그것도 따라온다 (2단 중첩)', () => {
    // `quoteTotalsTickNormalize` 는 자식이면서 부모다 — surgeMarkerEnabled 아래에
    // 있으면서 확인 문턱 노브를 자기 아래에 단다. 1단만 처리하면 이 노브가 화면에서
    // 조용히 사라진다(실제로 그렇게 깨뜨려 봤다).
    useChartPrefsStore.setState({ surgeMarkerEnabled: true, quoteTotalsTickNormalize: true });
    render(<IndicatorPrefRows toggleKeys={['surgeMarkerEnabled']} />);
    expect(screen.getByTestId('settings-numeric-surgeTickConfirmPct')).toBeTruthy();
  });

  it('부모·자식을 함께 넘겨도 자식은 한 번만 렌더 (QuoteTotalsConfig 호출 형태)', () => {
    render(
      <IndicatorPrefRows
        toggleKeys={['surgeMarkerEnabled', 'quoteTotalsTickNormalize', 'quoteTotalsIntraMax']}
      />,
    );
    expect(screen.getAllByTestId('settings-toggle-quoteTotalsTickNormalize')).toHaveLength(1);
  });

  it('gated numeric input commits on Enter', () => {
    useChartPrefsStore.getState().resetToDefaults();
    useChartPrefsStore.setState({ surgeMarkerEnabled: true });
    render(<IndicatorPrefRows toggleKeys={['surgeMarkerEnabled']} />);
    const input = screen.getByTestId('settings-numeric-surgeApproachPct') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '90' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useChartPrefsStore.getState().surgeApproachPct).toBe(90);
  });
});
