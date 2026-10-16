import { useCallback, useEffect, useLayoutEffect, useRef, useState, type SyntheticEvent } from 'react';

export type SettingsSnapshot = Record<string, unknown>;
export type SettingsUndoEntry = { undo: () => void | Promise<unknown>; isCurrent: () => boolean };
export type SettingsUndoRecorder = (entry: SettingsUndoEntry) => void;
const equal = (a: unknown, b: unknown) => Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);

/** A single user event may update both indicator stores. Capture the entire event,
 * then retain only the fields it changed. Background updates never become edits. */
export function useSettingsUndo({ scopeKey, read, restore, subscribe }: {
  scopeKey: string;
  read: () => SettingsSnapshot;
  restore: (patch: SettingsSnapshot) => void;
  subscribe: (changed: () => void) => () => void;
}) {
  const [entry, setEntry] = useState<{ key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyScope, setHistoryScope] = useState(scopeKey);
  const [message, setMessage] = useState<{ key: string; text: string } | null>(null);
  // Discard derived UI state before a different target commits. Returning to
  // the old target must not re-enable a record that was already invalidated.
  if (historyScope !== scopeKey) {
    setHistoryScope(scopeKey); setEntry(null); setMessage(null);
  }
  const current = useRef({ scopeKey, read, restore });
  const history = useRef<SettingsUndoEntry | null>(null);
  const pending = useRef<{ key: string; before: SettingsSnapshot; read: typeof read; restore: typeof restore } | null>(null);
  const applying = useRef(false);
  const mounted = useRef(false);

  const record = useCallback<SettingsUndoRecorder>(next => {
    if (!mounted.current || applying.current) return;
    history.current = next;
    setEntry({ key: current.current.scopeKey });
    setMessage(null);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current = null; };
  }, []);
  useLayoutEffect(() => {
    if (current.current.scopeKey !== scopeKey) { history.current = null; pending.current = null; }
    current.current = { scopeKey, read, restore };
  }, [scopeKey, read, restore]);
  useEffect(() => subscribe(() => {
    if (!applying.current && !pending.current && history.current && !history.current.isCurrent()) {
      history.current = null; setEntry(null);
    }
  }), [subscribe]);

  const flush = useCallback(() => {
    const edit = pending.current;
    if (!mounted.current || !edit) return;
    pending.current = null;
    if (current.current.scopeKey !== edit.key) return;
    const after = edit.read();
    const keys = Object.keys(edit.before).filter(key => !equal(edit.before[key], after[key]));
    if (!keys.length) return;
    const beforePatch = Object.fromEntries(keys.map(key => [key, edit.before[key]]));
    record({
      undo: () => edit.restore(beforePatch),
      isCurrent: () => { const actual = edit.read(); return current.current.scopeKey === edit.key && keys.every(key => equal(actual[key], after[key])); },
    });
  }, [record]);

  const capture = useCallback((event: SyntheticEvent) => {
    if (applying.current || pending.current || (event.target instanceof Element && event.target.closest('[data-settings-undo]'))) return;
    const { scopeKey: key, read: readAtEvent, restore: restoreAtEvent } = current.current;
    const edit = { key, before: readAtEvent(), read: readAtEvent, restore: restoreAtEvent };
    pending.current = edit;
    // A native browser event can run microtasks between React's capture and
    // bubble listeners. A timer waits for the actual control handler to commit.
    setTimeout(() => { if (pending.current === edit) flush(); }, 0);
  }, [flush]);

  const undo = useCallback(async () => {
    flush(); // A blur immediately before this click may have committed a draft.
    const previous = history.current;
    if (!previous || applying.current) return;
    if (!previous.isCurrent()) { history.current = null; setEntry(null); setMessage({ key: current.current.scopeKey, text: '설정이 변경되어 되돌릴 수 없습니다' }); return; }
    applying.current = true; setBusy(true);
    try {
      await previous.undo();
      if (!mounted.current) return;
      history.current = null; setEntry(null); setMessage({ key: current.current.scopeKey, text: '이전 설정으로 되돌렸습니다' });
    } catch (error) {
      if (mounted.current) setMessage({ key: current.current.scopeKey, text: error instanceof Error ? error.message : '설정을 되돌리지 못했습니다' });
    } finally {
      applying.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [flush]);

  return {
    record, undo, canUndo: entry?.key === scopeKey && !busy, busy, message: message?.key === scopeKey ? message.text : null,
    captureProps: { onClickCapture: capture, onChangeCapture: capture, onBlurCapture: capture, onKeyDownCapture: capture },
  };
}
export type SettingsUndo = ReturnType<typeof useSettingsUndo>;
