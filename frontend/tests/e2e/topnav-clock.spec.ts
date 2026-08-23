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
    // 정렬 계약은 **여유가 있는 폭**에서만 성립하므로 명시적으로 넓힌다.
    // (2026-08-23 `/study` nav 제거로 메뉴가 한 항목 짧아지면서 여유 구간이 넓어졌다 —
    // 실측 오프셋 0px 이 1280 까지 내려왔다. 그래도 1600 을 유지한다: 이 케이스가 재는
    // 것은 "여유가 있으면 정중앙" 이고, 경계 바로 위를 고르면 nav 가 한 항목 늘 때마다
    // 이 테스트가 먼저 깨진다.)
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto('/capture');
    await expect(page.getByRole('timer')).toBeVisible();
    expect(Math.abs(await centerOffset(page))).toBeLessThanOrEqual(1.5);
  });

  test('좁은 화면에서는 메뉴를 자르지 않고 시계가 밀린다', async ({ page }) => {
    // 우선순위 계약: 폭이 모자라면 **정렬을 양보하고 기능(메뉴)을 지킨다**.
    // `overflow-hidden` 이 다시 들어오면 여기서 잘린 항목이 잡힌다.
    //
    // 폭이 1280 → **1100** 으로 내려왔다(2026-08-23). `/study` nav 항목이 사라져 메뉴가
    // 짧아지면서 1280 에서는 더 이상 **경합이 없다** — 실측 오프셋 1280:0.0 · 1180:42.1 ·
    // 1100:82.1 px. 1280 을 그대로 뒀다면 아래 "밀렸다" 단언이 조용히 0 을 검사하는
    // 무력한 가드가 된다. 1180(경계 바로 아래)이 아니라 1100 을 고른 것은 여유폭을 두기
    // 위해서다. 셸 바닥(944)보다는 위라 이 케이스와 아래 바닥 케이스가 겹치지 않는다.
    await page.setViewportSize({ width: 1100, height: 800 });
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

  test('셸 바닥 폭에서도 우측 클러스터가 시계를 덮지 않는다', async ({ page }) => {
    // 바닥 폭(`--app-floor-min-w`)은 셸이 압축을 멈추는 지점이라 **상단바가 가장 좁게
    // 눌리는 실사용 폭**이다. 시계(138px `shrink-0`)가 들어오면서 상단바 자연폭이 늘어
    // 옛 바닥 912px 에서는 캡처 진행 중 우측 클러스터가 상단바 밖으로 밀려 나갔다
    // (그리고 `min-w-0` 이 있으면 시계까지 덮었다) → 바닥을 59rem 으로 올린 근거.
    //
    // **이 가드가 고정하는 것은 바닥 값이다**(red-check: 57rem 으로 되돌리면 실패).
    // 우측 클러스터의 `min-w-0` 제거는 944px 여유 안에서는 증상을 내지 않아 여기서
    // 잡히지 않는다 — 그건 가드가 아니라 선택이라고 TopNav 주석에 적어 두었다.
    //
    // 캡처 상태 라벨은 큐가 놀고 있으면 렌더되지 않으므로(CaptureInlineStatus 는 idle 에
    // null) **가장 넓은 상태를 DOM 으로 주입해** 폭 여유를 잰다. 여기서 재는 것은 동작이
    // 아니라 **레이아웃 용량**이라 주입이 정당하다 — 실제 큐를 돌려도 폭은 같고 준비만
    // 무거워진다.
    // 바닥 폭은 **앱에서 읽는다** — 숫자를 박으면 토큰이 움직일 때 이 테스트만 옛 폭을
    // 검사한다(빈 페이지에서는 CSS 변수가 없어 NaN 이므로 반드시 goto 뒤에 읽을 것).
    await page.goto('/capture');
    await expect(page.getByRole('timer')).toBeVisible();
    const floorPx = await page.evaluate(
      () =>
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--app-floor-min-w'),
        ) * parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
    expect(Number.isFinite(floorPx), '--app-floor-min-w 를 못 읽었다').toBe(true);
    await page.setViewportSize({ width: Math.round(floorPx), height: 800 });

    const geom = await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="주요 메뉴"]') as HTMLElement;
      const grid = nav.firstElementChild as HTMLElement;
      const right = grid.children[2] as HTMLElement;
      const clock = grid.children[1] as HTMLElement;
      const probe = document.createElement('a');
      probe.className =
        'inline-flex h-full items-center gap-xs whitespace-nowrap text-xs font-semibold';
      probe.textContent = '수집 3 · 대기 12'; // CaptureInlineStatus 의 최대 폭 형태
      right.insertBefore(probe, right.firstChild);
      const n = nav.getBoundingClientRect();
      const r = right.getBoundingClientRect();
      const c = clock.getBoundingClientRect();
      const pr = probe.getBoundingClientRect();
      const out = {
        overlapsClock: pr.left < c.right - 0.5,
        spillPx: Math.round(Math.max(0, r.right - n.right)),
      };
      probe.remove();
      return out;
    });
    expect(geom.overlapsClock, '우측 클러스터가 시계를 덮었다').toBe(false);
    expect(geom.spillPx, '우측 클러스터가 상단바 밖으로 넘쳤다').toBe(0);
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
