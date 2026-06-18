import { useEffect, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent, PointerEvent } from 'react';

const HEIGHT_STORAGE_KEY = 'study.memoPanel.height.v1';
const DEFAULT_HEIGHT = 220;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 520;

function clampHeight(value: number) {
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(value)));
}

function readStoredHeight() {
  const raw = window.localStorage.getItem(HEIGHT_STORAGE_KEY);
  const value = raw ? Number(raw) : DEFAULT_HEIGHT;
  return Number.isFinite(value) ? clampHeight(value) : DEFAULT_HEIGHT;
}

export type StudyMemoPanelProps = {
  memo: string;
  isSaving: boolean;
  errorMessage: string | null;
  onClose: () => void;
  onCommit: (memo: string) => void;
};

export function StudyMemoPanel({
  memo,
  isSaving,
  errorMessage,
  onClose,
  onCommit,
}: StudyMemoPanelProps) {
  const [draft, setDraft] = useState(memo);
  const [height, setHeight] = useState(readStoredHeight);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const saveButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setDraft(memo);
  }, [memo]);

  const commit = () => {
    const next = draft.trim();
    if (next !== memo) {
      onCommit(next);
    }
  };

  const beginResize = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    if ('setPointerCapture' in e.currentTarget) {
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    dragRef.current = { startY: e.clientY, startHeight: height };
  };

  const moveResize = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) {
      return;
    }
    const next = clampHeight(dragRef.current.startHeight + (e.clientY - dragRef.current.startY));
    setHeight(next);
    window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(next));
  };

  const endResize = () => {
    dragRef.current = null;
  };

  const handleTextareaBlur = (e: FocusEvent<HTMLTextAreaElement>) => {
    if (e.relatedTarget === saveButtonRef.current) {
      return;
    }
    commit();
  };

  const resizeByKeyboard = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') {
      return;
    }
    e.preventDefault();
    const delta = e.key === 'ArrowUp' ? -16 : 16;
    const next = clampHeight(height + delta);
    setHeight(next);
    window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(next));
  };

  return (
    <section
      data-testid="study-memo-panel"
      className="flex shrink-0 flex-col border-b border-[var(--border)] bg-bg-card"
      style={{ height }}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <h2 className="text-sm font-semibold">메모</h2>
        <button type="button" onClick={onClose} className="rounded border px-2 py-1 text-xs">
          닫기
        </button>
      </div>
      <textarea
        aria-label="저장뷰 메모"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={handleTextareaBlur}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(memo);
            onClose();
          }
        }}
        placeholder="메모 없음"
        className="mx-3 min-h-0 flex-1 resize-none rounded border bg-bg-input p-2 text-sm"
      />
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-fg-dim">
        <span>{errorMessage ?? (isSaving ? '저장 중...' : '저장됨')}</span>
        <button
          ref={saveButtonRef}
          type="button"
          disabled={isSaving}
          onClick={commit}
          className="rounded border px-2 py-1 disabled:opacity-50"
        >
          저장
        </button>
      </div>
      <div
        role="separator"
        aria-label="메모 크기 조절"
        aria-orientation="horizontal"
        tabIndex={0}
        onPointerDown={beginResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onKeyDown={resizeByKeyboard}
        className="h-2 cursor-row-resize border-t border-[var(--border)] bg-bg-input-hover"
      />
    </section>
  );
}
