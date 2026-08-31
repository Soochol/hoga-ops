import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DailyMovingAverageConfig from './DailyMovingAverageConfig';
import { useLivePageStore, DEFAULT_DAILY_MAS, MA_SLOT_LIMIT } from '../../state/livePage';

describe('DailyMovingAverageConfig', () => {
  beforeEach(() => {
    useLivePageStore.setState({
      dailyMovingAverages: DEFAULT_DAILY_MAS.map((m) => ({ ...m })),
    });
  });

  it('renders one row per slot (period spinbutton)', () => {
    render(<DailyMovingAverageConfig />);
    expect(screen.getAllByRole('spinbutton')).toHaveLength(DEFAULT_DAILY_MAS.length);
  });

  it('"기간 추가" appends a daily slot', () => {
    render(<DailyMovingAverageConfig />);
    fireEvent.click(screen.getByRole('button', { name: /기간 추가/ }));
    expect(useLivePageStore.getState().dailyMovingAverages).toHaveLength(DEFAULT_DAILY_MAS.length + 1);
  });

  it('"기간 추가" disabled at MA_SLOT_LIMIT', () => {
    while (useLivePageStore.getState().dailyMovingAverages.length < MA_SLOT_LIMIT) {
      useLivePageStore.getState().addDailyMovingAverage();
    }
    render(<DailyMovingAverageConfig />);
    expect((screen.getByRole('button', { name: /기간 추가/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  // 종전의 `header + 분봉 전용 안내 표시` 는 사라졌다 — 제목도 「분봉 차트에서만
  // 표시됩니다」도 이제 카테고리 표의 description 이고, 패널 헤더가 그린다.
  // 그 자리의 가드는 `IndicatorPanel.test.tsx` 의 설명 텍스트 단언이다.

  // 마스터 토글과 타입 눈이 슬롯의 `enabled` 로 접혔다 — 토글 하나가 전 슬롯을
  // 함께 켜고 끄고, 체크 상태는 "켜진 슬롯이 있는가" 의 파생이다.
  it('상세 pane에서 일봉 MA 표시를 켜면 전 슬롯이 함께 켜진다', () => {
    render(<DailyMovingAverageConfig />);
    const toggle = screen.getByRole('switch', { name: '일봉 MA 표시' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);

    expect(useLivePageStore.getState().dailyMovingAverages.every((m) => m.enabled)).toBe(true);
  });

  it('켜진 상태에서 다시 누르면 전 슬롯이 함께 꺼진다', () => {
    useLivePageStore.getState().setAllDailyMovingAveragesEnabled(true);
    render(<DailyMovingAverageConfig />);
    const toggle = screen.getByRole('switch', { name: '일봉 MA 표시' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle);

    expect(useLivePageStore.getState().dailyMovingAverages.some((m) => m.enabled)).toBe(false);
  });
});
