import type { useLiveRestOrderbook } from '../../api/liveRestOrderbook';
import type { LiveVenueOption } from '../../state/liveVenue';

type RestQuery = ReturnType<typeof useLiveRestOrderbook>;

/** The REST clock has no trading date; keep that limitation next to the ladder. */
export function RestOrderbookSource({ rest, venue, testId, showProvenance = true }: {
  rest: RestQuery; venue: LiveVenueOption; testId: string; showProvenance?: boolean;
}) {
  const failed = rest.isError || rest.data?.refresh_failed || rest.data?.storage_failed;
  if (!showProvenance && !failed) return null;
  return <div className="m-2 text-xs text-fg-dim" data-testid={testId}>
    {showProvenance && <>{rest.data?.source === 'stored' ? '저장된 마지막 호가' : 'REST 마지막 호가'} · {rest.data?.book?.book_time ?? '시각 미제공'} · {venue === 'UN' ? '통합' : venue} · 거래일 미제공</>}
    {failed && <div>
      {rest.data?.storage_failed ? '호가 저장 실패' : '최신 호가 조회 실패'}
      <button type="button" className="ml-2" onClick={() => { void rest.refetch(); }}>다시 조회</button>
    </div>}
  </div>;
}

export function RestOrderbookEmpty({ rest, loading, onRetry, testId }: {
  rest: RestQuery; loading: boolean; onRetry: () => void; testId: string;
}) {
  return <div className="m-2 text-xs text-fg-dim" data-testid={testId}>
    {loading ? '마지막 호가 불러오는 중…'
      : rest.isError || rest.data?.refresh_failed ? '마지막 호가 조회 실패' : '저장된 마지막 호가가 없습니다'}
    {!loading && <button type="button" className="ml-2" onClick={() => { void rest.refetch(); onRetry(); }}>다시 조회</button>}
  </div>;
}
