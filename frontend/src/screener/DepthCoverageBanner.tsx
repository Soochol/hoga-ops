import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DepthCoverage } from '../api/screener';
import { coveragePreview, bulkItems } from '../api/captures';
import { CAPTURE_QUEUE_QUERY_KEY } from '../capture/useCaptureQueue';
import { InlineState } from '../ui/DataSurface';
import { ToolbarButton } from '../ui/PageShell';

/** 총잔량 조건에서 hogaplay 데이터가 없어 제외된 종목을 알리고, 결측분을 지난 N일치
 *  수집 요청한다(coverage-preview → bulk-items 재사용). `autoCollect` 면 결측 발견 시
 *  자동 적재. 수집은 수 분~시간 걸리므로 동기 대기 없이 큐에 넣고 안내만 한다. */
export function DepthCoverageBanner({ coverage, autoCollect = false }: {
  coverage: DepthCoverage;
  autoCollect?: boolean;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  // 실제 적재 결과 — enqueued(새로 큐), deduped(이미 대기중), missing(수집 대상 수).
  const [result, setResult] = useState<{ enqueued: number; deduped: number; missing: number } | null>(null);

  const lastAuto = useRef<string | null>(null);
  const collectM = useMutation({
    mutationFn: async () => {
      const codes = coverage.excluded.map((c) => c.code);
      const preview = await coveragePreview({ codes, lookback_days: coverage.lookback });
      if (preview.missing.length === 0) return { enqueued: 0, deduped: 0, missing: 0 };
      const res = await bulkItems(preview.missing);
      return { enqueued: res.enqueued, deduped: res.deduped, missing: preview.missing.length };
    },
    onSuccess: (r) => {
      setResult(r);
      queryClient.invalidateQueries({ queryKey: CAPTURE_QUEUE_QUERY_KEY });
    },
    // 실패 시 자동수집 가드를 풀어, 다음 트리거(재스캔 등)에서 재시도할 수 있게 한다.
    onError: () => { lastAuto.current = null; },
  });

  // 자동 수집: 결측 종목 집합이 바뀔 때 1회만 적재(같은 스캔 내 재렌더/StrictMode
  // 이중 호출로 재발화 방지 — mutate 전에 가드를 선점). 실패는 onError 가 가드를 풀어 재시도 허용.
  const autoSig = coverage.excluded.map((c) => c.code).join(',');
  useEffect(() => {
    if (!autoCollect || coverage.excluded.length === 0) return;
    if (lastAuto.current === autoSig) return;
    lastAuto.current = autoSig;
    collectM.mutate();
    // collectM 은 안정 참조가 아니므로 의존성에서 제외(시그니처 가드로 1회 보장).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCollect, autoSig]);

  if (coverage.excluded.length === 0) return null;
  const n = coverage.excluded.length;

  return (
    <InlineState tone="warn" className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          hogaplay 데이터 없는 종목 <span className="font-mono tabular-nums">{n}</span>개는 비교에서 제외됐습니다.
        </span>
        <button type="button" onClick={() => setExpanded((v) => !v)}
          className="text-xs text-fg-dim underline hover:text-fg">
          {expanded ? '목록 숨기기' : '목록 보기'} ▾
        </button>
        <div className="flex-1" />
        {result == null ? (
          <ToolbarButton type="button" onClick={() => collectM.mutate()} disabled={collectM.isPending}>
            {collectM.isPending ? '적재 중…' : `지난 ${coverage.lookback}일 수집 요청`}
          </ToolbarButton>
        ) : (
          <span className="text-xs text-fg-dim">
            {result.missing === 0
              ? '수집할 결측 데이터가 없습니다'
              : result.enqueued > 0
                ? `수집 중 ${result.enqueued}건 — 완료 후 다시 조회하세요`
                : '이미 수집 대기 중입니다 — 완료 후 다시 조회하세요'}
          </span>
        )}
      </div>
      {collectM.isError && (
        <span className="text-xs" style={{ color: 'var(--error)' }}>수집 요청 실패 — 잠시 후 다시 시도하세요.</span>
      )}
      {expanded && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {coverage.excluded.map((c) => (
            <span key={c.code} className="rounded-sm bg-bg-input px-1.5 py-0.5 font-mono text-[10.5px] text-fg-dim">
              {c.name} <span className="text-fg-dimmer">{c.code}</span>
            </span>
          ))}
        </div>
      )}
    </InlineState>
  );
}
