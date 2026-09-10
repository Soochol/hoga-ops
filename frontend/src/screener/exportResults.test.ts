import { expect, it } from 'vitest';
import { resultsCsv } from './exportResults';
import type { PanelScan } from '../state/screenerPanel';

it('CSV는 시점별 값을 분리하고 요청·기준·시각·경고와 한글/선행 0을 보존한다', () => {
  const scan: PanelScan = {
    savedId: null, savedName: '=DANGEROUS()', savedUpdatedAtMs: null, scanKey: null,
    requestJson: '{"conditions":[{"id":"c1","type":"price_range","params":{"min":100}}],"basis":"eod"}',
    rows: [{ code: '005930', name: '삼성,"전자"\n우', market: 'KOSPI', price: 100, change_pct: -2,
      trade_value_won: 1234, price_date: '2026-09-07', history_matches: [{ condition_id: 'v',
        date: '2020-03-19', volume: 1000, maximum: 1000, window_start: '2018-03-20', window_end: '2020-03-19' },
        { condition_id: 'tv', date: '2019-01-02', trade_value_won: 100000000 }] }],
    scanStatus: 'ok', warnings: ['intraday_quote_invalid'], depthValues: null,
    scannedAtMs: Date.UTC(2026, 8, 8, 1), basis: 'eod', dataStale: true, hasMore: true,
  };
  const live = [{ ...scan.rows[0], price: 200, change_pct: 5, change_won: 100, expected_price: 220, expected_change_pct: 6 }];
  const csv = resultsCsv(scan, ['005930', 'missing'], live, Date.UTC(2026, 8, 8, 2));
  expect(csv.startsWith('\uFEFF')).toBe(true);
  expect(csv).toContain('"\'005930","삼성,""전자""\n우","KOSPI","100","-2","2026-09-07","1234","200","5","220","6"');
  expect(csv).toContain('"2026-09-08 10:00:00+09:00","2026-09-08 11:00:00+09:00"');
  expect(csv).toContain('"\'=DANGEROUS()"');
  expect(csv).toContain(scan.requestJson!.replaceAll('"', '""'));
  expect(csv).toContain('"intraday_quote_invalid","예","예","v: 2020-03-19 1000주 (2018-03-20~2020-03-19)","tv: 2019-01-02 100000000원 (추정)","[]"\r\n');
  expect(csv).not.toContain('missing');
  const legacy = resultsCsv({ ...scan, requestJson: undefined, hasMore: undefined }, ['005930'], [], scan.scannedAtMs);
  expect(legacy).toContain('"기록 없음"');
  expect(legacy).toContain('"미확인"');
  expect(legacy).toContain('"1234","","","",""');
});
