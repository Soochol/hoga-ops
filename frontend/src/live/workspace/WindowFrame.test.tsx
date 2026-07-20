import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WindowFrame } from './WindowFrame';
import { MAX_GROUP, MIN_GROUP } from '../../state/workspace';

function renderFrame(paletteOpen: boolean, focused = false) {
  return render(
    <WindowFrame
      id="w1"
      kind="book"
      group={1}
      rect={{ x: 0, y: 0, w: 320, h: 240 }}
      zIndex={1}
      focused={focused}
      symbolLabel="삼성에스디에스"
      symbolCode="018260"
      paletteOpen={paletteOpen}
      onHandleDown={vi.fn()}
      onFocus={vi.fn()}
      onClose={vi.fn()}
      onTogglePalette={vi.fn()}
      onPickGroup={vi.fn()}
    >
      <div />
    </WindowFrame>,
  );
}

/** 팔레트 컨테이너 — 뱃지 트리거와 같은 숫자 라벨이라 range 로 좁혀야 한다. */
function paletteOf() {
  const palette = screen.getByRole('button', { name: '10' }).parentElement;
  if (!palette) throw new Error('palette not found');
  return palette as HTMLElement;
}

describe('WindowFrame 링크 그룹 팔레트', () => {
  it('열리면 MIN_GROUP..MAX_GROUP 전부를 버튼으로 낸다', () => {
    renderFrame(true);

    const palette = paletteOf();
    const labels = within(palette)
      .getAllByRole('button')
      .map((b) => b.textContent);

    expect(labels).toEqual(
      Array.from({ length: MAX_GROUP - MIN_GROUP + 1 }, (_, i) => String(i + MIN_GROUP)),
    );
  });

  it('팔레트 폭을 내용 기준으로 고정한다 (앵커 shrink-to-fit 붕괴 회귀 가드)', () => {
    renderFrame(true);

    // w-max 가 빠지면 16px 뱃지 앵커가 containing block 이라 팔레트가 눌리고,
    // grid-cols-5 의 minmax(0,1fr) 열이 0 폭이 되어 버튼 5개가 겹친다.
    const palette = paletteOf();
    expect(palette).toHaveClass('w-max');
    expect(palette).toHaveClass('grid-cols-5');
  });

  it('닫혀 있으면 팔레트를 렌더하지 않는다', () => {
    renderFrame(false);

    expect(screen.queryByRole('button', { name: '10' })).not.toBeInTheDocument();
  });
});

describe('WindowFrame 포커스 표시', () => {
  /** 헤더 밴드 — 드래그 핸들이 곧 포커스 틴트를 입는 요소다. */
  function headerOf(container: HTMLElement) {
    const header = container.querySelector('[data-handle="move"]');
    if (!header) throw new Error('header not found');
    return header as HTMLElement;
  }

  it('포커스된 창은 헤더 밴드에 선택 틴트를 입힌다', () => {
    const { container } = renderFrame(false, true);

    expect(headerOf(container)).toHaveClass('bg-tint-selection');
  });

  it('비포커스 창은 헤더 틴트 없이 카드 배경을 그대로 쓴다', () => {
    const { container } = renderFrame(false, false);

    expect(headerOf(container)).not.toHaveClass('bg-tint-selection');
  });

  it('포커스는 그림자 티어를 바꾸지 않는다 (전 창 shadow-panel 고정)', () => {
    // 이전엔 포커스가 shadow-modal 로 승격됐으나 헤더 틴트로 대체됐다.
    const focusedFrame = renderFrame(false, true).container.querySelector('[data-win="w1"]');

    expect(focusedFrame).toHaveClass('shadow-panel');
    expect(focusedFrame).not.toHaveClass('shadow-modal');
  });
});
