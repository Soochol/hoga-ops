import { describe, it, expect } from 'vitest';
import {
  symbolSearchHints,
  calendarHints,
  enqueueErrorHints,
  captureFinishedHints,
  symbolMasterSettingsHints,
} from './upstream-hints';
import type { UpstreamCode } from './types';

// satisfies-checked: adding a code to the UpstreamCode union without listing
// it here is a tsc error — the list can no longer silently drift from the
// union the way the previous hand-maintained array did (4/7 coverage).
const ALL_CODES = Object.keys({
  kis_holiday_fetch_failed: true,
  kis_credentials_missing: true,
  cookie_expired: true,
  cookie_missing: true,
  hogaplay_http_error: true,
  symbol_master_not_initialized: true,
  disk_write_failed: true,
  kis_master_fetch_failed: true,
} satisfies Record<UpstreamCode, true>) as UpstreamCode[];

const ALL_MAPS = {
  symbolSearchHints,
  calendarHints,
  enqueueErrorHints,
  captureFinishedHints,
  symbolMasterSettingsHints,
} as const;

describe('upstream-hints maps', () => {
  for (const [name, map] of Object.entries(ALL_MAPS)) {
    it.each(ALL_CODES)(`${name} has copy for %s`, (code) => {
      expect(map[code]).toBeDefined();
    });
  }
});
