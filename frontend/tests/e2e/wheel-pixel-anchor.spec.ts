import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route(url => url.pathname === '/', route => route.fulfill({
    contentType: 'text/html',
    body: '<html><body style="margin:0"><script>window.$RefreshSig$=()=>type=>type;window.$RefreshReg$=()=>{};window.__vite_plugin_react_preamble_installed=true;</script></body></html>',
  }));
  await page.goto('/');
});

for (const windowed of [false, true]) {
  for (const ctrl of [false, true]) {
    for (const span of [420, 10, 3, 1]) {
      test(`blank-area wheel keeps pixel anchor: windowed=${windowed} ctrl=${ctrl} span=${span}`, async ({ page }, info) => {
        const result = await page.evaluate(async ({ windowed, ctrl, span }) => {
          const path = '/tests/e2e/helpers/wheelViewportHarness.tsx';
          const { mount } = await import(path);
          const h = await mount(windowed, 4000);
          const ts = h.chart.timeScale();
          // Both cases begin above the zoom-in limit with visible right padding.
          const count = span + 1;
          ts.setVisibleLogicalRange({ from: 3999 - .7 * count + .5, to: 3999 + .3 * count - .5 });
          await h.frame();
          const range = ts.getVisibleLogicalRange()!;
          const width = ts.width();
          const mouseX = width - 20; // Always in the empty plot area, before the price axis.
          const anchor = ctrl
            ? range.to + .5 - (width - 1 - mouseX) * (range.to - range.from + 1) / width
            : 3999;
          // Interpolate public coordinates to measure a continuous logical
          // point; native logicalToCoordinate accepts integer indices only.
          const read = () => {
            const lo = Math.floor(anchor);
            const x0 = ts.logicalToCoordinate(lo)!;
            const x1 = ts.logicalToCoordinate(lo + 1)!;
            return { x: x0 + (x1 - x0) * (anchor - lo),
              range: ts.getVisibleLogicalRange(), width: ts.width(), axisWidth: h.chart.priceScale('right').width(),
              notifications: h.changes.length };
          };
          const samples = [read()];
          for (let i = 0; i < 12; i++) {
            // Large deltas reach the ceiling/floor; pairs exercise a wheel
            // burst before the native draw, followed by a direction reversal.
            const delta = i < 4 ? -2400 : i < 8 ? 2400 : i % 2 ? 120 : -120;
            h.wheel(delta, ctrl, 0, false, mouseX);
            h.wheel(delta, ctrl, 0, false, mouseX);
            await h.frame(); samples.push(read());
          }
          return { anchor, mouseX, samples };
        }, { windowed, ctrl, span });
        await info.attach('pixel-anchor', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
        const initial = result.samples[0];
        const drift = Math.max(...result.samples.map(s => Math.abs(s.x - initial.x)));
        expect(drift).toBeLessThan(.01);
        expect(result.samples.every(s => s.width === initial.width && s.axisWidth === initial.axisWidth)).toBe(true);
        // Repeating inputs at either native limit consumes the wheel without
        // scheduling viewport writes or notifying the backfill/saved-view owner.
        // Native input observes the last drawn range, so a two-event burst
        // reaches each limit more slowly than the windowed pending range.
        expect(result.samples[4].notifications).toBe(result.samples[3].notifications);
        expect(result.samples[8].notifications).toBe(result.samples[7].notifications);
      });
    }
  }

  test(`configured maximum spacing stops repeated zoom-in without pan: windowed=${windowed}`, async ({ page }) => {
    const result = await page.evaluate(async windowed => {
      const path = '/tests/e2e/helpers/wheelViewportHarness.tsx';
      const { mount } = await import(path);
      const h = await mount(windowed, 4000);
      h.chart.applyOptions({ timeScale: { maxBarSpacing: 100 } });
      const ts = h.chart.timeScale();
      ts.setVisibleLogicalRange({ from: 3990, to: 4002 }); await h.frame();
      const beforeX = ts.timeToCoordinate(h.rows.at(-1)!.time)!;
      h.wheel(-3000, false, 0, false, ts.width() - 20); await h.frame();
      const first = ts.getVisibleLogicalRange()!;
      const notifications = h.changes.length;
      for (let i = 0; i < 6; i++) {
        h.wheel(-120, false, 0, false, ts.width() - 20); await h.frame();
      }
      return { beforeX, afterX: ts.timeToCoordinate(h.rows.at(-1)!.time), first,
        after: ts.getVisibleLogicalRange(), notifications, afterNotifications: h.changes.length,
        spanLimit: ts.width() / 100 - 1 };
    }, windowed);
    expect(result.first.to - result.first.from).toBeCloseTo(result.spanLimit, 9);
    expect(Math.abs(result.afterX! - result.beforeX)).toBeLessThan(.01);
    expect(result.after).toEqual(result.first);
    expect(result.afterNotifications).toBe(result.notifications);
  });
}
