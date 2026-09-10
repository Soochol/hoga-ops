/** ka20003 codes verified in hoga/live/sector_registry.py. Unknown codes stay visible in 전체. */
const INDUSTRY_CODES = new Set([
  '005', '006', '007', '008', '009', '010', '011', '012', '013', '014', '015',
  '016', '017', '018', '019', '020', '021', '024', '025', '026', '027', '028', '029', '030',
  '103', '106', '107', '108', '110', '111', '115', '116', '117', '118', '119',
  '120', '121', '122', '123', '124', '125', '126', '127', '128', '129', '141',
]);
const INDEX_CODES = new Set([
  '001', '002', '003', '004', '101', '138', '139', '140', '142', '143', '144', '145',
  '150', '151', '160', '165', '201', '603', '604', '605',
]);
export function sectorCategory(code: string): 'industry' | 'index' | 'unknown' {
  return INDUSTRY_CODES.has(code) ? 'industry' : INDEX_CODES.has(code) ? 'index' : 'unknown';
}
