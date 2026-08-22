import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  HogaplaySourceChip,
  hogaplayGapFillSentence,
  hogaplayPeriodLabel,
  type HogaplayChipGapFill,
} from './HogaplaySourceChip';

describe('hogaplayPeriodLabel', () => {
  it('같은 날은 하루만 적는다', () => {
    expect(hogaplayPeriodLabel('20260821', '20260821')).toBe('08-21');
  });

  it('같은 해 안이면 연도를 접는다', () => {
    expect(hogaplayPeriodLabel('20260811', '20260821')).toBe('08-11~08-21');
  });

  // **해를 걸치면 접지 않는다.** 접으면 `08-20~07-09` 가 되어 끝이 시작보다 앞선
  // 것처럼 읽힌다 — `SavedRangeChip` 이 실측으로 발견한 것과 같은 함정.
  it('해를 걸치면 연도를 유지한다', () => {
    expect(hogaplayPeriodLabel('20250820', '20260709')).toBe('25-08-20~26-07-09');
  });
});

describe('HogaplaySourceChip', () => {
  it('실린 구간을 적고 × 로 해제한다', () => {
    const onClear = vi.fn();
    render(<HogaplaySourceChip range={{ fromDate: '20260811', toDate: '20260821' }} onClear={onClear} />);

    expect(screen.getByTestId('live-hogaplay-source-chip')).toHaveTextContent('hogaplay 08-11~08-21');
    fireEvent.click(screen.getByRole('button', { name: 'hogaplay 저장 데이터 해제' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  // 켜자마자 디스크 쿼리가 아직 안 왔을 때 `undefined~undefined` 가 뜨지 않아야 한다.
  it('아직 캔들이 없으면 날짜 없이 불러오는 중으로 뜬다', () => {
    render(<HogaplaySourceChip range={null} onClear={vi.fn()} />);
    const chip = screen.getByTestId('live-hogaplay-source-chip');
    expect(chip).toHaveTextContent('hogaplay 불러오는 중');
    expect(chip.textContent).not.toContain('undefined');
  });
});

/**
 * 키움 보충 요약 문장.
 *
 * **막는 방향**: ① 못 채운 것을 **뭉뚱그리는 것**(사유마다 사용자가 할 수 있는 일이
 * 다르다) ② 아무 일도 없었는데 문장을 붙이는 것 ③ 보충 중인데 완료처럼 말하는 것.
 *
 * **못 보는 것**: 이 문장이 실제로 `title`·`aria-label` 로 나가는지는 아래 컴포넌트
 * 테스트가, 개수가 훅 결과와 맞는지는 `ChartWindow` 배선이 소유한다.
 */
describe('hogaplayGapFillSentence', () => {
  const none: HogaplayChipGapFill = {
    filledCount: 0, unfillableCount: 0, rescaledCount: 0, deferredCount: 0, pending: false,
  };

  it('보충 요약이 없으면 아무 말도 하지 않는다', () => {
    expect(hogaplayGapFillSentence(undefined)).toBe('');
    expect(hogaplayGapFillSentence(none)).toBe('');
  });

  it('보충 중이면 완료처럼 말하지 않는다', () => {
    const s = hogaplayGapFillSentence({ ...none, filledCount: 2, pending: true });
    expect(s).toContain('보충하는 중');
    expect(s).not.toContain('보충했습니다');
  });

  it('못 채운 이유를 사유별로 가른다 — 뭉치면 "왜" 가 사라진다', () => {
    const s = hogaplayGapFillSentence({
      filledCount: 3, unfillableCount: 2, rescaledCount: 1, deferredCount: 4, pending: false,
    });
    expect(s).toContain('3일을 키움 분봉으로 보충');
    expect(s).toContain('2일은 키움 보유 기간');
    expect(s).toContain('1일은 수정주가 척도');
    expect(s).toContain('4일은 이번에 시도하지 않았습니다');
  });
});

describe('HogaplaySourceChip — 보충 요약', () => {
  it('시각 라벨은 늘리지 않고 툴팁에만 싣는다 — 헤더 폭 예산', () => {
    const gapFill: HogaplayChipGapFill = {
      filledCount: 3, unfillableCount: 0, rescaledCount: 0, deferredCount: 0, pending: false,
    };
    render(
      <HogaplaySourceChip
        range={{ fromDate: '20260811', toDate: '20260821' }}
        gapFill={gapFill}
        onClear={vi.fn()}
      />,
    );
    const chip = screen.getByTestId('live-hogaplay-source-chip');

    // 보이는 글자는 종전 그대로 — 여기 개수가 새면 접힘 임계 상수를 다시 재야 한다.
    expect(chip).toHaveTextContent('hogaplay 08-11~08-21');
    expect(chip.textContent).not.toContain('3일');
    // 툴팁·스크린리더는 읽는다.
    expect(chip.getAttribute('title')).toContain('3일을 키움 분봉으로 보충');
    expect(chip.getAttribute('aria-label')).toContain('3일을 키움 분봉으로 보충');
  });
});
