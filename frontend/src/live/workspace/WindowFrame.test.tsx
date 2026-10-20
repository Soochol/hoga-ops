import { render, screen, within, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { WindowFrame } from './WindowFrame';
import { WindowHeaderAction } from './WindowHeaderAction';
import { WindowSettingsPopover } from './WindowSettingsPopover';
import { MAX_GROUP, MIN_GROUP } from '../../state/workspace';
import type { WindowKind } from '../../state/workspace';

/** 차트 창은 `symbolCode` 가 있으면 TitleBarSymbolRow(react-query 구독)를 그린다 —
 *  프레임 크롬만 보는 테스트는 종목 없는 창으로 렌더해 QueryClient 의존을 피한다. */
function renderFrame(
  paletteOpen: boolean,
  focused = false,
  kind: WindowKind = 'book',
  symbolCode: string | null = '018260',
) {
  return render(
    <WindowFrame
      id="w1"
      kind={kind}
      group={1}
      rect={{ x: 0, y: 0, w: 320, h: 240 }}
      zIndex={1}
      focused={focused}
      symbolLabel="삼성에스디에스"
      symbolCode={symbolCode}
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

it('본문 소유 설정 액션은 자기 창 헤더에만 연결되고 처리 상태와 닫기를 유지한다', () => {
  function Content({ name }: { name: string }) {
    const [busy, setBusy] = useState(false);
    const [open, setOpen] = useState(false);
    return <div data-testid={`${name}-body`}>
      <button onClick={() => setBusy(value => !value)}>처리 상태 {name}</button>
      <WindowHeaderAction><WindowSettingsPopover title={`${name} 설정`} scope="이 창에 적용"
        open={open} onOpenChange={setOpen} disabled={busy} render={() => <input aria-label={`${name} 입력`} />} /></WindowHeaderAction>
    </div>;
  }
  const props = { kind: 'order' as const, group: 1 as const, rect: { x: 0, y: 0, w: 320, h: 240 },
    zIndex: 1, focused: false, symbolLabel: '삼성전자', symbolCode: '005930', paletteOpen: false,
    onHandleDown: vi.fn(), onFocus: vi.fn(), onClose: vi.fn(), onTogglePalette: vi.fn(), onPickGroup: vi.fn(), onToggleMaximize: vi.fn() };
  const view = render(<>{['첫째', '둘째'].map(name => <WindowFrame key={name} {...props} id={name}><Content name={name} /></WindowFrame>)}</>);
  for (const name of ['첫째', '둘째']) {
    const body = screen.getByTestId(`${name}-body`);
    const header = view.container.querySelector(`[data-win="${name}"] .live-window-titlebar`)!;
    const trigger = within(header as HTMLElement).getByRole('button', { name: `${name} 설정` });
    expect(within(body).queryByRole('button', { name: `${name} 설정` })).not.toBeInTheDocument();
    fireEvent.click(trigger);
    const input = screen.getByRole('textbox', { name: `${name} 입력` });
    fireEvent.change(input, { target: { value: '유지' } });
    fireEvent.click(screen.getByRole('button', { name: `처리 상태 ${name}` }));
    expect(trigger).toBeDisabled();
    expect(input).toHaveValue('유지');
    fireEvent.click(screen.getByRole('button', { name: `처리 상태 ${name}` }));
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  }
});

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

  it('live 창은 카드 배경과 짧은 안착 그림자를 사용한다', () => {
    const card = renderFrame(false, true).container.querySelector('[data-win="w1"] > div');

    expect(card).toHaveClass('bg-bg-card', 'window-shadow');
    expect(card).not.toHaveClass('bg-bg');
    expect(card).not.toHaveClass('shadow-panel');
    expect(card).not.toHaveClass('shadow-modal');
  });
});
