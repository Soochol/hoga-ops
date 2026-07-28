import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WindowFrame } from './WindowFrame';
import { MAX_GROUP, MIN_GROUP } from '../../state/workspace';
import { useDrawingsStore } from '../../state/drawings';
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

describe('WindowFrame 우클릭 → 그리기 도구 해제', () => {
  beforeEach(() => {
    useDrawingsStore.getState().setActiveTool('select');
  });

  /**
   * 리사이즈 핸들이 이 회귀의 핵심 표면이다. 핸들은 바깥 rect 를 쓰는 카드 밖 형제라
   * 차트 콘텐츠 오버레이가 못 덮고, 좌·우·하단 7~8px 띠를 가로챈다. 해제 핸들러가
   * 오버레이에만 있던 동안 이 띠에서의 우클릭은 도구도 안 풀고 네이티브 메뉴만 띄웠다
   * (그리고 그 메뉴가 다음 우클릭을 삼켜 "여러 번 눌러야" 로 보였다).
   */
  function handleOf(container: HTMLElement) {
    const handle = container.querySelector('[data-handle="s"]');
    if (!handle) throw new Error('south resize handle not found');
    return handle as HTMLElement;
  }

  it('차트 창은 리사이즈 핸들 위 우클릭에서도 select 로 되돌린다', () => {
    useDrawingsStore.getState().setActiveTool('pencil');
    const { container } = renderFrame(false, false, 'chart', null);

    const prevented = !fireEvent.contextMenu(handleOf(container));

    expect(prevented).toBe(true);
    expect(useDrawingsStore.getState().activeTool).toBe('select');
  });

  it('차트 창은 헤더 위 우클릭에서도 select 로 되돌린다', () => {
    useDrawingsStore.getState().setActiveTool('trendline');
    const { container } = renderFrame(false, false, 'chart', null);

    const header = container.querySelector('[data-handle="move"]');
    fireEvent.contextMenu(header!);

    expect(useDrawingsStore.getState().activeTool).toBe('select');
  });

  it('차트가 아닌 창은 우클릭을 가로채지 않는다', () => {
    useDrawingsStore.getState().setActiveTool('pencil');
    const { container } = renderFrame(false, false, 'book');

    const prevented = !fireEvent.contextMenu(handleOf(container));

    expect(prevented).toBe(false);
    expect(useDrawingsStore.getState().activeTool).toBe('pencil');
  });
});
