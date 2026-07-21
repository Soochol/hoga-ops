/**
 * 「데이터 수집」 — 차트 창 헤더 소유.
 *
 * 이전에는 전역 툴바에 있으면서 **활성 그룹**의 종목에 걸렸다. 즉 다른 종목을
 * 수집하려면 그 종목의 창을 먼저 활성화해야 했다 — 보조지표가 z-최상위를
 * 추론하던 것과 같은 종류의 간접층. 버튼이 창 헤더로 내려오면 "이 창이 보고
 * 있는 종목" 으로 대상이 자명해진다.
 *
 * 지수 창(KOSPI 등)은 수집할 종목 코드가 없다 — 전역 `activeStockCode` 게이트가
 * 하던 일을 창 로컬 게이트로 옮겼다(더 단순하고, 창마다 독립적으로 맞다).
 */
import { requestCollectDialog } from './collectDialogControls';
import { COMPACT_PADDING_INLINE } from './chartHeaderCompact';

export function CollectButton({
  code,
  name,
  showLabel = true,
}: {
  /** 이 창의 종목 코드. 지수이거나 종목 미선택이면 null → 비활성. */
  code: string | null;
  name: string | null;
  /** false 면 아이콘만 — 헤더가 좁을 때 라벨을 접는다(#762 접힘 정책). */
  showLabel?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid="live-collect-button"
      disabled={code == null}
      onClick={() => {
        if (code != null) requestCollectDialog({ code, name: name ?? code });
      }}
      aria-label="데이터 수집"
      title={code == null ? '데이터 수집 — 지수는 지원하지 않습니다' : '데이터 수집'}
      className="inline-flex min-h-6 shrink-0 items-center gap-1 rounded-[7px] px-2 py-1 text-xs text-fg-dim transition-colors hover:bg-bg-input-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
      style={{ background: 'transparent', paddingInline: showLabel ? undefined : COMPACT_PADDING_INLINE }}
    >
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3v12" />
        <path d="m7 11 5 4.5 5-4.5" />
        <path d="M5 21h14" />
      </svg>
      {showLabel && <span>수집</span>}
    </button>
  );
}
