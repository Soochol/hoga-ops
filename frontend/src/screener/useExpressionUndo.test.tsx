import { useRef, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useExpressionUndo } from './useExpressionUndo';

function Editor({ scope = 'one', loaded = 'A AND B' }: { scope?: string; loaded?: string }) {
  const [text, setText] = useState(loaded);
  const input = useRef<HTMLTextAreaElement>(null);
  const undo = useExpressionUndo(text, scope, setText, input);
  return <section onKeyDown={undo.onKeyDown}>
    <textarea aria-label="조합식" ref={input} value={text} onChange={undo.onTextChange} onSelect={undo.rememberSelection} />
    <button type="button" onClick={() => undo.change('A OR B')}>모두 OR</button>
    <button type="button" onClick={() => setText('B')}>외부 저장본 불러오기</button>
  </section>;
}

describe('expression undo', () => {
  it('undoes a preset, restores selection, supports redo, and clears redo after a new edit', async () => {
    render(<Editor />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    input.focus(); input.setSelectionRange(2, 5);
    fireEvent.select(input);
    fireEvent.click(screen.getByRole('button', { name: '모두 OR' }));
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    expect(input).toHaveValue('A AND B');
    await waitFor(() => expect(input.selectionStart).toBe(2));
    expect(input.selectionEnd).toBe(5);
    fireEvent.keyDown(input, { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(input).toHaveValue('A OR B');
    fireEvent.keyDown(input, { key: 'z', metaKey: true });
    expect(input).toHaveValue('A AND B');
    fireEvent.input(input, { target: { value: 'A' }, inputType: 'insertFromPaste', data: 'A' });
    fireEvent.keyDown(input, { key: 'y', ctrlKey: true });
    expect(input).toHaveValue('A');
  });

  it('does not undo across condition scope changes or external loads', () => {
    const { rerender } = render(<Editor />);
    const input = screen.getByRole('textbox');
    fireEvent.click(screen.getByRole('button', { name: '모두 OR' }));
    rerender(<Editor scope="two" />);
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    expect(input).toHaveValue('A OR B');
    fireEvent.input(input, { target: { value: 'A' }, inputType: 'insertFromPaste' });
    fireEvent.click(screen.getByRole('button', { name: '외부 저장본 불러오기' }));
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    expect(input).toHaveValue('B');
  });

  it('groups contiguous typing but leaves composition shortcuts to the IME', () => {
    vi.useFakeTimers();
    try {
      render(<Editor loaded="A" />);
      const input = screen.getByRole('textbox') as HTMLTextAreaElement;
      input.setSelectionRange(1, 1); fireEvent.select(input);
      for (const text of ['A ', 'A O', 'A OR', 'A OR ', 'A OR B']) {
        fireEvent.input(input, { target: { value: text }, inputType: 'insertText', data: text.slice(-1) });
      }
      const composing = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'z', ctrlKey: true, isComposing: true });
      input.dispatchEvent(composing);
      expect(composing.defaultPrevented).toBe(false);
      expect(input).toHaveValue('A OR B');
      fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
      expect(input).toHaveValue('A');
      act(() => vi.runOnlyPendingTimers());
    } finally { vi.useRealTimers(); }
  });
});
