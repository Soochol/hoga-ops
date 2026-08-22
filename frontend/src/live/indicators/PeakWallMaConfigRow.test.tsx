import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import AskPeakConfig from './AskPeakConfig';
import BidPeakConfig from './BidPeakConfig';

/** 「지표」 모달의 토글 행은 `IndicatorPrefRows toggleKeys={[...]}` 에 **명시적으로**
 *  등록해야 나온다 — `CHART_TOGGLES` 에 넣는 것만으로는 안 그려진다. 기간 노브는 다시
 *  `CHART_NUMERIC_PREFS` 의 `enabledBy` 로 그 토글에 묶여야 딸려 온다. 둘 중 하나만
 *  틀려도 **옵션이 조용히 화면에서 사라지고**, 그러면 사용자에겐 기능이 없는 것과
 *  구별되지 않는다(같은 사고의 선례: `TickNormalizeConfigRow.test.tsx`). */
describe('당일 최대벽 — 이동평균선 필터 설정 행(분봉·일봉 둘 다)', () => {
  afterEach(cleanup);

  it('매도 서브탭에 「이동평균선 위 벽만」 토글과 기간 노브가 함께 렌더된다', () => {
    render(<AskPeakConfig embedded />);
    expect(screen.getByTestId('settings-toggle-askPeakAboveMaEnabled')).toBeTruthy();
    expect(screen.getByLabelText('기준 이동평균 기간')).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-askPeakAboveDailyMaEnabled')).toBeTruthy();
    expect(screen.getByLabelText('기준 일봉 이동평균 기간')).toBeTruthy();
  });

  it('매수 서브탭에 「이동평균선 아래 벽만」 토글과 기간 노브가 함께 렌더된다', () => {
    render(<BidPeakConfig embedded />);
    expect(screen.getByTestId('settings-toggle-bidPeakBelowMaEnabled')).toBeTruthy();
    expect(screen.getByLabelText('기준 이동평균 기간')).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-bidPeakBelowDailyMaEnabled')).toBeTruthy();
    expect(screen.getByLabelText('기준 일봉 이동평균 기간')).toBeTruthy();
  });
});
