import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HogaMissingNotice } from './HogaMissingNotice';

describe('HogaMissingNotice', () => {
  it('안내할 게 없으면 아무것도 그리지 않는다', () => {
    render(<HogaMissingNotice text={null} />);
    expect(screen.queryByTestId('hoga-missing-notice')).toBeNull();
  });

  it('문구를 표시한다', () => {
    render(<HogaMissingNotice text="NXT 호가 기록 없음" />);
    expect(screen.getByTestId('hoga-missing-notice')).toHaveTextContent('NXT 호가 기록 없음');
  });

  // 이 알림의 존재 이유 — 빈 pane 을 고장으로 읽지 않게 하는 것. 시각 문구는 차트를
  // 가리지 않게 한 줄이라, "왜 비었고 대신 무엇이 보이는지" 는 라벨이 진다.
  it('빈 이유와 화면 상태를 접근성 라벨로 알린다', () => {
    render(<HogaMissingNotice text="NXT 호가 기록 없음" />);
    const label = screen.getByTestId('hoga-missing-notice').getAttribute('aria-label') ?? '';
    expect(label).toContain('데이터가 없어');
    expect(label).toContain('캔들만 표시');
  });

  it('크로스헤어를 가리지 않도록 포인터 이벤트를 받지 않는다', () => {
    render(<HogaMissingNotice text="호가 기록 없음" />);
    expect(screen.getByTestId('hoga-missing-notice')).toHaveStyle({ pointerEvents: 'none' });
  });

  it('시간축이 보이면 그 위로 띄운다', () => {
    const { rerender } = render(<HogaMissingNotice text="x" timeAxisVisible />);
    const withAxis = screen.getByTestId('hoga-missing-notice').style.bottom;
    rerender(<HogaMissingNotice text="x" timeAxisVisible={false} />);
    const withoutAxis = screen.getByTestId('hoga-missing-notice').style.bottom;
    expect(withAxis).not.toBe(withoutAxis);
    expect(withAxis).toContain('px');  // 시간축 높이가 계산에 들어간다
  });

  // 둘은 동시에 뜰 수 있다(창이 작고 + 기록도 없음). 겹치면 둘 다 못 읽는다.
  it('아래에 다른 알림이 있으면 한 칸 밀어 올린다', () => {
    const { rerender } = render(<HogaMissingNotice text="x" stacked={false} />);
    const flat = screen.getByTestId('hoga-missing-notice').style.bottom;
    rerender(<HogaMissingNotice text="x" stacked />);
    const stacked = screen.getByTestId('hoga-missing-notice').style.bottom;
    expect(stacked).not.toBe(flat);
    // 하드코딩 px 가 아니라 spacing 토큰으로 민다(DESIGN.md).
    expect(stacked).toContain('var(--space-xl)');
  });
});
