/**
 * 캡처 큐 초기화 — 큐가 **백엔드 전역**이라 스펙끼리 물려 있다.
 *
 * `queue-row-` 개수나 "N of N done" 요약은 전부 전역이라, 앞선 스펙이 남긴 행이 그대로
 * 계산에 들어간다(실측: 3 을 기대한 자리에서 14 → 20). 워커를 1로 고정해 동시 실행은
 * 막았지만 **순차 오염**은 여전히 남으므로, 큐를 세는 스펙은 빈 상태에서 시작해야 한다.
 */
import { expect, type Page } from '@playwright/test';

export async function resetQueue(page: Page): Promise<void> {
  // **개수를 먼저 보고 일찍 반환하면 안 된다.** 페이지 로드 직후엔 큐가 아직 안 그려져
  // 0 이 나오고, 그 뒤에 남은 행들이 도착한다(실측: 비웠다고 판단한 뒤 3행이 살아나
  // 3 을 기대한 자리에서 6 이 됐다).
  //
  // 기다릴 대상은 **둘 중 하나**다 — 큐가 비면 `CaptureQueue` 가 목록 대신 빈 상태를
  // 그리므로 `queue-list` 만 기다리면 빈 큐에서 영원히 못 찾는다(실측: 첫 실행에서
  // `toBeAttached` 실패).
  await expect(
    page.getByTestId('queue-list').or(page.getByTestId('queue-empty')).first(),
  ).toBeAttached({ timeout: 10_000 });
  // 행 컨테이너만 — testid 접두사로 잡으면 행 내부 배지까지 세어진다.
  const rows = page.getByRole('button', { name: /^Capture row / });

  // Cancel All 은 2단계(파괴적 동작 가드) — 첫 클릭은 확인 버튼으로 바뀐다.
  const cancelAll = page.getByRole('button', { name: /Cancel All/i });
  if (await cancelAll.isVisible().catch(() => false)) {
    await cancelAll.click();
    await page.getByRole('button', { name: /Click again to confirm/i }).click();
  }
  const dismiss = page.getByRole('button', { name: /Dismiss Done/i });
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();

  await expect(rows).toHaveCount(0, { timeout: 10_000 });
}
