import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ModalShell } from '../ui/ModalShell';
import type { StudyViewGroup } from '../api/studyViews';
import { StudyGroupPicker, validStudyGroupChoice, type StudyGroupChoice } from './StudyGroupPicker';

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
  groups,
  initialGroupId,
  subjectLabel,
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
  groups: StudyViewGroup[];
  initialGroupId?: string;
  subjectLabel?: string;
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
  onSubmit: (v: { name: string; memo: string; capture: boolean } & StudyGroupChoice) => void;
}) {
  const [name, setName] = useState(defaultName);
  const [memo, setMemo] = useState(defaultMemo);
  const [capture, setCapture] = useState(true);
  const [group, setGroup] = useState<StudyGroupChoice>(() => groups.length === 0 ? { new_group_name: '' } : { group_id: initialGroupId });
  const valid = validStudyGroupChoice(groups, group);
  const duplicate = group.new_group_name !== undefined && groups.some((g) => g.name.toLocaleLowerCase() === group.new_group_name!.trim().toLocaleLowerCase());
  const title = mode === 'overwrite' ? '저장뷰 덮어쓰기' : '저장뷰 저장';
  const estHours = coverage ? coverage.estMinutes / 60 : 0;
  const estLabel = !coverage
    ? ''
    : estHours >= 1
      ? `≈ ${estHours.toFixed(1)}시간`
      : `≈ ${coverage.estMinutes}분`;

  return createPortal(
    <ModalShell ariaLabel={title} width="w-[400px]" onClose={() => { if (!isSubmitting) onCancel(); }}>
      <form
        className="max-h-[85vh] overflow-y-auto space-y-3 p-4"
        onKeyDown={(e) => { if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault(); }}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !isSubmitting) onSubmit({ name: name.trim() || `${subjectLabel ?? '저장뷰'} · ${rangeLabel ?? ''}`, memo: memo.trim(), capture, ...group, ...(group.new_group_name !== undefined ? { new_group_name: group.new_group_name.trim() } : {}) });
        }}
      >
        <h2 className="text-sm font-semibold">{mode === 'overwrite' ? '덮어쓰기' : '저장뷰 저장'}</h2>
        {mode === 'overwrite' && (
          <p className="text-xs text-fg-dim">기존 저장뷰를 현재 복기 구간으로 덮어쓰기합니다.</p>
        )}
        {subjectLabel && <p className="text-xs">{subjectLabel} · KRX 기준</p>}
        {rangeLabel ? (
          <p className="text-xs text-fg-dim">기간 참조 · {rangeLabel}</p>
        ) : barCount != null && sizeBytes != null ? (
          <p className="text-xs text-fg-dim">{barCount}개 봉 · 약 {Math.ceil(sizeBytes / 1024)}KB</p>
        ) : null}
        <fieldset disabled={isSubmitting}>
          <StudyGroupPicker groups={groups} value={group} onChange={setGroup} />
          {duplicate && <p role="alert" className="mt-1 text-xs text-error">이미 있는 그룹입니다 · 기존 그룹에서 선택하세요</p>}
        </fieldset>
        <label className="block text-xs">
          이름 <span className="text-fg-dim">선택</span>
          <input
            aria-label="이름"
            placeholder="비우면 종목·봉·기간으로 자동 생성"
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
                수집 상태를 확인하지 못했습니다 — 저장은 그대로 진행됩니다
              </p>
            ) : coverage.toCollect === 0 ? (
              <p className="text-xs text-fg-dim">
                이 기간 <span className="font-data tabular-nums">{coverage.have}</span>일 모두 수집돼 있습니다
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
          <p role="alert" className="text-xs text-error">{errorMessage}</p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={isSubmitting} className="rounded border px-3 py-1 text-sm disabled:opacity-50">취소</button>
          <button type="submit" disabled={!valid || isSubmitting} className="rounded border bg-accent px-3 py-1 text-sm text-white disabled:opacity-50">
            {isSubmitting ? '저장 중...' : group.new_group_name !== undefined ? '그룹 만들고 저장' : '저장'}
          </button>
        </div>
      </form>
    </ModalShell>,
    document.body,
  );
}
