import { useMemo } from 'react';
import { useWatchlist } from './useWatchlist';

/**
 * Single owner of watchlist membership (v3, ADR-0069). Call ONCE per component
 * (not per row). Derives a Code → set-of-folder-ids map from the exploded wire
 * entries (a multi-folder Code appears once per folder). Returns an O(1)
 * `isMember` (in ≥1 folder → heart filled) and `folderIdsOf` (the WatchlistGroupPicker's
 * check-state source). Membership is edited via the picker (useAddMember/useRemoveMember),
 * not a single toggle — there is no "미분류" add target in v3.
 */
export function useWatchlistMembership() {
  const { data } = useWatchlist();
  const foldersByCode = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of data?.entries ?? []) {
      if (e.folder_id === null) continue;  // v3 watchlist 와이어엔 null 없음(방어)
      let s = m.get(e.code);
      if (!s) { s = new Set(); m.set(e.code, s); }
      s.add(e.folder_id);
    }
    return m;
  }, [data]);
  const isMember = (code: string) => (foldersByCode.get(code)?.size ?? 0) > 0;
  const folderIdsOf = (code: string): Set<string> => foldersByCode.get(code) ?? new Set<string>();
  return { isMember, folderIdsOf };
}
