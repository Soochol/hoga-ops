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

  it('flat 창은 안착 그림자가 없고, 포커스도 그림자를 승격하지 않는다', () => {
    // /study 통일(2026-07-23): live 창도 flat — 안착 shadow-panel 제거, 카드 배경은
    // 필드(--bg)와 동일. 포커스는 그림자가 아니라 헤더 틴트로만 표현(리프트 시에만
    // shadow-modal). 그림자는 간격(인셋) 도입 후 보이는 카드(첫 자식)에 얹힌다.
    const card = renderFrame(false, true).container.querySelector('[data-win="w1"] > div');

    expect(card).toHaveClass('bg-bg');
    expect(card).not.toHaveClass('bg-bg-card');
    expect(card).not.toHaveClass('shadow-panel');
    expect(card).not.toHaveClass('shadow-modal');
  });
});
