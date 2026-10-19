import { useLayoutEffect, useRef, type ChangeEvent, type KeyboardEvent, type RefObject } from 'react';

interface Selection { start: number; end: number; direction?: 'forward' | 'backward' | 'none' }
interface Snapshot extends Selection { text: string }
interface History {
  scope: string;
  current: Snapshot;
  past: Snapshot[];
  future: Snapshot[];
  group: { kind: string; time: number } | null;
}
const MAX_HISTORY = 100;
const GROUP_DELAY_MS = 1000;
const GROUPED_INPUTS = new Set(['insertText', 'insertCompositionText', 'deleteContentBackward', 'deleteContentForward']);

function initialHistory(text: string, scope: string): History {
  return { scope, current: { text, start: text.length, end: text.length }, past: [], future: [], group: null };
}

function selection(input: HTMLTextAreaElement): Selection {
  return { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
}

function restoreSelection(input: HTMLTextAreaElement | null, next: Snapshot) {
  if (!input || input.value !== next.text) return;
  input.focus();
  input.setSelectionRange(next.start, next.end, next.direction);
}

/** One local history for typing, token buttons and presets; condition letters must keep the same meaning. */
export function useExpressionUndo(text: string, scope: string, onChange: (text: string) => void,
  inputRef: RefObject<HTMLTextAreaElement>) {
  const history = useRef(initialHistory(text, scope));
  const pendingSelection = useRef<Snapshot | null>(null);
  useLayoutEffect(() => {
    if (history.current.scope !== scope || history.current.current.text !== text) {
      history.current = initialHistory(text, scope);
      pendingSelection.current = null;
    }
    const next = pendingSelection.current;
    pendingSelection.current = null;
    if (next) restoreSelection(inputRef.current, next);
  }, [text, scope, inputRef]);

  const rememberSelection = () => {
    const input = inputRef.current, state = history.current;
    if (!input || input.value !== state.current.text) return;
    const next = selection(input);
    if (next.start !== state.current.start || next.end !== state.current.end) state.group = null;
    state.current = { ...state.current, ...next };
  };

  const commit = (next: string, kind: string, after?: Selection) => {
    const state = history.current;
    if (next === state.current.text) {
      state.group = null;
      if (kind === 'button' && after) {
        state.current = { text: next, ...after };
        restoreSelection(inputRef.current, state.current);
      }
      return;
    }
    const now = Date.now();
    const merge = GROUPED_INPUTS.has(kind) && state.group?.kind === kind
      && now - state.group.time < GROUP_DELAY_MS && state.current.start === state.current.end;
    if (!merge) state.past.push({ ...state.current });
    if (state.past.length > MAX_HISTORY) state.past.shift();
    state.future = [];
    state.current = { text: next, start: next.length, end: next.length, ...after };
    state.group = GROUPED_INPUTS.has(kind) ? { kind, time: now } : null;
    if (kind === 'button' && after) pendingSelection.current = state.current;
    onChange(next);
  };

  const change = (next: string, after?: Selection) => {
    rememberSelection();
    commit(next, 'button', after);
  };
  const onTextChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent as InputEvent;
    const kind = native.inputType === 'insertText' && native.data?.length !== 1 ? 'replace' : native.inputType ?? 'replace';
    commit(event.currentTarget.value, kind, selection(event.currentTarget));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    rememberSelection();
    const key = event.key.toLowerCase();
    if (!(event.ctrlKey || event.metaKey) || event.altKey || (key !== 'z' && key !== 'y')) {
      if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end', 'tab'].includes(key)) {
        history.current.group = null;
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const state = history.current, redo = key === 'y' || event.shiftKey;
    const from = redo ? state.future : state.past, to = redo ? state.past : state.future;
    const next = from.pop();
    state.group = null;
    if (!next) return;
    to.push({ ...state.current });
    state.current = next;
    pendingSelection.current = next;
    onChange(next.text);
  };
  return { change, onTextChange, onKeyDown, rememberSelection };
}
