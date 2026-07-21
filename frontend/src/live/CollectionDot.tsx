import { DISPLAY_PRESENTATION, type DisplayStatus } from './collectionStatus';

interface Props {
  status: DisplayStatus;
}

/** 수집/연결 상태를 점(정상) 또는 점+라벨(예외)로 표현. uncollected는 미렌더.
 *  DISPLAY_PRESENTATION 단일 매핑을 LiveStatusBar(종목 앞)·WatchlistDrawer(행)가
 *  공유한다. 점만 표시되는 정상 상태도 aria-label/title로 의미를 전달(접근성). */
export function CollectionDot({ status }: Props) {
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
      {label && <span>{label}</span>}
    </span>
  );
}
