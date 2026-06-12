import { describe, it, expect } from 'vitest';
import { groupByFolder } from './grouping';
import type { WatchlistEntry } from '../api/watchlist';
import fx from './__fixtures__/watchlistDisplayOrder.json';

// 표시 순서 계약(ADR-0069, deepening 2): 백엔드 display_ordered_codes 와 같은 공유 골든
// 픽스처를 읽어, groupByFolder 평탄화 + 첫등장 dedup 이 백엔드 display_order 와 일치함을
// 검증한다. 한쪽 정렬 규칙만 바뀌어도 한쪽 테스트가 깨지도록 계약을 코드로 박는다.
// (fx.folders 는 store shape — member_codes 보유; 와이어 WatchlistFolder 는 {id,name,order}.)
type FixtureFolder = { id: string; name: string; order: number; member_codes: string[] };

// 백엔드 라우트 _project 가 보내는 와이어(폴더×코드로 펼친 entries)를 픽스처 folders 로 재현.
function projectExploded(folders: FixtureFolder[]): WatchlistEntry[] {
  const out: WatchlistEntry[] = [];
  for (const f of folders) {
    f.member_codes.forEach((code, order) => {
      out.push({
        code, name: code, registered_at_kst_date: '20260101',
        last_success_date: null, folder_id: f.id, order,
      });
    });
  }
  return out;
}

function dedupeFirst(codes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of codes) if (!seen.has(c)) { seen.add(c); out.push(c); }
  return out;
}

describe('Watchlist Panel display-order contract (shared golden fixture)', () => {
  it('groupByFolder flatten+dedup matches the backend display_order', () => {
    const folders = fx.folders as FixtureFolder[];
    const entries = projectExploded(folders);
    // groupByFolder 의 folders 파라미터는 {id,name,order} — FixtureFolder 는 그 상위호환.
    const groups = groupByFolder(folders, entries);
    const flat = groups.flatMap((g) => g.entries.map((e) => e.code));
    expect(dedupeFirst(flat)).toEqual(fx.display_order);
  });
});
