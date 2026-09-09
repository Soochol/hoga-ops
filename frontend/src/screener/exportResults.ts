import { occurrenceRows, resultKey } from './occurrenceRows';
import type { PanelScan } from '../state/screenerPanel';
import type { ScreenerRowLive } from './useScreenerRowsLive';

/** 숫자는 숫자로, 외부 텍스트는 스프레드시트 수식으로 실행되지 않게 내보낸다. */
function csvCell(value: string | number | null | undefined): string {
  let text = value == null ? '' : String(value);
  if (typeof value === 'string' && /^[\s]*[=+\-@]|^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function kstTimestamp(ms: number): string {
  return `${new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')}+09:00`;
}

/** 선택은 발생 건 키를 사용하며 현재 시세만 code로 결합한다.
 *  편집 중인 조건이나 표시 모드를 입력으로 받지 않아 조회 근거가 바뀌지 않는다. */
export function resultsCsv(
  scan: PanelScan, eventKeys: readonly string[], liveRows: readonly ScreenerRowLive[], exportedAtMs: number,
): string {
  const snapshots = new Map(occurrenceRows(scan.rows).map((r) => [resultKey(r), r]));
  const live = new Map(liveRows.map((r) => [r.code, r]));
  const header = [
    '종목코드', '종목명', '시장', '조회가격(원)', '조회등락률(%)', '조회가격 기준일',
    '거래대금(조회 당시 추정·원)', '현재가(마지막 수신·원)', '현재등락률(%)',
    '예상체결가(원)', '예상등락률(%)', '조회기준', '조회완료시각(KST)', '내보낸시각(KST)',
    '조건검색명', '조회요청(JSON)', '조회경고', '상한초과', '데이터갱신후 재조회필요', '과거 거래량 조건 충족 기록', '과거 거래대금 조건 충족 기록', '발생 건(JSON)', '발생일', '조건 ID',
  ];
  const records = eventKeys.flatMap((key) => {
    const row = snapshots.get(key);
    if (!row) return [];
    const quote = live.get(row.code);
    return [[
      // Excel에서 005930의 선행 0을 보존한다. 수식을 생성하지 않는 텍스트 접두사.
      `'${row.code}`, row.name, row.market, row.price, row.change_pct, row.price_date,
      row.trade_value_won, quote?.price, quote?.change_pct,
      quote?.expected_price, quote?.expected_change_pct,
      scan.basis === 'intraday' ? '오늘 장중' : '전일 확정', kstTimestamp(scan.scannedAtMs),
      kstTimestamp(exportedAtMs), scan.savedName ?? '임시 조건',
      scan.requestJson ?? scan.scanKey ?? '기록 없음',
      [...scan.warnings, ...(scan.intradayFailure ? [JSON.stringify(scan.intradayFailure)] : [])].join(' | '),
      scan.hasMore == null ? '미확인' : scan.hasMore ? '예' : '아니오', scan.dataStale ? '예' : '아니오',
      (row.history_matches ?? []).filter(m => 'volume' in m)
        .map(m => `${m.condition_id}: ${m.date} ${m.volume}주 (${m.window_start}~${m.window_end})`).join(' / '),
      (row.history_matches ?? []).filter(m => 'trade_value_won' in m)
        .map(m => `${m.condition_id}: ${m.date} ${m.trade_value_won}원 (추정)`).join(' / '),
      JSON.stringify(row.occurrences ?? []), row.occurrence?.date, row.occurrence?.condition_id,
    ]];
  });
  // UTF-8 BOM + CRLF: 한글 CSV를 Excel에서도 그대로 읽는다.
  return `\uFEFF${[header, ...records].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function downloadResultsCsv(scan: PanelScan, eventKeys: readonly string[], liveRows: readonly ScreenerRowLive[]): void {
  const now = Date.now();
  const url = URL.createObjectURL(new Blob([resultsCsv(scan, eventKeys, liveRows, now)], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `screener-${kstTimestamp(now).slice(0, 19).replaceAll(/[- :]/g, '')}.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
