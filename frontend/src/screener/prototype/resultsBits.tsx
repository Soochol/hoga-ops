// ============================================================================
// PROTOTYPE — throwaway. 변형들이 공유하는 "결과" leaf 블록: 메타 줄(개수·기준·
// 시각·상태 칩)과 본문(빈 상태 4분리 + ResultTable). 레이아웃은 각 변형이 소유하고,
// 여기는 배치 불가침의 말단 조각만 둔다.
// ============================================================================
import { ResultTable } from '../ResultTable';
import { DepthCoverageBanner } from '../DepthCoverageBanner';
import { EmptyState, InlineState } from '../../ui/DataSurface';
import { ScreenerUpdateProgress } from '../ScreenerUpdateProgress';
import { StalenessChip } from '../StalenessChip';
import {
  basisLabel,
  collectStatusFlags,
  fmtScannedAt,
  type ScreenerViewProps,
  type StatusFlag,
} from './variantShared';

/** 우선순위 1위만 배너로, 나머지는 칩으로 — 제안 ⑧의 "배너 다이어트". */
export function splitFlags(p: ScreenerViewProps): { banner: StatusFlag | null; chips: StatusFlag[] } {
  const flags = collectStatusFlags(p);
  const banner = flags.find((f) => f.weight === 'banner') ?? null;
  return { banner, chips: flags.filter((f) => f !== banner) };
}

/** "결과 N건 · 기준 · HH:MM 조회" + 상태 칩 — 제안 ②. */
export function ResultsMetaLine({ p, chips }: { p: ScreenerViewProps; chips: StatusFlag[] }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {p.lastScan ? (
        <span className="font-data text-sm tabular-nums text-fg">
          결과 <span className="font-semibold">{p.rows.length.toLocaleString('ko-KR')}</span>건
          <span className="text-fg-dim"> · {basisLabel(p.lastScan.basis)} · {fmtScannedAt(p.lastScan.scannedAtMs)} 조회</span>
        </span>
      ) : (
        <span className="text-sm text-fg-dim">조회 전</span>
      )}
      {chips.map((f) => (
        <span key={f.key} title={f.text}
          className="max-w-[16rem] truncate rounded-md bg-bg-subtle px-1.5 py-0.5 text-2xs"
          style={{ color: 'var(--warn)' }}>
          {f.text}
        </span>
      ))}
      <span className="min-w-0 flex-1" />
      <ScreenerUpdateProgress updating={p.status?.updating} />
      <StalenessChip status={p.status} />
    </div>
  );
}

/** 빈 상태 4분리(시드 필요/조회 실패/조회 전/결과 테이블) — 제안 ③. */
export function ResultsBody({ p }: { p: ScreenerViewProps }) {
  if (p.notSeeded) {
    return (
      <InlineState tone="warn" className="text-sm">
        <span className="font-semibold">시드 필요</span> 스크리너 인덱스가 아직 시드되지 않았습니다. 운영자 CLI로 일회성 시드를 수행한 뒤 다시 조회하세요
      </InlineState>
    );
  }
  if (p.scanFailed) {
    return (
      <InlineState tone="error" className="text-sm">
        <span className="font-semibold">조회 실패 — 조건을 확인하세요</span>
        {p.scanErrorMessage && <span className="ml-2 text-fg-dim">{p.scanErrorMessage}</span>}
      </InlineState>
    );
  }
  if (p.lastScan == null) {
    return (
      <EmptyState className="flex-1" title="아직 조회하지 않았습니다">
        조건을 확인하고 조회를 누르면 결과가 여기 표시됩니다 · 결과는 30분 뒤 만료됩니다
      </EmptyState>
    );
  }
  return (
    <>
      {p.depthCoverage && (
        <DepthCoverageBanner
          key={p.depthCoverage.excluded.map((c) => c.code).join(',')}
          coverage={p.depthCoverage}
          autoCollect={p.autoCollect}
        />
      )}
      <ResultTable
        rows={p.rows}
        onActivate={p.openLive}
        sortMode={p.sortMode}
        onSortChange={p.setSortMode}
        embedded
        depthValues={p.depthValues ?? undefined}
        depthSides={p.depthSides}
      />
    </>
  );
}

/** 배너 1개(있을 때만) — InlineState 재사용. */
export function TopFlagBanner({ banner }: { banner: StatusFlag | null }) {
  if (!banner) return null;
  return <InlineState tone="warn">{banner.text}</InlineState>;
}
