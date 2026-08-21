import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SavedRangeChip } from './SavedRangeChip';

/**
 * 저장뷰 기간 칩의 계약.
 *
 * ── 이 파일이 막는 방향 ────────────────────────────────────────────────────
 * **「KRX」가 실제 고정과 어긋나는 것.** 밴드가 전 창에 뜨게 되면서(2026-08-21)
 * 칩도 전 창에 뜨는데, venue 고정은 **저장뷰가 가리키는 그 종목 창만**이다. 두 축이
 * 하나로 뭉개지면 둘 중 하나가 거짓이 된다:
 *  - 안 붙은 창에 「KRX」를 찍으면 → 거래소 표시가 거짓말
 *  - 붙은 창에 안 찍으면 → 사용자가 NXT 를 골라 둔 채 KRX 차트를 보면서 모른다
 *    (ADR-0144 §2 가 "한 화면이 두 시장" 으로 기록한 사고)
 *
 * ── 못 보는 것 ────────────────────────────────────────────────────────────
 * **어느 창이 `krxPinned=true` 를 받는가는 여기서 재지 않는다** — 그 판정은
 * `ChartWindow` 의 `isSavedRangeSubject` 소유다. 여기는 받은 값을 정직하게 그리는지만 본다.
 */
describe('SavedRangeChip', () => {
  const base = {
    label: '삼성전기',
    fromDate: '20260520',
    toDate: '20260626',
    notice: null,
    onClear: () => {},
  };

  it('기간을 MM-DD 로 줄여 보여준다', () => {
    render(<SavedRangeChip {...base} krxPinned />);
    expect(screen.getByTestId('live-saved-range-chip').textContent).toContain('05-20~06-26');
  });

  it('해를 걸치면 연도를 접지 않는다 — 접으면 끝이 시작보다 앞선 것처럼 읽힌다', () => {
    render(<SavedRangeChip {...base} fromDate="20240820" toDate="20250709" krxPinned />);
    expect(screen.getByTestId('live-saved-range-chip').textContent).toContain('24-08-20~25-07-09');
  });

  it('venue 가 고정된 창에서만 「KRX」를 병기한다', () => {
    render(<SavedRangeChip {...base} krxPinned />);
    expect(screen.getByTestId('live-saved-range-chip').textContent).toContain('KRX');
  });

  it('고정되지 않은 창에는 「KRX」를 찍지 않는다 — 찍으면 거래소 표시가 거짓말이 된다', () => {
    render(<SavedRangeChip {...base} krxPinned={false} />);
    expect(screen.getByTestId('live-saved-range-chip').textContent).not.toContain('KRX');
  });

  it('툴팁도 고정 여부에 따라 다른 사실을 말한다', () => {
    const { unmount } = render(<SavedRangeChip {...base} krxPinned />);
    expect(screen.getByTestId('live-saved-range-chip').getAttribute('title')).toContain('KRX 기준으로 고정');
    unmount();
    render(<SavedRangeChip {...base} krxPinned={false} />);
    expect(screen.getByTestId('live-saved-range-chip').getAttribute('title')).toContain('이 창의 선택을 따릅니다');
  });

  it('안내가 있으면 칩 문구가 안내로 바뀌고 상세는 툴팁에 실린다', () => {
    render(
      <SavedRangeChip
        {...base}
        krxPinned
        notice={{ text: '저장 구간이 분봉 범위 밖', detail: '분봉은 최근 …' }}
      />,
    );
    const chip = screen.getByTestId('live-saved-range-chip');
    expect(chip.textContent).toContain('저장 구간이 분봉 범위 밖');
    expect(chip.getAttribute('title')).toContain('분봉은 최근');
  });

  it('× 로 해제한다 — /live 에 라이브 복귀 컨트롤이 따로 없어 이것이 유일한 문이다', async () => {
    const onClear = vi.fn();
    render(<SavedRangeChip {...base} krxPinned onClear={onClear} />);
    await userEvent.click(screen.getByRole('button', { name: '저장뷰 기간 표시 해제' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
