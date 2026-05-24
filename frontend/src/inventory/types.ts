import type { StockDate } from '../api/types';

/**
 * Inventory 페이지에서 사용하는, Code 단위로 압축된 Stock-Date 묶음.
 * CONTEXT.md 참조 — Stock-Date 위에 compound로 얹은 도메인 용어.
 */
export type StockDateGroup = {
  code: string;
  name: string;
  dates: StockDate[];      // date desc 정렬
  lastCapturedAt: number;  // max(captured_at) — 부모 정렬 키
  totalSizeBytes: number;  // sum(file_size_bytes)
};
