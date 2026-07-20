import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { DrawingMenu } from './DrawingMenu';
import { useDrawingsStore, drawingScopeFor } from '../state/drawings';

const CODE = '005930';
const TF = '1m' as const;

function openMenu() {
  return userEvent.click(screen.getByTestId('drawing-menu-trigger'));
}

describe('DrawingMenu', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
  });

  it('lists 선택 plus every drawable tool, then 자석 and 모두 지우기', async () => {
    render(<DrawingMenu code={CODE} timeframe={TF} />);
    await openMenu();

    const menu = screen.getByTestId('drawing-menu');
    for (const label of ['선택', '수평선', '수직선', '추세선', '사각형', '측정자', '텍스트', '연필', '지우개']) {
      expect(within(menu).getByRole('menuitemradio', { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(within(menu).getByRole('menuitemcheckbox', { name: /자석/ })).toBeInTheDocument();
    expect(within(menu).getByTestId('drawing-menu-clear')).toBeInTheDocument();
  });

  // 레일이 사라지며 "눌린 버튼" 활성 표시도 사라졌다 — 트리거가 그 역할을 대신
  // 하지 않으면 연필을 켜둔 걸 잊고 차트를 클릭하는 사고가 난다(#760 결정 4).
  it('turns the trigger into a status indicator while a tool is active', async () => {
    render(<DrawingMenu code={CODE} timeframe={TF} />);
    expect(screen.getByTestId('drawing-menu-trigger')).toHaveTextContent('그리기');

    await openMenu();
    await userEvent.click(screen.getByRole('menuitemradio', { name: /연필/ }));

    const trigger = screen.getByTestId('drawing-menu-trigger');
    expect(trigger).toHaveTextContent('연필');
    expect(trigger).toHaveAttribute('aria-label', '그리기: 연필');
    expect(useDrawingsStore.getState().activeTool).toBe('pencil');
  });

  it('returns to 선택 from the menu, clearing the active indicator', async () => {
    useDrawingsStore.getState().setActiveTool('pencil');
    render(<DrawingMenu code={CODE} timeframe={TF} />);

    await openMenu();
    await userEvent.click(screen.getByRole('menuitemradio', { name: /선택/ }));

    expect(useDrawingsStore.getState().activeTool).toBe('select');
    expect(screen.getByTestId('drawing-menu-trigger')).toHaveTextContent('그리기');
  });

  it('toggles 자석 without closing the menu', async () => {
    render(<DrawingMenu code={CODE} timeframe={TF} />);
    await openMenu();

    const before = useDrawingsStore.getState().defaults.magnet;
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: /자석/ }));

    expect(useDrawingsStore.getState().defaults.magnet).toBe(!before);
    expect(screen.getByTestId('drawing-menu')).toBeInTheDocument();
  });

  // scope 는 종목×봉 슬롯이라, 지우기는 "지금 이 창의 이 봉" 만 건드려야 한다.
  it('clears only the scope it was given', async () => {
    const scope = drawingScopeFor(CODE, TF)!;
    const other = drawingScopeFor('000660', TF)!;
    const store = useDrawingsStore.getState();
    store.importDrawings(scope, [{ kind: 'hline', id: 'a', price: 1, paneId: 'candle' } as never]);
    store.importDrawings(other, [{ kind: 'hline', id: 'b', price: 2, paneId: 'candle' } as never]);

    render(<DrawingMenu code={CODE} timeframe={TF} />);
    await openMenu();
    await userEvent.click(screen.getByTestId('drawing-menu-clear'));

    expect(useDrawingsStore.getState().drawingsFor(scope)).toHaveLength(0);
    expect(useDrawingsStore.getState().drawingsFor(other)).toHaveLength(1);
  });

  it('disables 모두 지우기 when there is no scope (no symbol)', async () => {
    render(<DrawingMenu code={null} timeframe={TF} />);
    await openMenu();

    expect(screen.getByTestId('drawing-menu-clear')).toBeDisabled();
  });

  it('drops the trigger label when showLabel is false', () => {
    render(<DrawingMenu code={CODE} timeframe={TF} showLabel={false} />);

    expect(screen.getByTestId('drawing-menu-trigger')).not.toHaveTextContent('그리기');
    expect(screen.getByTestId('drawing-menu-trigger')).toHaveAttribute('aria-label', '그리기');
  });
});
