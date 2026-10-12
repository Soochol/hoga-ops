import { test, expect } from '@playwright/test';
import type { CaptureReason } from '../../src/api/liveStatus';
import { installLiveMocks } from './helpers/liveMocks';
import { installLiveWs } from './helpers/liveWs';
import { apiPrefix } from './helpers/apiRoutes';

test('sync preparation and real collector failures have distinct displays', async ({ page }) => {
  await installLiveMocks(page);
  await installLiveWs(page);
  let reason: CaptureReason = 'syncing';
  await page.route(apiPrefix('live/status'), route => route.fulfill({ json: {
    running: reason !== 'offline', started_at_ms: 1, last_tick_ms: 1, cycle_lag_ms: 0,
    watchlist_count: 1, capture_healthy: reason === 'healthy', capture_reason: reason,
    rest_bypass_enabled: false, live_set: ['098460'],
  } }));
  await page.goto('/live?code=098460');
  const pill = page.getByTestId('capture-health-pill').first();
  await expect(pill).toHaveText('실시간 설정 반영 중');
  await expect(page.getByText(/실시간 미가동/)).toHaveCount(0);
  reason = 'healthy';
  await expect(page.getByTestId('capture-health-dot').first()).toBeVisible({ timeout: 10_000 });
  reason = 'offline';
  await expect(page.getByText(/실시간 미가동/)).toBeVisible({ timeout: 10_000 });
  reason = 'collector_unavailable';
  await expect(page.getByText(/실시간 수집 상태를 확인할 수 없습니다/)).toBeVisible({ timeout: 10_000 });
  reason = 'storage_error';
  await expect(page.getByText(/실시간 데이터 저장 오류/)).toBeVisible({ timeout: 10_000 });
  reason = 'healthy';
  await expect(page.getByTestId('capture-health-dot').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('live-state-banner')).toHaveCount(0);
});
