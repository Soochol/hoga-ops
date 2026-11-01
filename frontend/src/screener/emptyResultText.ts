import type { PanelScan } from '../state/screenerPanel';

export function emptyResultText(scan: Pick<PanelScan, 'warnings' | 'barCoverage' | 'dailyCoverage' | 'historyCoverage'>): string {
  if (scan.warnings.includes('separate_bases_not_prepared')) return '계산에 필요한 일봉이 준비되지 않았습니다';
  const coverage = [scan.barCoverage, scan.dailyCoverage, scan.historyCoverage].filter(c => c != null);
  if (coverage.some(c => c.total > 0 && c.complete === 0 && c.incomplete.length > 0)) {
    return '데이터 부족으로 조건을 평가할 수 없습니다';
  }
  if (coverage.some(c => c.incomplete.length > 0)) return '평가한 범위에서 조건에 맞는 종목이 없습니다 · 일부 종목 평가 보류';
  return '조건에 맞는 종목이 없습니다';
}
