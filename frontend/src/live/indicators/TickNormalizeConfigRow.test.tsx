import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import QuoteTotalsConfig from './QuoteTotalsConfig';

/** 「지표」 모달의 토글 행은 `IndicatorPrefRows toggleKeys={[...]}` 에 **명시적으로**
 *  등록해야 나온다 — CHART_TOGGLES 에 넣는 것만으로는 안 그려진다. QuoteTotalsConfig 의
 *  주석이 경고하는 "켤 수는 있는데 아무것도 안 그려지는 유령 토글" 의 반대 방향 사고다:
 *  여기서는 **등록해 놓고 렌더 목록에 안 넣는 것**을 막는다. */
describe('호가단위 변화 보정 설정 행', () => {
  afterEach(cleanup);

  it('QuoteTotalsConfig 에 quoteTotalsTickNormalize 토글이 렌더된다', () => {
    render(<QuoteTotalsConfig />);
    expect(screen.getByTestId('settings-toggle-quoteTotalsTickNormalize')).toBeTruthy();
  });

  it('폭 변화 문턱 노브가 그 토글 아래에 딸려 온다', () => {
    // NumericPrefRow 는 CHART_NUMERIC_PREFS 의 enabledBy 로 자동으로 묶인다 —
    // enabledBy 를 잘못 적으면 노브가 엉뚱한 토글 아래로 가거나 아예 사라진다.
    render(<QuoteTotalsConfig />);
    expect(screen.getByLabelText(/호가단위 보정 — 폭 변화 문턱/)).toBeTruthy();
  });
});
