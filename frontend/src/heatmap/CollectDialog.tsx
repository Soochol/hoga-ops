import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { coveragePreview, bulkItems } from '../api/captures';
import type { CoveragePreviewResponse } from '../api/types';
import { CAPTURE_QUEUE_QUERY_KEY } from '../capture/useCaptureQueue';
import { ModalShell } from '../ui/ModalShell';
import { ToolbarButton } from '../ui/PageShell';

const LOOKBACK_PRESETS = [5, 10, 20] as const;
const LARGE_COLLECT_WARN = 200;

interface FolderScope { id: string; name: string; codes: string[] }

/** 단일 종목 스코프 편의 래퍼 — 히트맵 행 메뉴 '지난 N일 수집'과 /live 활성 종목
 *  수집이 공유한다. 제목 템플릿·센티넬 스코프 id 를 한 곳에 가둔다. */
export function SingleCodeCollectDialog({ code, name, onClose }: {
  code: string;
  name: string;
  onClose: () => void;
}) {
  return (
    <CollectDialog
      title={`${name} 지난 N일 수집`}
      groups={[{ id: '_one', name, codes: [code] }]}
      onClose={onClose}
    />
  );
}

/** 히트맵/그룹/종목의 지난 N거래일 hogaplay 데이터를 수집하는 다이얼로그.
 *  적재 전 coverage-preview 로 보유/무데이터/수집 예정/예상 소요를 보여준다. */
export function CollectDialog({ groups, title = '지난 N일 데이터 수집', onClose }: {
  groups: FolderScope[];
  title?: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [lookback, setLookback] = useState<number>(10);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(groups.map((g) => g.id)));
  const [preview, setPreview] = useState<CoveragePreviewResponse | null>(null);

  const codes = useMemo(() => {
    const set = new Set<string>();
    for (const g of groups) if (selected.has(g.id)) g.codes.forEach((c) => set.add(c));
    return [...set];
  }, [groups, selected]);

  const previewM = useMutation({
    mutationFn: () => coveragePreview({ codes, lookback_days: lookback }),
    onSuccess: setPreview,
  });
  const collectM = useMutation({
    mutationFn: () => bulkItems(preview!.missing),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CAPTURE_QUEUE_QUERY_KEY });
      onClose();
    },
  });

  // scope/기간이 바뀌면 이전 미리보기는 무효(다시 조회 필요).
  const resetPreview = () => setPreview(null);
  const toggleFolder = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    resetPreview();
  };

  const showFolders = groups.length > 1;
  const largeWarn = preview != null && preview.to_collect > LARGE_COLLECT_WARN;

  return (
    <ModalShell ariaLabel={title} title={title} width="w-[440px]" onClose={onClose}>
      <div className="flex flex-col gap-4 px-4 py-4">
        {/* 기간 프리셋 */}
        <div className="flex flex-col gap-2">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-dimmer">기간</span>
          <div className="flex items-center gap-2">
            {LOOKBACK_PRESETS.map((n) => (
              <button key={n} type="button" aria-pressed={lookback === n}
                onClick={() => { setLookback(n); resetPreview(); }}
                className={`px-3 py-1.5 rounded-md text-sm ${lookback === n ? 'bg-tint-selection text-accent' : 'bg-bg-input text-fg-dim hover:bg-bg-input-hover'}`}>
                {n}일
              </button>
            ))}
            <label className="ml-1 inline-flex items-center gap-1.5 text-sm text-fg-dim">
              직접
              <input type="number" inputMode="numeric" min={1} max={120} value={lookback}
                onChange={(e) => {
                  // 백엔드 ge=1/le=120 계약에 맞춰 client 에서 클램프(422 방지).
                  setLookback(Math.min(120, Math.max(1, Number(e.target.value) || 1)));
                  resetPreview();
                }}
                className="w-16 bg-bg-input border border-border rounded-md px-2 py-1 font-mono text-sm tabular-nums text-fg" />
              일
            </label>
          </div>
        </div>

        {/* 대상 그룹(멀티선택) — 그룹이 여럿일 때만 */}
        {showFolders && (
          <div className="flex flex-col gap-2">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-dimmer">대상 그룹</span>
            <div className="flex flex-wrap gap-1.5 max-h-32 overflow-auto">
              {groups.map((g) => (
                <button key={g.id} type="button" aria-pressed={selected.has(g.id)} onClick={() => toggleFolder(g.id)}
                  className={`px-2 py-1 rounded-md text-xs ${selected.has(g.id) ? 'bg-tint-selection text-accent' : 'bg-bg-input text-fg-dim hover:bg-bg-input-hover'}`}>
                  {g.name} <span className="text-fg-dimmer">{g.codes.length}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="text-xs text-fg-dim">
          대상 <span className="font-mono tabular-nums text-fg">{codes.length}</span>종목 × 지난 <span className="font-mono tabular-nums text-fg">{lookback}</span>거래일
        </div>

        {/* 미리보기 결과 */}
        {preview && (
          <div className="rounded-md border border-border bg-bg-subtle px-3 py-2.5 text-sm">
            <div className="grid grid-cols-2 gap-y-1 font-mono tabular-nums">
              <span className="text-fg-dim">이미 보유</span><span className="text-right text-fg">{preview.have}</span>
              <span className="text-fg-dim">상류 무데이터</span><span className="text-right text-fg-dimmer">{preview.no_upstream}</span>
              <span className="text-fg-dim">수집 예정</span><span className="text-right text-accent">{preview.to_collect}</span>
              <span className="text-fg-dim">예상 소요</span><span className="text-right text-fg">≈ {preview.est_minutes}분</span>
            </div>
            {largeWarn && (
              <div className="mt-2 text-xs" style={{ color: 'var(--warn)' }}>
                수집량이 많습니다 — 상류 응답이 느려 시간이 오래 걸릴 수 있습니다.
              </div>
            )}
          </div>
        )}
        {(previewM.isError || collectM.isError) && (
          <div className="text-xs" style={{ color: 'var(--error)' }}>
            {previewM.isError ? '미리보기 실패' : '수집 요청 실패'} — 잠시 후 다시 시도하세요.
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
        <ToolbarButton type="button" onClick={onClose}>취소</ToolbarButton>
        {preview == null ? (
          <ToolbarButton type="button" tone="primary" disabled={codes.length === 0 || previewM.isPending}
            onClick={() => previewM.mutate()}>
            {previewM.isPending ? '확인 중…' : '커버리지 확인'}
          </ToolbarButton>
        ) : (
          <ToolbarButton type="button" tone="primary" disabled={preview.to_collect === 0 || collectM.isPending}
            onClick={() => collectM.mutate()}>
            {collectM.isPending ? '적재 중…' : `${preview.to_collect}건 수집 시작`}
          </ToolbarButton>
        )}
      </div>
    </ModalShell>
  );
}
