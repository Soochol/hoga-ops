import { useState } from 'react';

export function StudyViewSaveDialog({
  mode,
  defaultName,
  defaultMemo,
  rangeLabel,
  barCount,
  sizeBytes,
  isSubmitting = false,
  errorMessage,
  onCancel,
  onSubmit,
}: {
  mode: 'create' | 'overwrite';
  defaultName: string;
  defaultMemo: string;
  rangeLabel?: string;
  barCount?: number;
  sizeBytes?: number;
  isSubmitting?: boolean;
  errorMessage?: string | null;
  onCancel: () => void;
  onSubmit: (v: { name: string; memo: string }) => void;
}) {
  const [name, setName] = useState(defaultName);
  const [memo, setMemo] = useState(defaultMemo);
  const valid = name.trim().length > 0;
  const title = mode === 'overwrite' ? '저장뷰 덮어쓰기' : '저장뷰 만들기';

  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 grid place-items-center bg-black/40">
      <form
        className="w-[360px] max-w-[calc(100vw-24px)] space-y-3 rounded border bg-bg p-4 shadow-lg"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSubmit({ name: name.trim(), memo: memo.trim() });
        }}
      >
        <h2 className="text-sm font-semibold">{mode === 'overwrite' ? '덮어쓰기' : '저장 뷰 만들기'}</h2>
        {mode === 'overwrite' && (
          <p className="text-xs text-fg-dim">기존 저장뷰를 현재 복기 구간으로 덮어쓰기합니다.</p>
        )}
        {rangeLabel ? (
          <p className="text-xs text-fg-dim">기간 참조 · {rangeLabel}</p>
        ) : barCount != null && sizeBytes != null ? (
          <p className="text-xs text-fg-dim">{barCount}개 봉 · 약 {Math.ceil(sizeBytes / 1024)}KB</p>
        ) : null}
        <label className="block text-xs">
          이름
          <input
            aria-label="이름"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded border bg-bg-input px-2 py-1 text-sm"
          />
        </label>
        <label className="block text-xs">
          메모
          <textarea
            aria-label="메모"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            className="mt-1 min-h-20 w-full rounded border bg-bg-input px-2 py-1 text-sm"
          />
        </label>
        <p className="text-xs text-fg-dim">저장 학습뷰는 현재 화면의 기간을 저장하고 다시 불러와 분석합니다.</p>
        {errorMessage && (
          <p role="alert" className="text-xs text-red-500">{errorMessage}</p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={isSubmitting} className="rounded border px-3 py-1 text-sm disabled:opacity-50">취소</button>
          <button type="submit" disabled={!valid || isSubmitting} className="rounded border bg-accent px-3 py-1 text-sm text-white disabled:opacity-50">
            {isSubmitting ? '저장 중...' : '저장'}
          </button>
        </div>
      </form>
    </div>
  );
}
