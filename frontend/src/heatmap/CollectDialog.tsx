import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { coveragePreview, bulkItems } from '../api/captures';
import type { CoveragePreviewResponse } from '../api/types';
import { CAPTURE_QUEUE_QUERY_KEY } from '../capture/useCaptureQueue';
import type { CollectVisibleRange } from '../live/workspace/collectDialogControls';
import { fmtDate } from '../inventory/format';
import { ModalShell } from '../ui/ModalShell';
import { ToolbarButton } from '../ui/PageShell';

const LOOKBACK_PRESETS = [5, 10, 20] as const;
const LARGE_COLLECT_WARN = 200;

/** YYYYMMDD → UTC 자정 ms(달력일 span 계산용). 거래일 수는 프론트가 캘린더 없이
 *  알 수 없어 커버리지 확인 결과로 확정된다 — 여기선 달력일만 가볍게 표시한다. */
function ymdToUtcMs(ymd: string): number {
  return Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8));
}
function calendarDaySpan(range: CollectVisibleRange): number {
  return Math.round((ymdToUtcMs(range.endYmd) - ymdToUtcMs(range.startYmd)) / 86_400_000) + 1;
}

interface FolderScope { id: string; name: string; codes: string[] }

/** 단일 종목 스코프 편의 래퍼 — 히트맵 행 메뉴 '지난 N일 수집'과 /live 활성 종목
 *  수집이 공유한다. 제목 템플릿·센티넬 스코프 id 를 한 곳에 가둔다.
 *  /live 는 차트에 보이는 캔들 구간(visibleRange)을 실어 '보이는 구간' 모드를 켠다. */
export function SingleCodeCollectDialog({ code, name, visibleRange, onClose }: {
  code: string;
  name: string;
  visibleRange?: CollectVisibleRange | null;
  onClose: () => void;
}) {
  return (
    <CollectDialog
      title={`${name} 지난 N일 수집`}
      groups={[{ id: '_one', name, codes: [code] }]}
      visibleRange={visibleRange}
      onClose={onClose}
    />
  );
}

/** 히트맵/그룹/종목의 지난 N거래일 hogaplay 데이터를 수집하는 다이얼로그.
 *  적재 전 coverage-preview 로 보유/무데이터/수집 예정/예상 소요를 보여준다. */
export function CollectDialog({ groups, title = '지난 N일 데이터 수집', visibleRange = null, onClose }: {
  groups: FolderScope[];
  title?: string;
  /** /live 차트에 보이는 캔들 구간(양 끝 거래일). 있으면 '보이는 구간' 모드가 열린다. */
  visibleRange?: CollectVisibleRange | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [lookback, setLookback] = useState<number>(10);
  // 기본은 상대-일(lookback) — 기존 동작 유지. 사용자가 칩으로 '보이는 구간'을 켠다.
  // 두 모드는 서로 다른 계약(lookback_days vs start/end)이라 상태를 분리한다.
  const [mode, setMode] = useState<'lookback' | 'visible'>('lookback');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(groups.map((g) => g.id)));
  const [preview, setPreview] = useState<CoveragePreviewResponse | null>(null);

  const codes = useMemo(() => {
    const set = new Set<string>();
    for (const g of groups) if (selected.has(g.id)) g.codes.forEach((c) => set.add(c));
    return [...set];
  }, [groups, selected]);

  const useVisible = mode === 'visible' && visibleRange != null;
  const previewM = useMutation({
    mutationFn: () => coveragePreview(
      useVisible
        ? { codes, start_date: visibleRange!.startYmd, end_date: visibleRange!.endYmd }
        : { codes, lookback_days: lookback },
    ),
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
  const selectLookback = (n?: number) => {
    setMode('lookback');
    if (n !== undefined) setLookback(n);
    resetPreview();
  };
  const selectVisible = () => {
    setMode('visible');
    resetPreview();
  };
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
          <span className="text-[10.5px] font-semibold uppercase text-fg-dimmer">기간</span>
          <div className="flex items-center gap-2">
            {LOOKBACK_PRESETS.map((n) => (
              <button key={n} type="button" aria-pressed={mode === 'lookback' && lookback === n}
                onClick={() => selectLookback(n)}
                className={`px-3 py-1.5 rounded-md text-sm ${mode === 'lookback' && lookback === n ? 'bg-tint-selection text-accent' : 'bg-bg-input text-fg-dim hover:bg-bg-input-hover'}`}>
                {n}일
              </button>
            ))}
            <label className={`ml-1 inline-flex items-center gap-1.5 text-sm ${useVisible ? 'text-fg-dimmer' : 'text-fg-dim'}`}>
              직접
              <input type="number" inputMode="numeric" min={1} max={120} value={lookback} disabled={useVisible}
                onChange={(e) => {
                  // 백엔드 ge=1/le=120 계약에 맞춰 client 에서 클램프(422 방지).
                  setLookback(Math.min(120, Math.max(1, Number(e.target.value) || 1)));
                  selectLookback();
                }}
                className="w-16 bg-bg-input border border-border rounded-md px-2 py-1 font-data text-sm tabular-nums text-fg disabled:opacity-40" />
              일
            </label>
          </div>
          {/* '보이는 구간' 모드 — 차트가 실어 보낸 visibleRange 가 있을 때만 노출.
              상대-일과 개념이 달라(절대 시작~끝) 칩을 켜면 위 상대-일 입력을 흐린다. */}
          {visibleRange && (
            <button type="button" aria-pressed={useVisible} onClick={selectVisible}
              className={`inline-flex items-center gap-1.5 self-start px-3 py-1.5 rounded-md text-sm ${useVisible ? 'bg-tint-selection text-accent' : 'bg-bg-input text-fg-dim hover:bg-bg-input-hover'}`}>
              <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              보이는 구간
            </button>
          )}
          {useVisible && visibleRange && (
            <div className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-xs text-fg-dim">
              <span className="font-data tabular-nums text-fg">{fmtDate(visibleRange.startYmd)}</span>
              {' ~ '}
              <span className="font-data tabular-nums text-fg">{fmtDate(visibleRange.endYmd)}</span>
              <span className="text-fg-dimmer"> · 약 {calendarDaySpan(visibleRange)}일</span>
            </div>
          )}
        </div>

        {/* 대상 그룹(멀티선택) — 그룹이 여럿일 때만 */}
        {showFolders && (
          <div className="flex flex-col gap-2">
            <span className="text-[10.5px] font-semibold uppercase text-fg-dimmer">대상 그룹</span>
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
          {useVisible ? (
            <>대상 <span className="font-data tabular-nums text-fg">{codes.length}</span>종목 × 화면에 보이는 구간</>
          ) : (
            <>대상 <span className="font-data tabular-nums text-fg">{codes.length}</span>종목 × 지난 <span className="font-data tabular-nums text-fg">{lookback}</span>거래일</>
          )}
        </div>

        {/* 미리보기 결과 */}
        {preview && (
          <div className="rounded-md border border-border bg-bg-subtle px-3 py-2.5 text-sm">
            <div className="grid grid-cols-2 gap-y-1 font-data tabular-nums">
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
