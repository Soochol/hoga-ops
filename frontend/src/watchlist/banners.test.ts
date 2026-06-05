import { describe, it, expect } from 'vitest';
import {
  formatCaughtUpOneMessage,
  summarizeCaughtUpAll,
  formatCaughtUpAllHeader,
} from './banners';

describe('formatCaughtUpOneMessage', () => {
  const base = { name: '대한항공', code: '003490' };

  it('error: shows 수집 실패 with error string', () => {
    expect(formatCaughtUpOneMessage({
      ...base, enqueued: 0, deduped: 0, error: 'kis_holiday_fetch_failed',
    })).toBe('대한항공 (003490) 수집 실패: kis_holiday_fetch_failed');
  });

  it('empty-empty: shows 수집할 거래일 없음', () => {
    expect(formatCaughtUpOneMessage({
      ...base, enqueued: 0, deduped: 0,
    })).toBe('대한항공 (003490) 수집할 거래일 없음');
  });

  it('deduped-only: shows 이미 모두 수집됨', () => {
    expect(formatCaughtUpOneMessage({
      ...base, enqueued: 0, deduped: 5,
    })).toBe('✓ 대한항공 (003490) 이미 모두 수집됨 (5건)');
  });

  it('enqueued-only: shows just 추가', () => {
    expect(formatCaughtUpOneMessage({
      ...base, enqueued: 2, deduped: 0,
    })).toBe('✓ 대한항공 (003490) 수집 대기 중 — 2건 추가');
  });

  it('both: shows 추가 and 이미 완료', () => {
    expect(formatCaughtUpOneMessage({
      ...base, enqueued: 2, deduped: 1,
    })).toBe('✓ 대한항공 (003490) 수집 대기 중 — 2건 추가, 1건 이미 완료');
  });

  it('error takes precedence over counts', () => {
    expect(formatCaughtUpOneMessage({
      ...base, enqueued: 5, deduped: 3, error: 'boom',
    })).toContain('수집 실패: boom');
  });
});

describe('summarizeCaughtUpAll', () => {
  it('empty input', () => {
    const s = summarizeCaughtUpAll([]);
    expect(s).toEqual({ total: 0, enqueuedTotal: 0, dedupedTotal: 0, failed: [] });
  });

  it('sums enqueued + deduped across entries', () => {
    const s = summarizeCaughtUpAll([
      { code: '003490', name: '대한항공', enqueued_count: 2, deduped_count: 1, error: null },
      { code: '005930', name: '삼성전자', enqueued_count: 0, deduped_count: 3, error: null },
    ]);
    expect(s.total).toBe(2);
    expect(s.enqueuedTotal).toBe(2);
    expect(s.dedupedTotal).toBe(4);
    expect(s.failed).toEqual([]);
  });

  it('collects failed entries (error != null)', () => {
    const failed = { code: '003490', name: '대한항공',
                     enqueued_count: 0, deduped_count: 0,
                     error: { code: 'kis_holiday_fetch_failed', message: 'no creds' } };
    const ok = { code: '005930', name: '삼성전자',
                 enqueued_count: 1, deduped_count: 0, error: null };
    const s = summarizeCaughtUpAll([failed, ok]);
    expect(s.failed).toEqual([failed]);
  });
});

describe('formatCaughtUpAllHeader', () => {
  it('no failures: omits 실패 suffix', () => {
    expect(formatCaughtUpAllHeader({
      total: 2, enqueuedTotal: 3, dedupedTotal: 5, failed: [],
    })).toBe('✓ 전체 catch-up: 2종목, 3건 추가, 5건 이미 완료');
  });

  it('with failures: appends 종목 실패', () => {
    expect(formatCaughtUpAllHeader({
      total: 3, enqueuedTotal: 1, dedupedTotal: 2,
      failed: [{
        code: '003490', name: '대한항공',
        enqueued_count: 0, deduped_count: 0,
        error: { code: 'kis_holiday_fetch_failed', message: 'no creds' },
      }],
    })).toBe('✓ 전체 catch-up: 3종목, 1건 추가, 2건 이미 완료, 1종목 실패');
  });
});
