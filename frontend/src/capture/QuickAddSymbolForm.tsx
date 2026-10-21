import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { SymbolHit } from '../api/types';
import { SymbolSearch } from './SymbolSearch';
import { useOptimisticDuplicateGate } from '../util/useOptimisticDuplicateGate';
import { Banner } from '../ui/Banner';
import { ToastCard } from '../ui/toast/ToastCard';
import { useToastTimer } from '../ui/toast/useToastTimer';

/** Selection commits an addition. Callers key this form by destination so pending
 * requests, errors and undo never carry over to another group. */
export function QuickAddSymbolForm({ onAdd, onUndo, onAdded, isAdded, onDuplicate, duplicateAction, disabled = false, onPendingChange }: {
  onAdd: (hit: SymbolHit) => Promise<void>;
  onUndo: (hit: SymbolHit) => Promise<void>;
  onAdded?: (hit: SymbolHit) => void;
  isAdded: (code: string) => boolean;
  onDuplicate?: (code: string) => void;
  duplicateAction?: (hit: SymbolHit) => ReactNode;
  disabled?: boolean;
  onPendingChange?: (pending: boolean) => void;
}) {
  const [picked, setPicked] = useState<SymbolHit | null>(null);
  const [existing, setExisting] = useState<SymbolHit | null>(null);
  const [error, setError] = useState<{ message: string; hit: SymbolHit; undo: boolean } | null>(null);
  const [version, setVersion] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [undoHit, setUndoHit] = useState<SymbolHit | null>(null);
  const { submitting, run } = useOptimisticDuplicateGate(picked, hit => isAdded(hit.code));
  const ref = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const started = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onPendingChange?.(submitting); }, [submitting, onPendingChange]);
  useLayoutEffect(() => {
    if (!submitting && started.current) ref.current?.querySelector('input')?.focus();
  }, [submitting, version]);
  const timer = useToastTimer({ visible: !!feedback, durationMs: submitting ? null : 5000, resetKey: version,
    onExpire: () => { setFeedback(''); setUndoHit(null); } });

  const pointAtExisting = (hit: SymbolHit) => {
    setExisting(hit);
    onDuplicate?.(hit.code);
  };
  const submit = async (hit: SymbolHit, undo = false) => {
    if (disabled) return;
    if (!undo && isAdded(hit.code)) { pointAtExisting(hit); return; }
    await run(async () => {
      started.current = true;
      setError(null);
      setExisting(null);
      try {
        if (undo) await onUndo(hit);
        else await onAdd(hit);
        if (!mounted.current) return;
        setPicked(null);
        setVersion(v => v + 1);
        setFeedback(`${hit.name} ${undo ? '추가 취소됨' : '추가됨'}`);
        setUndoHit(undo ? null : hit);
        if (!undo) onAdded?.(hit);
      } catch (cause) {
        if (!mounted.current) return;
        setError({ message: cause instanceof Error && cause.message ? cause.message : '잠시 후 다시 시도하세요.', hit, undo });
      }
    });
  };

  return <div ref={ref} aria-busy={submitting} className="flex min-w-0 flex-col gap-2"
    // An inline result list must not collapse on mousedown and move its sibling
    // Retry/Undo controls before their click is delivered.
    onMouseDown={event => event.stopPropagation()}>
    <SymbolSearch value={picked} disabled={disabled || submitting} resetKey={version} resultsLayout="inline"
      optionState={hit => isAdded(hit.code) ? 'added' : undefined}
      onAddedOptionClick={pointAtExisting}
      onChange={hit => {
        setError(null); setExisting(null); setPicked(hit);
        if (hit) void submit(hit);
      }} />
    {submitting && <div role="status" className="text-xs text-fg-dim">처리 중…</div>}
    {existing && !submitting && isAdded(existing.code) && <Banner kind="error">
      {existing.name}은(는) 이미 이 그룹에 있습니다
      {duplicateAction?.(existing)}
    </Banner>}
    {error && <Banner kind="error">
      {error.undo ? '추가를 취소하지 못했습니다.' : '종목을 추가하지 못했습니다.'} {error.message}
      <button type="button" disabled={submitting} className="ml-2 text-accent disabled:opacity-40"
        onClick={() => { void submit(error.hit, error.undo); }}>다시 시도</button>
    </Banner>}
    <ToastCard visible={!!feedback} role="status" ariaLabel="종목 추가 안내" progress={timer.progress} {...timer.interactionProps}
      actions={undoHit && <button type="button" disabled={submitting} className="text-accent text-xs disabled:opacity-40"
        onClick={() => { void submit(undoHit, true); }}>실행 취소</button>}>
      {feedback}
    </ToastCard>
  </div>;
}
