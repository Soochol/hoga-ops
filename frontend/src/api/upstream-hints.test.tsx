import { describe, it, expect } from 'vitest';
import {
  symbolSearchHints,
  calendarHints,
  enqueueErrorHints,
  captureFinishedHints,
} from './upstream-hints';
import type { UpstreamCode } from './types';

const ALL_CODES: UpstreamCode[] = [
  'kis_holiday_fetch_failed',
  'cookie_expired',
  'cookie_missing',
  'hogaplay_http_error',
];

describe('upstream-hints maps', () => {
  it.each(ALL_CODES)('symbolSearchHints has copy for %s', (code) => {
    expect(symbolSearchHints[code]).toBeDefined();
  });
  it.each(ALL_CODES)('calendarHints has copy for %s', (code) => {
    expect(calendarHints[code]).toBeDefined();
  });
  it.each(ALL_CODES)('enqueueErrorHints has copy for %s', (code) => {
    expect(enqueueErrorHints[code]).toBeDefined();
  });
  it.each(ALL_CODES)('captureFinishedHints has copy for %s', (code) => {
    expect(captureFinishedHints[code]).toBeDefined();
  });
});
