import type { StockDate } from '../api/types';
import type { StockDateGroup } from './types';

/**
 * Stock-Date를 Code 단위로 묶는 순수 함수. 정렬/검색 정책은 없음 —
 * 호출자가 자신에게 맞는 sort/filter를 위에 얹는다.
 *
 * 반환값:
 * - 그룹 순서: rows에서 처음 등장한 Code 순서(Map insertion order).
 * - 각 그룹의 `dates`: rows 내 원래 순서 그대로(정렬 없음).
 * - `lastCapturedAt`: max(captured_at), `totalSizeBytes`: sum(file_size_bytes).
 * - `name`: 같은 Code의 첫 행에서 차용.
 */
export function groupStockDatesByCode(rows: StockDate[]): StockDateGroup[] {
  const map = new Map<string, StockDate[]>();
  for (const r of rows) {
    const arr = map.get(r.code);
    if (arr) arr.push(r);
    else map.set(r.code, [r]);
  }

  const groups: StockDateGroup[] = [];
  for (const [code, dates] of map) {
    let lastCapturedAt = 0;
    let totalSizeBytes = 0;
    for (const d of dates) {
      if (d.captured_at > lastCapturedAt) lastCapturedAt = d.captured_at;
      totalSizeBytes += d.file_size_bytes;
    }
    groups.push({ code, name: dates[0].name, dates, lastCapturedAt, totalSizeBytes });
  }
  return groups;
}
