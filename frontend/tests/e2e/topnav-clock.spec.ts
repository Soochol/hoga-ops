import { test, expect, type Page } from '@playwright/test';

/**
 * 상단바 시계 — **jsdom 이 원리적으로 못 보는 두 계약**만 여기서 잰다.
 *
 * 1. **레이아웃(가운데 정렬)**. jsdom 에는 레이아웃 엔진이 없어 `getBoundingClientRect`
 *    가 전부 0 이다. 이 속성은 개발 중 두 번 어긋났고(중앙 열 중심이 871px 로 밀려
 *    있었고, 고친 뒤엔 `overflow-hidden` 때문에 메뉴 항목 `캡처` 가 통째로 잘렸다)
 *    둘 다 유닛 테스트에서는 초록이었다.
 * 2. **실제 브라우저에서 초가 흐르는가**. 유닛 테스트는 가짜 타이머라 "1초 뒤 갱신"
 *    이 정의상 참이다. 진짜 타이머·진짜 시계와의 일치는 여기서만 증명된다.
 *
 * 포맷·타임존·경계 정렬 같은 나머지는 유닛 테스트(src/nav/ClockLabel.test.tsx,
 * src/util/useWallClockSecond.test.ts)가 훨씬 촘촘하게 본다 — 여기서 중복하지 않는다.
 */

/** 시계 라벨의 기계 판독 값(`2026-08-21T22:29:23+09:00`)을 ms 로. */
async function clockMs(page: Page): Promise<number> {
  const iso = await page.getByRole('timer').getAttribute('datetime');
  expect(iso, '시계 라벨에 datetime 이 없다').toBeTruthy();
  return Date.parse(iso as string);
}

/** 시계 중심 − 상단바 중심(px). 양수면 오른쪽으로 밀린 것. */
async function centerOffset(page: Page): Promise<number> {
  return page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="주요 메뉴"]') as HTMLElement;
    const clock = document.querySelector('[role="timer"]') as HTMLElement;
    const n = nav.getBoundingClientRect();
    const c = clock.getBoundingClientRect();
    return c.left + c.width / 2 - (n.left + n.width / 2);
  });
}

test.describe('상단바 시계', () => {
  test('넓은 화면에서 상단바 정중앙에 앉는다', async ({ page }) => {
    // 기본 뷰포트(Desktop Chrome = 1280)는 좌측 메뉴가 공간을 다 써서 시계가 밀리는
    // 구간이다. 정렬 계약은 **여유가 있는 폭**에서만 성립하므로 명시적으로 넓힌다.
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto('/capture');
    await expect(page.getByRole('timer')).toBeVisible();
    expect(Math.abs(await centerOffset(page))).toBeLessThanOrEqual(1.5);
  });

  test('좁은 화면에서는 메뉴를 자르지 않고 시계가 밀린다', async ({ page }) => {
    // 우선순위 계약: 폭이 모자라면 **정렬을 양보하고 기능(메뉴)을 지킨다**.
    // `overflow-hidden` 이 다시 들어오면 여기서 잘린 항목이 잡힌다.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/capture');
    await expect(page.getByRole('timer')).toBeVisible();

    const clipped = await page.evaluate(() => {
      const col = document.querySelector('nav[aria-label="주요 메뉴"] > div > div') as HTMLElement;
      const right = col.getBoundingClientRect().right;
      return [...col.querySelectorAll('a')]
        .filter((a) => a.getBoundingClientRect().right > right + 0.5)
        .map((a) => a.textContent);
    });
    expect(clipped, '좁은 폭에서 메뉴 항목이 잘렸다').toEqual([]);
    expect(await centerOffset(page)).toBeGreaterThan(0); // 잘리는 대신 밀렸다
  });

  test('브라우저 시계와 일치하고 실제로 초가 흐른다', async ({ page }) => {
    await page.goto('/capture');
    await expect(page.getByRole('timer')).toBeVisible();

    // 라벨은 **항상 현재 이하**다(경계 +20ms 에 갱신하므로 최대 1초 남짓 뒤처진다).
    // 앞서면 타임존·포맷 조립이 틀린 것이다. 상한은 넉넉히 — 여기서 재는 것은
    // "몇 ms 정확한가" 가 아니라 "같은 시계를 보고 있는가" 다.
    const lag = Date.now() - (await clockMs(page));
    expect(lag, `라벨이 현재보다 미래다 (lag=${lag}ms)`).toBeGreaterThan(-1500);
    expect(lag, `라벨이 현재보다 한참 과거다 (lag=${lag}ms)`).toBeLessThan(5_000);

    // 진짜 타이머로 초가 흐르는가 — 가짜 타이머로는 증명할 수 없는 유일한 부분.
    const before = await clockMs(page);
    await page.waitForTimeout(2_100);
    const after = await clockMs(page);
    expect(after - before, '2.1초가 지났는데 시계가 안 움직였다').toBeGreaterThanOrEqual(1_000);
    expect(after - before, '시계가 실제 경과보다 빨리 흘렀다').toBeLessThanOrEqual(4_000);
  });
});
