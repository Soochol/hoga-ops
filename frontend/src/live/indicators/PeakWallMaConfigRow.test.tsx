import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import PeakWallsConfig from './PeakWallsConfig';

/** 「지표」 모달의 토글 행은 `IndicatorPrefRows toggleKeys={[...]}` 에 **명시적으로**
 *  등록해야 나온다 — `CHART_TOGGLES` 에 넣는 것만으로는 안 그려진다. 기간 노브는 다시
 *  `CHART_NUMERIC_PREFS` 의 `enabledBy` 로 그 토글에 묶여야 딸려 온다. 둘 중 하나만
 *  틀려도 **옵션이 조용히 화면에서 사라지고**, 그러면 사용자에겐 기능이 없는 것과
 *  구별되지 않는다(같은 사고의 선례: `TickNormalizeConfigRow.test.tsx`).
 *
 *  2026-08-26 파이프라인 전환 뒤에는 그 한 벌이 **단계 ③(후보 기준) + ④(표현)** 로
 *  갈라져 앉는다. 표면 다섯이 성격으로 둘(캔들 위 셋 · 랭킹 참여 둘)로 나뉘었으므로
 *  이 파일도 그 두 구획을 각각 잰다 — 한쪽 구획을 통째로 빠뜨려도 다른 쪽이 통과하는
 *  일이 없게.
 *
 *  **막는 방향**: 한 칸을 골랐을 때 존에 **그 칸의 것만** 있는 것. 계열·방향 스코프를
 *  못 박는 이유는 그대로다 — 「기준 이동평균 기간」 이라는 이름의 노브가 방향당 셋이라,
 *  스코프 없이 집으면 하나만 배선돼 있어도 통과한다. */
const FAMILIES = [
  { id: 'Traded', label: '체결된 벽' },
  { id: 'Unreached', label: '미도달 벽' },
  { id: 'AllWall', label: '전체 최대벽' },
] as const;

describe('당일 최대벽 — 고른 칸의 세부 설정(표면 다섯 + MA 필터 둘 + 기간 둘)', () => {
  afterEach(cleanup);

  // 표면 다섯이 **두 구획**으로 갈라졌다. 구획 하나를 통째로 빠뜨리는 실수를 잡으려면
  // 소제목이 둘 다 있는지도 함께 재야 한다 — 키만 세면 어느 구획에 있든 통과한다.
  it('표면 다섯은 「캔들 위」와 「랭킹 참여」 두 구획으로 앉는다', () => {
    render(<PeakWallsConfig />);
    expect(screen.getByText('캔들 위')).toBeTruthy();
    expect(screen.getByText('랭킹 참여')).toBeTruthy();
  });

  it('매도 — 칸을 고르면 그 계열의 표면·필터·기간이 한 벌씩 선다', () => {
    render(<PeakWallsConfig />);
    fireEvent.click(screen.getByRole('button', { name: '매도 설정 열기' }));

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
    fireEvent.click(screen.getByRole('button', { name: '매수 설정 열기' }));

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
