import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import AskPeakConfig from './AskPeakConfig';
import BidPeakConfig from './BidPeakConfig';

/** 「지표」 모달의 토글 행은 `IndicatorPrefRows toggleKeys={[...]}` 에 **명시적으로**
 *  등록해야 나온다 — `CHART_TOGGLES` 에 넣는 것만으로는 안 그려진다. 기간 노브는 다시
 *  `CHART_NUMERIC_PREFS` 의 `enabledBy` 로 그 토글에 묶여야 딸려 온다. 둘 중 하나만
 *  틀려도 **옵션이 조용히 화면에서 사라지고**, 그러면 사용자에겐 기능이 없는 것과
 *  구별되지 않는다(같은 사고의 선례: `TickNormalizeConfigRow.test.tsx`).
 *
 *  2026-08-25 부터 이 행들은 **계열마다** 한 벌씩이고 계열 카드의 접히는 「세부 설정」
 *  안에 산다. 그래서 아래 단언은 두 가지를 함께 지킨다:
 *
 *  1. 카드를 펼치기 전에는 안 보인다 → 펼치는 어포던스가 살아 있어야 한다.
 *  2. **어느 계열의 노브인지 못 박는다.** 「기준 이동평균 기간」 이라는 이름의 노브가 이제
 *     방향당 셋이라, 스코프 없이 `getAllByLabelText` 로 집으면 계열 하나만 제대로 배선돼
 *     있어도 통과한다 — 그 테스트는 아무것도 증명하지 않는다. */
const FAMILIES = [
  { family: 'Traded', card: 'TradedLineEnabled' },
  { family: 'Unreached', card: 'UnreachedLineEnabled' },
  { family: 'AllWall', card: 'AllWallLineEnabled' },
] as const;

describe('당일 최대벽 — 계열별 세부 설정(표면 셋 + MA 필터 둘 + 기간 둘)', () => {
  afterEach(cleanup);

  it('매도 — 계열 카드마다 자기 몫의 표면·필터·기간이 한 벌씩 선다', () => {
    render(<AskPeakConfig />);
    // 접힌 상태에서는 어느 계열의 것도 나와 있지 않다.
    expect(screen.queryByTestId('settings-toggle-askPeakTradedAboveMaEnabled')).toBeNull();

    for (const { family, card } of FAMILIES) {
      fireEvent.click(screen.getByTestId(`settings-toggle-askPeak${card}-details`));
      const panel = within(screen.getByTestId(`peak-wall-family-details-ask-${family}`));
      expect(panel.getByTestId(`settings-toggle-askPeak${family}LabelEnabled`)).toBeTruthy();
      expect(panel.getByTestId(`settings-toggle-askPeak${family}LegendCellEnabled`)).toBeTruthy();
      expect(panel.getByTestId(`settings-toggle-askPeak${family}RankArrowEnabled`)).toBeTruthy();
      expect(panel.getByTestId(`settings-toggle-askPeak${family}AboveMaEnabled`)).toBeTruthy();
      expect(panel.getByLabelText('기준 이동평균 기간')).toBeTruthy();
      expect(panel.getByTestId(`settings-toggle-askPeak${family}AboveDailyMaEnabled`)).toBeTruthy();
      expect(panel.getByLabelText('기준 일봉 이동평균 기간')).toBeTruthy();
    }
  });

  it('매수 — 매도판의 거울(MA 방향만 아래)', () => {
    render(<BidPeakConfig />);
    expect(screen.queryByTestId('settings-toggle-bidPeakTradedBelowMaEnabled')).toBeNull();

    for (const { family, card } of FAMILIES) {
      fireEvent.click(screen.getByTestId(`settings-toggle-bidPeak${card}-details`));
      const panel = within(screen.getByTestId(`peak-wall-family-details-bid-${family}`));
      expect(panel.getByTestId(`settings-toggle-bidPeak${family}LabelEnabled`)).toBeTruthy();
      expect(panel.getByTestId(`settings-toggle-bidPeak${family}LegendCellEnabled`)).toBeTruthy();
      expect(panel.getByTestId(`settings-toggle-bidPeak${family}RankArrowEnabled`)).toBeTruthy();
      expect(panel.getByTestId(`settings-toggle-bidPeak${family}BelowMaEnabled`)).toBeTruthy();
      expect(panel.getByLabelText('기준 이동평균 기간')).toBeTruthy();
      expect(panel.getByTestId(`settings-toggle-bidPeak${family}BelowDailyMaEnabled`)).toBeTruthy();
      expect(panel.getByLabelText('기준 일봉 이동평균 기간')).toBeTruthy();
    }
  });
});
