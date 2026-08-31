import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import DrawingClearConfirmHost from './DrawingClearConfirmHost';
import { useDrawingsStore } from '../state/drawings';
import { drawingScope } from './drawing/persistence';
import type { Drawing } from './drawing/types';

const A = drawingScope('005930', 'minute');

function mkHline(id: string, price: number): Drawing {
  return { id, kind: 'hline', price, color: '#FFD60A', width: 1.5, lineStyle: 'solid', paneId: 'candle' };
}

const s = () => useDrawingsStore.getState();

describe('DrawingClearConfirmHost', () => {
  beforeEach(() => {
    localStorage.clear();
    s().__resetForTests();
  });

  it('확인 요청이 없으면 아무것도 렌더하지 않는다', () => {
    const { container } = render(<DrawingClearConfirmHost />);
    expect(container).toBeEmptyDOMElement();
  });

  it('삭제 예정 개수를 문구에 담아 팝업을 띄운다', () => {
    s().add(A, mkHline('h1', 100));
    s().add(A, mkHline('h2', 200));
    s().requestClearAll(A);
    render(<DrawingClearConfirmHost />);

    expect(screen.getByRole('dialog')).toHaveTextContent('그림 2개가 모두 삭제됩니다');
  });

  it('확인을 누르면 그때 지운다 — 실행취소 토스트로 이어진다', async () => {
    s().add(A, mkHline('h1', 100));
    s().requestClearAll(A);
    render(<DrawingClearConfirmHost />);

    await userEvent.click(screen.getByRole('button', { name: '모두 지우기' }));

    expect(s().drawingsFor(A)).toHaveLength(0);
    expect(s().clearConfirm).toBeNull();
    expect(s().clearToast).toMatchObject({ scope: A, count: 1 });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('취소를 누르면 그림이 그대로 남는다', async () => {
    s().add(A, mkHline('h1', 100));
    s().requestClearAll(A);
    render(<DrawingClearConfirmHost />);

    await userEvent.click(screen.getByRole('button', { name: '취소' }));

    expect(s().drawingsFor(A)).toHaveLength(1);
    expect(s().clearConfirm).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  // ── 잠금 (ADR-0164) ────────────────────────────────────────────────────
  it('잠긴 것이 있으면 남는 개수를 함께 알린다', () => {
    s().add(A, mkHline('h1', 100));
    s().add(A, mkHline('h2', 200));
    s().add(A, mkHline('h3', 300));
    s().update(A, 'h3', { locked: true });
    s().requestClearAll(A);
    render(<DrawingClearConfirmHost />);

    // count 는 이미 잠긴 것을 뺀 수라, 이 문장이 없으면 "3개 그렸는데 2개라고
    // 하네" 가 설명 없는 불일치로 읽힌다.
    expect(screen.getByRole('dialog')).toHaveTextContent('그림 2개가 모두 삭제됩니다');
    expect(screen.getByRole('dialog')).toHaveTextContent('잠긴 1개는 유지됩니다');
  });

  it('잠긴 것이 없으면 그 문장을 쓰지 않는다', () => {
    s().add(A, mkHline('h1', 100));
    s().requestClearAll(A);
    render(<DrawingClearConfirmHost />);

    expect(screen.getByRole('dialog')).not.toHaveTextContent('유지됩니다');
  });

  it('확인을 누르면 잠긴 것만 남는다', async () => {
    s().add(A, mkHline('h1', 100));
    s().add(A, mkHline('h2', 200));
    s().update(A, 'h2', { locked: true });
    s().requestClearAll(A);
    render(<DrawingClearConfirmHost />);

    await userEvent.click(screen.getByRole('button', { name: '모두 지우기' }));

    expect(s().drawingsFor(A).map((d) => d.id)).toEqual(['h2']);
  });

  // ModalShell 의 Escape·백드롭 계약이 이 호스트에도 걸려 있는지 — 취소와 같은
  // 경로여야 한다(파괴적 액션이 실수로 확정되면 안 된다).
  it('Escape 로 닫아도 취소로 동작한다', async () => {
    s().add(A, mkHline('h1', 100));
    s().requestClearAll(A);
    render(<DrawingClearConfirmHost />);

    await userEvent.keyboard('{Escape}');

    expect(s().drawingsFor(A)).toHaveLength(1);
    expect(s().clearConfirm).toBeNull();
  });
});
