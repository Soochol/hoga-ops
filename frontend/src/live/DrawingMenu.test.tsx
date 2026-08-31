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

  // 메뉴 항목은 더 이상 직접 지우지 않는다 — 확인 요청만 낸다(팝업은
  // DrawingClearConfirmHost). scope 는 종목×봉 슬롯이라, 그 요청이 "지금 이
  // 창의 이 봉" 을 가리키는지가 이 테스트의 본론이다.
  it('requests confirmation for the scope it was given, deleting nothing yet', async () => {
    const scope = drawingScopeFor(CODE, TF)!;
    const other = drawingScopeFor('000660', TF)!;
    const store = useDrawingsStore.getState();
    store.importDrawings(scope, [{ kind: 'hline', id: 'a', price: 1, paneId: 'candle' } as never]);
    store.importDrawings(other, [{ kind: 'hline', id: 'b', price: 2, paneId: 'candle' } as never]);

    render(<DrawingMenu code={CODE} timeframe={TF} />);
    await openMenu();
    await userEvent.click(screen.getByTestId('drawing-menu-clear'));

    expect(useDrawingsStore.getState().clearConfirm).toEqual({ scope, count: 1, lockedCount: 0 });
    expect(useDrawingsStore.getState().drawingsFor(scope)).toHaveLength(1);
    expect(useDrawingsStore.getState().drawingsFor(other)).toHaveLength(1);
  });

  // 단축키와 메뉴가 같은 게이트를 통과하려면 힌트도 메뉴에 있어야 한다 — 도구
  // 항목들이 ⌥키를 노출하는 것과 같은 문법.
  it('shows the ⌥C hint on 모두 지우기', async () => {
    render(<DrawingMenu code={CODE} timeframe={TF} />);
    await openMenu();

    expect(screen.getByTestId('drawing-menu-clear')).toHaveTextContent('⌥C');
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

  // ── 모두 잠금 / 해제 (ADR-0164 후속) ────────────────────────────────────
  describe('모두 잠금', () => {
    const SCOPE = drawingScopeFor(CODE, TF)!;
    const s = () => useDrawingsStore.getState();
    const mk = (id: string, price: number) => ({
      id, kind: 'hline' as const, price, color: '#FFD60A',
      width: 1.5, lineStyle: 'solid' as const, paneId: 'candle' as const,
    });

    it('도형이 없으면 비활성이다 — 잠글 것이 없다', async () => {
      render(<DrawingMenu code={CODE} timeframe={TF} />);
      await openMenu();
      expect(screen.getByTestId('drawing-menu-lock-all')).toBeDisabled();
    });

    it('하나라도 안 잠겼으면 라벨이 「모두 잠금」이고 누르면 전부 잠근다', async () => {
      s().add(SCOPE, mk('h1', 100));
      s().add(SCOPE, mk('h2', 200));
      render(<DrawingMenu code={CODE} timeframe={TF} />);
      await openMenu();

      const item = screen.getByTestId('drawing-menu-lock-all');
      expect(item).toHaveTextContent('모두 잠금');
      await userEvent.click(item);

      expect(s().drawingsFor(SCOPE).every((d) => d.locked === true)).toBe(true);
    });

    // 라벨이 **다음에 할 일**을 말해야 한다 — 항목을 둘로 나누면 둘 중 하나는
    // 항상 아무 일도 안 하는 죽은 항목이 된다.
    it('전부 잠겼으면 라벨이 「모두 잠금 해제」로 바뀌고 누르면 전부 푼다', async () => {
      s().add(SCOPE, mk('h1', 100));
      s().setLockedAll(SCOPE, true);
      render(<DrawingMenu code={CODE} timeframe={TF} />);
      await openMenu();

      const item = screen.getByTestId('drawing-menu-lock-all');
      expect(item).toHaveTextContent('모두 잠금 해제');
      await userEvent.click(item);

      expect(s().drawingsFor(SCOPE).every((d) => d.locked === undefined)).toBe(true);
    });

    it('부분 잠금이면 개수를 함께 보여 준다', async () => {
      s().add(SCOPE, mk('h1', 100));
      s().add(SCOPE, mk('h2', 200));
      s().add(SCOPE, mk('h3', 300));
      s().update(SCOPE, 'h2', { locked: true });
      render(<DrawingMenu code={CODE} timeframe={TF} />);
      await openMenu();

      const item = screen.getByTestId('drawing-menu-lock-all');
      expect(item).toHaveTextContent('모두 잠금');
      expect(item).toHaveTextContent('1/3');
    });

    it('0/N 과 N/N 에는 개수를 붙이지 않는다 — 라벨이 이미 말한다', async () => {
      s().add(SCOPE, mk('h1', 100));
      render(<DrawingMenu code={CODE} timeframe={TF} />);
      await openMenu();
      expect(screen.getByTestId('drawing-menu-lock-all')).not.toHaveTextContent('/');
    });
  });
});
