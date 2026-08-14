import { describe, it, expect } from 'vitest';
import { groupByFolder } from './grouping';
import type { WatchlistEntry } from '../api/watchlist';
import fx from './__fixtures__/watchlistDisplayOrder.json';

// 표시 순서 계약(ADR-0070, deepening 2): 백엔드 display_ordered_codes 와 같은 공유 골든
// 픽스처를 읽어, groupByFolder 평탄화 + 첫등장 dedup 이 백엔드 display_order 와 일치함을
// 검증한다. 한쪽 정렬 규칙만 바뀌어도 한쪽 테스트가 깨지도록 계약을 코드로 박는다.
// (fx.folders 는 store shape — v4 items 보유; 와이어 WatchlistFolder 는 {id,name,order}.)
type FixtureItem = { kind: 'code'; code: string } | { kind: 'memo'; id: string; text: string };
type FixtureFolder = { id: string; name: string; order: number; items: FixtureItem[] };

// 백엔드 라우트 _project 가 보내는 와이어(폴더×코드로 펼친 entries)를 픽스처 folders 로
// 재현한다. **order 는 items 인덱스**라 메모가 낀 자리를 건너뛴다(백엔드
// project_entry_views 와 같은 축) — 그래서 값이 띄엄띄엄해지고, 이 테스트가 groupByFolder
// 의 정렬이 "조밀한 0..N-1" 을 가정하지 않는지도 함께 잰다.
function projectExploded(folders: FixtureFolder[]): WatchlistEntry[] {
  const out: WatchlistEntry[] = [];
  for (const f of folders) {
    f.items.forEach((item, order) => {
      if (item.kind !== 'code') return;   // 메모는 entries 에 안 실린다(별도 memos 배열)
      out.push({
        code: item.code, name: item.code, registered_at_kst_date: '20260101',
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
