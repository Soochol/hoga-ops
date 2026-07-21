import { useState } from 'react';
import { createPortal } from 'react-dom';

/** 저장 구간의 hogaplay 커버리지 — 저장과 함께 수집할지 판단할 재료. */
export type SaveCoverage = {
  isLoading: boolean;
  isError: boolean;
  have: number;
  toCollect: number;
  estMinutes: number;
};

export function StudyViewSaveDialog({
  mode,
  defaultName,
  defaultMemo,
  rangeLabel,
  barCount,
  sizeBytes,
  coverage,
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
  /** null 이면 수집 UI 자체를 숨긴다(커버리지를 물어볼 수 없는 소스). */
  coverage?: SaveCoverage | null;
  isSubmitting?: boolean;
  errorMessage?: string | null;
  onCancel: () => void;
  onSubmit: (v: { name: string; memo: string; capture: boolean }) => void;
}) {
  const [name, setName] = useState(defaultName);
  const [memo, setMemo] = useState(defaultMemo);
  const [capture, setCapture] = useState(true);
  const valid = name.trim().length > 0;
  const title = mode === 'overwrite' ? '저장뷰 덮어쓰기' : '저장뷰 만들기';
  const estHours = coverage ? coverage.estMinutes / 60 : 0;
  const estLabel = !coverage
    ? ''
    : estHours >= 1
      ? `≈ ${estHours.toFixed(1)}시간`
      : `≈ ${coverage.estMinutes}분`;

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 grid place-items-center bg-black/40">
      <form
        className="w-[360px] max-w-[calc(100vw-24px)] space-y-3 rounded border bg-bg p-4 shadow-lg"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSubmit({ name: name.trim(), memo: memo.trim(), capture });
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
        {coverage && (
          <div className="rounded border border-border bg-bg-subtle px-2.5 py-2">
            {coverage.isLoading ? (
              <p className="text-xs text-fg-dim">수집 상태 확인 중…</p>
            ) : coverage.isError ? (
              <p className="text-xs text-fg-dim">
                수집 상태를 확인하지 못했습니다 — 저장은 그대로 진행됩니다.
              </p>
            ) : coverage.toCollect === 0 ? (
              <p className="text-xs text-fg-dim">
                이 기간 <span className="font-data tabular-nums">{coverage.have}</span>일 모두 수집돼 있습니다.
              </p>
            ) : (
              <>
                <label className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    aria-label="빠진 기간 수집"
                    checked={capture}
                    onChange={(e) => setCapture(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    빠진 <span className="font-data tabular-nums text-accent">{coverage.toCollect}</span>일
                    hogaplay 수집 <span className="text-fg-dim">({estLabel})</span>
                    <br />
                    <span className="text-fg-dimmer">
                      이미 보유 <span className="font-data tabular-nums">{coverage.have}</span>일은 건너뜁니다.
                    </span>
                  </span>
                </label>
                {estHours >= 1 && capture && (
                  <p className="mt-1.5 text-xs" style={{ color: 'var(--warn)' }}>
                    수집량이 많아 백그라운드에서 오래 걸립니다.
                  </p>
                )}
              </>
            )}
          </div>
        )}
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
    </div>,
    document.body,
  );
}
