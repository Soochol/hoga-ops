import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import PeakWallsConfig from './PeakWallsConfig';

/** 「지표」 모달의 토글 행은 `IndicatorPrefRows toggleKeys={[...]}` 에 **명시적으로**
 *  등록해야 나온다 — `CHART_TOGGLES` 에 넣는 것만으로는 안 그려진다. 기간 노브는 다시
 *  `CHART_NUMERIC_PREFS` 의 `enabledBy` 로 그 토글에 묶여야 딸려 온다. 둘 중 하나만
 *  틀려도 **옵션이 조용히 화면에서 사라지고**, 그러면 사용자에겐 기능이 없는 것과
 *  구별되지 않는다(같은 사고의 선례: `TickNormalizeConfigRow.test.tsx`).
 *
 *  2026-08-26 매트릭스 전환으로 **어포던스가 바뀌었다**. 종전엔 계열 카드 셋이 각자
 *  접히는 「세부 설정」을 품었고 이 파일은 "펼치기 전엔 안 보인다" 를 함께 쟀다. 이제
 *  선택이 항상 하나라 존도 하나이고 상시 펼쳐져 있다 — 접기가 사라졌으므로 그 단언도
 *  사라진다. 대신 **더 강한 것**을 잰다: 한 칸을 고르면 존에 **그 칸의 것만** 있다.
 *  종전 구조에서는 세 카드를 다 펼치면 세 벌이 동시에 화면에 있었다.
 *
 *  계열·방향 스코프를 못 박는 이유는 그대로다 — 「기준 이동평균 기간」 이라는 이름의
 *  노브가 방향당 셋이라, 스코프 없이 집으면 하나만 배선돼 있어도 통과한다. */
const FAMILIES = [
  { id: 'Traded', label: '체결된 벽' },
  { id: 'Unreached', label: '미도달 벽' },
  { id: 'AllWall', label: '전체 최대벽' },
] as const;

describe('당일 최대벽 — 고른 칸의 세부 설정(표면 다섯 + MA 필터 둘 + 기간 둘)', () => {
  afterEach(cleanup);

  it('매도 — 칸을 고르면 그 계열의 표면·필터·기간이 한 벌씩 선다', () => {
    render(<PeakWallsConfig />);

    for (const family of FAMILIES) {
      fireEvent.click(screen.getByRole('button', { name: `매도 ${family.label}` }));
      const zone = within(screen.getByTestId(`peak-wall-detail-zone-ask-${family.id}`));
      expect(zone.getByTestId(`settings-toggle-askPeak${family.id}HorizontalLineEnabled`)).toBeTruthy();
      expect(zone.getByTestId(`settings-toggle-askPeak${family.id}TimeMarkerEnabled`)).toBeTruthy();
      expect(zone.getByTestId(`settings-toggle-askPeak${family.id}LabelEnabled`)).toBeTruthy();
      expect(zone.getByTestId(`settings-toggle-askPeak${family.id}LegendCellEnabled`)).toBeTruthy();
      expect(zone.getByTestId(`settings-toggle-askPeak${family.id}RankArrowEnabled`)).toBeTruthy();
      expect(zone.getByTestId(`settings-toggle-askPeak${family.id}AboveMaEnabled`)).toBeTruthy();
      expect(zone.getByLabelText('기준 이동평균 기간')).toBeTruthy();
      expect(zone.getByTestId(`settings-toggle-askPeak${family.id}AboveDailyMaEnabled`)).toBeTruthy();
      expect(zone.getByLabelText('기준 일봉 이동평균 기간')).toBeTruthy();
    }
  });

  it('매수 — 매도판의 거울(MA 방향만 아래)', () => {
    render(<PeakWallsConfig />);

    for (const family of FAMILIES) {
      fireEvent.click(screen.getByRole('button', { name: `매수 ${family.label}` }));
      const zone = within(screen.getByTestId(`peak-wall-detail-zone-bid-${family.id}`));
      expect(zone.getByTestId(`settings-toggle-bidPeak${family.id}LabelEnabled`)).toBeTruthy();
      expect(zone.getByTestId(`settings-toggle-bidPeak${family.id}LegendCellEnabled`)).toBeTruthy();
      expect(zone.getByTestId(`settings-toggle-bidPeak${family.id}RankArrowEnabled`)).toBeTruthy();
      expect(zone.getByTestId(`settings-toggle-bidPeak${family.id}BelowMaEnabled`)).toBeTruthy();
      expect(zone.getByLabelText('기준 이동평균 기간')).toBeTruthy();
      expect(zone.getByTestId(`settings-toggle-bidPeak${family.id}BelowDailyMaEnabled`)).toBeTruthy();
      expect(zone.getByLabelText('기준 일봉 이동평균 기간')).toBeTruthy();
    }
  });

  // 존이 하나라는 것이 이 구조의 요점이다 — 고르지 않은 칸의 노브는 화면에 없어야
  // 「기준 이동평균 기간」 이 누구 것인지 묻지 않게 된다.
  it('고르지 않은 칸의 세부는 화면에 없다', () => {
    render(<PeakWallsConfig />);
    // 기본 선택은 매도 · 체결된 벽.
    expect(screen.getByTestId('peak-wall-detail-zone-ask-Traded')).toBeTruthy();
    expect(screen.queryByTestId('peak-wall-detail-zone-ask-Unreached')).toBeNull();
    expect(screen.queryByTestId('peak-wall-detail-zone-bid-Traded')).toBeNull();
    expect(screen.getAllByLabelText('기준 이동평균 기간')).toHaveLength(1);
  });
});
