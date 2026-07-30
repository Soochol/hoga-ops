// 달력 셀의 disk_state 마커(✓ ⚠ ✕) + COMPLETE 스킵 + 보유 창 밖 갭 스킵.
//
// **날짜를 하드코딩하지 않는다.** 이전 판은 20260501/02/03 을 박아 뒀는데, 달력은
// 언제나 **현재 달**을 열기 때문에 작성 시점(2026-05)이 지나면 셀이 아예 렌더링되지
// 않았다 — `element(s) not found`. 게다가 20260502·03 은 토·일이라 비활성 셀이어서
// 클릭하는 테스트는 통과한 적이 없다. DOM 이 보여주는 **선택 가능한** 날짜를 읽어
// 거기에 픽스처를 심으면 시간에 묶이지 않는다.

import { test, expect } from '@playwright/test';
import { promises as fs } from 'fs';
import path from 'path';
import { previousMonth, selectSymbol, tradingDates } from './helpers/calendar';

const DATA_DIR = '/tmp/hoga-e2e-data';
const CODE = '005930';

const API = 'http://127.0.0.1:8765';

/** 진짜 Stock-Date 를 만든 뒤 meta 만 변형한다.
 *
 *  meta.json 만 심으면 `check_disk_state` 는 올바로 분류하지만 **달력에는 안 뜬다** —
 *  `QueryEngine.list_stock_dates` 가 parquet 통계를 함께 읽어서 조립하므로, parquet
 *  파일이 없는 Stock-Date 는 목록에서 탈락한다(실측: 심은 3일이 목록에 0건). 그래서
 *  `/api/test/add-stockdate` 로 파서까지 돌린 실물을 만들고, 그 meta 의 두 플래그만
 *  바꿔 원하는 disk_state 를 만든다. */
async function seedStockDate(date: string): Promise<string> {
  const res = await fetch(`${API}/api/test/add-stockdate?code=${CODE}&date=${date}`, { method: 'POST' });
  expect(res.ok, `add-stockdate ${date} 실패: ${res.status}`).toBe(true);
  return path.join(DATA_DIR, 'parquet', date, CODE, 'hogaplay', 'meta.json');
}

async function seedWithMeta(date: string, patch: Record<string, boolean>): Promise<void> {
  const metaPath = await seedStockDate(date);
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as Record<string, unknown>;
  await fs.writeFile(metaPath, JSON.stringify({ ...meta, ...patch }));
}

/** COMPLETE — 수집 완료 + 갭 없음. */
const seedComplete = (date: string) =>
  seedWithMeta(date, { collection_complete: true, is_partial: false });

/** SOURCE_PARTIAL — 수집은 끝났으나 업스트림에 구멍. */
const seedSourcePartial = (date: string) =>
  seedWithMeta(date, { collection_complete: true, is_partial: true });

/** CLIENT_INCOMPLETE — 수집이 중간에 끊김. */
const seedClientIncomplete = (date: string) =>
  seedWithMeta(date, { collection_complete: false, is_partial: false });

test('calendar-markers: ✓ ⚠ ✕ render per disk_state', async ({ page }) => {
  await selectSymbol(page);
  // **테스트마다 겹치지 않는 날짜를 쓴다** — fullyParallel 이라 같은 날짜를 고르면
  // 서로의 픽스처를 덮어쓴다(실제로 겪었다: 3번의 source_partial 이 1번의 complete 를
  // 지워 ✓ 자리에 ⚠ 가 떴다). skip 오프셋으로 구간을 나눈다.
  const [dComplete, dPartial, dBroken] = await tradingDates(page, 3);

  await seedComplete(dComplete);
  await seedSourcePartial(dPartial);
  await seedClientIncomplete(dBroken);

  // 심은 뒤 다시 진입 — stock-dates 쿼리를 새로 받는다. 재진입하면 달력이 이번 달로
  // 돌아오므로 전월로 다시 넘긴다(고른 날짜가 전월이다).
  await selectSymbol(page);
  await previousMonth(page);

  await expect(page.getByTestId(`calendar-cell-${dComplete}`)).toContainText('✓');
  await expect(page.getByTestId(`calendar-cell-${dPartial}`)).toContainText('⚠');
  await expect(page.getByTestId(`calendar-cell-${dBroken}`)).toContainText('✕');
});

test('calendar-markers: complete date Start → immediately skipped/already_complete', async ({ page }) => {
  await selectSymbol(page);
  const [date] = await tradingDates(page, 1, 3);   // 1번 테스트가 쓰는 0..2 를 피한다
  await seedComplete(date);
  await selectSymbol(page);
  await previousMonth(page);

  const cell = page.getByTestId(`calendar-cell-${date}`);
  await cell.click();
  await cell.click();   // 같은 날 두 번 = 하루짜리 범위
  await page.getByRole('button', { name: /Start/i }).click();

  // COMPLETE 는 decide_capture 가 already_complete 로 즉시 스킵한다 —
  // 업스트림에 나가지 않으므로 CI 에서도 결정론적이다.
  await expect(page.locator('text=/skipped/i').first()).toBeVisible({ timeout: 10_000 });
});

test('calendar-markers: 보유 창 밖 source_partial 은 skipped(upstream_gap)', async ({ page }) => {
  // 이전 판의 제목은 "force_retry overrides source_partial skip" 이었는데, 그 전제가
  // 틀렸다 — `decide_capture` 는 source_partial 자체로는 스킵하지 않는다. 스킵은
  // ① 갭 확정(ADR-0093) ② 보유 창 밖 미확정 갭(ADR-0131) 일 때만 생긴다.
  //
  // force_retry 가 그 스킵을 우회하는 것은 사실이지만 **여기서 검증할 수 없다**:
  // 우회하면 실제 캡처가 돌아 업스트림이 필요한데 CI 에는 없다. 그 절반은 결정
  // 계층의 성질이라 단위 테스트가 이미 덮는다
  // (`test_decide_capture_confirmed_upstream_gap_bypassed_by_force_retry`).
  // 여기서는 UI 로 관측 가능한 결정론적 절반만 주장한다.
  await selectSymbol(page);
  const [date] = await tradingDates(page, 1, 4);   // 1·2번이 쓰는 0..3 을 피한다
  await seedSourcePartial(date);
  await selectSymbol(page);
  await previousMonth(page);

  const cell = page.getByTestId(`calendar-cell-${date}`);
  await cell.click();
  await cell.click();
  await page.getByRole('button', { name: /Start/i }).click();

  await expect(page.locator('text=/skipped/i').first()).toBeVisible({ timeout: 10_000 });
});
