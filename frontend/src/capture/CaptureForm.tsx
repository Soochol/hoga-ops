import { useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SymbolSearch } from './SymbolSearch';
import { DateRangePicker, type DateRange } from './DateRangePicker';
import { useCaptureQueue } from './useCaptureQueue';
import { useSymbols, filterSymbols } from './useSymbols';
import { coveragePreview } from '../api/captures';
import { enqueueErrorHints, enqueueWarningHints } from '../api/upstream-hints';
import type { ApiError } from '../api/client';
import type { BlockedItem, EnqueueResponse, SymbolHit, UpstreamCode } from '../api/types';
import { legendText } from './calendarStatus';
import { FormField, InlineState } from '../ui/DataSurface';

function formatBlockedMessage(items: BlockedItem[]): string {
  // Noun-phrase + em-dash + cause, matching the existing tone from
  // CaptureRowDetail.test.tsx:154 ("캡처 실패 — hogaplay 쿠키 만료")
  // and DESIGN.md L249-250's "Korean single words" guidance.
  const pairs = items.map((b) => `${b.code}/${b.date}`).join(', ');
  return `5회 연속 실패 — 인벤토리에서 잠금 해제 필요 (${pairs})`;
}

/** 큐 행 클릭이 폼으로 밀어 넣는 종목 선택. `code` 만으로는 부족하다 — 사용자가
 *  폼에서 다른 종목으로 바꾼 뒤 큐의 **같은 행**을 다시 누르면 code 가 그대로라
 *  변화가 없어 반영되지 않는다. seq 는 "값"이 아니라 "이벤트"임을 표현한다. */
export interface SymbolPick {
  code: string;
  seq: number;
}

/** 6자리 코드를 심볼 캐시로 해석한다. 캐시에 없으면(미검증 코드) 이름 자리를
 *  비운 placeholder 를 돌려줘 폼이 최소한 코드는 물고 있게 한다. */
function resolveSymbol(symbols: SymbolHit[], rawCode: string): SymbolHit | null {
  const code = rawCode.trim();
  if (!/^\d{6}$/.test(code)) return null;
  return filterSymbols(symbols, code, 1).find((h) => h.code === code) ?? {
    code, name: '—', market: 'KOSPI', captured_count: 0,
    captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 },
  };
}

export interface CaptureFormProps {
  /** Reference month for DateRangePicker's left grid. Defaults to current KST month. */
  referenceYear: number;
  referenceMonth: number;
  /** 6-digit code to prefill the symbol field (e.g. the Screener row 캡처 button
   *  routes here with ?code=…). Resolved against the symbol cache for the real
   *  name/market; an unverified code still prefills as a placeholder. */
  initialCode?: string | null;
  /** 우측 캡처 대기열의 행을 클릭했을 때 선택된 종목. 각 seq 는 정확히 한 번만
   *  소비된다 — 소비 후 사용자가 폼에서 고른 종목을 덮어쓰지 않는다. */
  picked?: SymbolPick | null;
}

export function CaptureForm({
  referenceYear, referenceMonth, initialCode = null, picked = null,
}: CaptureFormProps) {
  const [symbol, setSymbol] = useState<SymbolHit | null>(null);
  const [range, setRange] = useState<DateRange | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<ReactNode>(null);
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null);
  // 성공했지만 날짜 목록이 추정치(평일 기준)인 경우의 알림 — 에러가 아니라 warn 톤.
  const [enqueueWarning, setEnqueueWarning] = useState<ReactNode | null>(null);

  // Prefill the symbol from ?code once the cache has resolved (so we get the real
  // name/market); fall back to a placeholder for an unverified 6-digit code.
  // Applied during render (React's "adjust state on prop change" pattern, not an
  // effect) and gated on prefilledCode so the user's later selection is never
  // clobbered — each initialCode is consumed exactly once.
  const { data: symbolsData } = useSymbols();
  const [prefilledCode, setPrefilledCode] = useState<string | null>(null);
  if (initialCode && initialCode !== prefilledCode && symbolsData !== undefined) {
    setPrefilledCode(initialCode);
    const hit = resolveSymbol(symbolsData.symbols ?? [], initialCode);
    if (hit !== null) setSymbol(hit);
  }

  // 대기열 행 클릭 → 종목 필드 반영. initialCode 와 같은 render-phase 패턴이지만
  // 판정 기준이 code 가 아니라 seq 다(위 SymbolPick 주석 참고). 심볼 캐시가 아직
  // 안 왔으면 seq 를 소비하지 않고 넘어가 도착 후 자동으로 적용된다.
  const [appliedPickSeq, setAppliedPickSeq] = useState(0);
  if (picked !== null && picked.seq !== appliedPickSeq && symbolsData !== undefined) {
    setAppliedPickSeq(picked.seq);
    const hit = resolveSymbol(symbolsData.symbols ?? [], picked.code);
    if (hit !== null) setSymbol(hit);
  }

  const { addItems, queue } = useCaptureQueue();
  const valid = symbol !== null && range !== null && range.end !== null;
  // ADR-0094: 읽기 전용(비소유) 인스턴스는 큐를 변경할 수 없다 — 우측 pane 배너만
  // 경고하고 이 버튼은 활성이던 비대칭을 닫는다(좌우 pane 이 서로를 모르던 문제).
  const notOwned = queue?.queue_owned === false;

  // 커버리지 미리보기 — 범위를 완성하면 "보유/수집 예정/예상 소요"를 시작 전에
  // 보여준다. 히트맵 수집 다이얼로그에는 있던 미리보기가 정작 전용 폼에 없었다.
  const previewQ = useQuery({
    queryKey: ['capture', 'coverage-preview', symbol?.code ?? '', range?.start ?? '', range?.end ?? ''],
    queryFn: () => coveragePreview({
      codes: [symbol!.code], start_date: range!.start, end_date: range!.end!,
    }),
    enabled: valid,
    staleTime: 60_000,
  });

  const onStart = async () => {
    if (!valid) return;
    setError(null);
    setInlineError(null);
    setBlockedMessage(null);
    try {
      const resp = await addItems.mutateAsync({
        code: symbol!.code,
        start_date: range!.start,
        end_date: range!.end!,
        force_retry: false,
      });
      // ADR-0042: 201 partial-success path — some items accepted, some blocked.
      if (resp.blocked && resp.blocked.length > 0) {
        setBlockedMessage(formatBlockedMessage(resp.blocked));
      }
      // 성공했지만 날짜 목록이 추정치인 경우 — 조용히 넘기면 나중에 "왜 휴장일이
      // 큐에 있지?" 로 돌아온다.
      setEnqueueWarning(resp.warning ? enqueueWarningHints[resp.warning] ?? null : null);
      // On a successful enqueue, clear the date range so the picker returns to a
      // fresh slate and Start re-disables (valid = symbol && range.end). This
      // prevents an accidental double-submit of the same range; the symbol is
      // kept so the user can immediately queue another range for the same stock.
      // Failure paths (409 all-blocked, upstream errors) return early in catch,
      // preserving the selection for retry.
      setRange(null);
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      // ADR-0042: 409 all-blocked path — the entire request body is the
      // EnqueueResponse with non-empty `blocked`. ApiError carries it as .data.
      if (apiErr.status === 409 && apiErr.data) {
        const body = apiErr.data as Partial<EnqueueResponse>;
        if (body.blocked && body.blocked.length > 0) {
          setBlockedMessage(formatBlockedMessage(body.blocked));
          return;
        }
      }
      const code = apiErr.code;
      if (code && code in enqueueErrorHints) {
        setInlineError(enqueueErrorHints[code as UpstreamCode]);
        return;
      }
      const msg = err instanceof Error ? err.message : '캡처 요청 실패';
      setError(msg);
    }
  };

  return (
    <div className="flex flex-col gap-4 font-ui">
      <FormField label="종목">
        <SymbolSearch value={symbol} onChange={setSymbol} />
      </FormField>

      <FormField label="기간">
        <DateRangePicker
          code={symbol?.code ?? null}
          referenceYear={referenceYear}
          referenceMonth={referenceMonth}
          value={range}
          onChange={setRange}
        />
      </FormField>

      {valid && (
        <div role="status" data-testid="coverage-preview-line"
          className="text-xs font-data tabular-nums text-fg-dim">
          {previewQ.isPending
            ? '커버리지 확인 중…'
            : previewQ.isError
              ? '커버리지 확인 실패 — 조회 없이 시작할 수 있습니다'
              : [
                  `선택 ${previewQ.data.total}건 중 보유 ${previewQ.data.have}`,
                  previewQ.data.no_upstream > 0 ? `업스트림 없음 ${previewQ.data.no_upstream}` : null,
                  `수집 예정 ${previewQ.data.to_collect}`,
                  previewQ.data.to_collect > 0 && previewQ.data.est_minutes > 0
                    ? `예상 약 ${previewQ.data.est_minutes}분` : null,
                ].filter(Boolean).join(' · ')}
        </div>
      )}

      <button
        type="button"
        onClick={onStart}
        disabled={!valid || notOwned}
        title={notOwned ? '다른 서버 인스턴스가 캡처 큐를 소유 중입니다 — 이 인스턴스에서는 시작할 수 없습니다' : undefined}
        style={{
          // disabled 배경은 --bg-input 이 아니라 --bg-subtle — Ledger 는
          // --bg-input == --bg(#FDFCF8) 라 버튼 면이 통째로 사라졌다(2026-08-04
          // 조사 #13). --bg-subtle 은 4개 테마 전부에서 바닥과 명도차를 가진다.
          background: valid && !notOwned ? 'var(--accent)' : 'var(--bg-subtle)',
          color: valid && !notOwned ? 'var(--bg)' : 'var(--fg-dimmer)',
        }}
        className="border-none rounded-lg py-2.5 px-4.5 font-semibold text-base cursor-pointer disabled:cursor-not-allowed"
      >
        ▶ 캡처 시작
      </button>

      {error !== null && (
        <InlineState role="alert" tone="error" className="border-0 bg-transparent p-0 text-xs">{error}</InlineState>
      )}

      {enqueueWarning !== null && (
        <InlineState role="status" tone="warn" className="mt-2" data-testid="enqueue-warning">
          {enqueueWarning}
        </InlineState>
      )}

      {blockedMessage !== null && (
        <InlineState
          role="alert"
          tone="error"
          className="mt-2"
        >
          {blockedMessage}
        </InlineState>
      )}

      {inlineError !== null && (
        <InlineState
          role="alert"
          tone="neutral"
          className="mt-2 text-error"
        >
          {inlineError}
        </InlineState>
      )}

      <div className="mt-3 text-xs text-fg-dim">
        {legendText()}
      </div>
    </div>
  );
}
