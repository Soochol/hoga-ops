import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HogaplaySourceButton } from './HogaplaySourceButton';
import { COMPACT_PADDING_INLINE } from './chartHeaderCompact';

function renderButton(props: Partial<Parameters<typeof HogaplaySourceButton>[0]> = {}) {
  const onToggle = vi.fn();
  render(
    <HogaplaySourceButton
      enabled={false}
      disabledReason={null}
      onToggle={onToggle}
      {...props}
    />,
  );
  return { btn: screen.getByRole('button', { name: 'hogaplay 저장 데이터로 보기' }), onToggle };
}

describe('HogaplaySourceButton', () => {
  // **양방향으로 잰다.** 한 방향만 보면 `onToggle(true)` 하드코딩도 초록이라
  // 해제 경로가 통째로 검증 밖에 남는다.
  it('꺼짐에서 누르면 켠다', () => {
    const { btn, onToggle } = renderButton({ enabled: false });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('켜짐에서 누르면 끈다', () => {
    const { btn, onToggle } = renderButton({ enabled: true });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  // 세 사유는 문구가 달라야 한다 — 같은 "비활성" 이라도 사용자가 할 일이 다르다
  // (종목을 고른다 / 봉을 바꾼다 / 저장뷰를 닫는다).
  it.each([
    ['no-code' as const, '지수는 지원하지 않습니다'],
    ['calendar-timeframe' as const, '분봉에서만 지원합니다'],
    ['saved-range' as const, '저장뷰 기간을 보는 중입니다'],
  ])('비활성 사유 %s 는 그 사유를 툴팁에 적는다', (reason, fragment) => {
    const { btn, onToggle } = renderButton({ disabledReason: reason });
    expect(btn).toBeDisabled();
    expect(btn.title).toContain(fragment);
    fireEvent.click(btn);
    expect(onToggle).not.toHaveBeenCalled();
  });

  // 라벨이 없으므로 접힘은 **패딩만** 따라간다(하트와 같은 계약). 이웃이 좁아질 때
  // 혼자 넓은 패딩을 유지하면 클릭 타겟이 어긋난다.
  it('compact 는 패딩만 좁힌다', () => {
    const { btn } = renderButton({ compact: true });
    expect(btn.style.paddingInline).toBe(COMPACT_PADDING_INLINE);
    expect(btn.textContent).toBe('');
  });

  it('평소에는 인라인 패딩을 걸지 않는다(클래스의 px-2 를 그대로 쓴다)', () => {
    const { btn } = renderButton({ compact: false });
    expect(btn.style.paddingInline).toBe('');
  });
});
