import { DISPLAY_PRESENTATION, type DisplayStatus } from './collectionStatus';

interface Props {
  status: DisplayStatus;
  /**
   * 라벨을 글자로 보일지. 기본 `true`(타이틀바). **좁은 자리는 `false` 로 끈다.**
   *
   * 관심종목 드로어 행(280px)에서 실측한 결과, 라벨이 들어오면 트레일링 슬롯이
   * 20 → 59px 로 벌어지면서 **종목명이 52 → 13px 로 짜부러졌다**(2026-08-10).
   * 그 행에서 종목명은 라벨보다 중요하다 — 어느 종목인지 모르면 상태를 알아도
   * 쓸모가 없다. 라벨을 끄더라도 `title`·`aria-label` 이 같은 문구를 그대로
   * 전달하므로 정보는 사라지지 않는다.
   */
  showLabel?: boolean;
}

/** 수집/연결 상태를 점(정상) 또는 점+라벨(예외)로 표현. uncollected는 미렌더.
 *  DISPLAY_PRESENTATION 단일 매핑을 LiveStatusBar(종목 앞)·WatchlistDrawer(행)가
 *  공유한다. 점만 표시되는 정상 상태도 aria-label/title로 의미를 전달(접근성). */
export function CollectionDot({ status, showLabel = true }: Props) {
  if (status === 'uncollected') return null;
  const { label, colorVar, ariaLabel } = DISPLAY_PRESENTATION[status];
  return (
    <span
      data-testid={`collection-dot-${status}`}
      title={ariaLabel}
      role="img"
      aria-label={ariaLabel}
      className="inline-flex items-center gap-1 font-data"
      style={{ color: colorVar, fontSize: 'var(--text-xs)' }}
    >
      <span
        aria-hidden
        className="inline-block rounded-full"
        style={{
          width: '6px',
          height: '6px',
          background: colorVar,
          boxShadow: status === 'realtime' ? `0 0 4px ${colorVar}` : undefined,
        }}
      />
      {showLabel && label && <span>{label}</span>}
    </span>
  );
}
