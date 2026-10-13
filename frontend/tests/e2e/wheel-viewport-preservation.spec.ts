// Real-library regression coverage for wheel inputs between data writes and draws.
import { test, expect } from '@playwright/test';
for (const windowed of [false, true]) for (const count of [4000, 8000]) for (const mode of ['plain', 'ctrl', 'shift']) for (const burst of [1, 2]) {
  test(`wheel windowed=${windowed} count=${count} mode=${mode} burst=${burst}`, async ({ page }, info) => {
    await page.route(url => url.pathname === '/', r => r.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"><script>window.$RefreshSig$=()=>type=>type;window.$RefreshReg$=()=>{};window.__vite_plugin_react_preamble_installed=true;</script></body></html>' }));
    await page.goto('/');
    const result = await page.evaluate(async ({ windowed, count, mode, burst }) => {
      const path = '/tests/e2e/helpers/wheelViewportHarness.tsx'; const { mount } = await import(path);
      const h = await mount(windowed, count);
      h.chart.timeScale().setVisibleLogicalRange({ from: 1800, to: 1900 }); await h.frame();
      const ts = h.chart.timeScale();
      const anchorTime = h.rows[Math.round(ts.coordinateToLogical(450)!)].time;
      const snapshot = () => ({ ...h.snap(), anchorX: ts.timeToCoordinate(anchorTime) });
      const samples = [{ tag: 'before', ...snapshot() }];
      for (let i = 0; i < 16; i++) {
        for (let n = 0; n < burst; n++) {
          h.wheel(120, mode === 'ctrl', 0, mode === 'shift');
        }
        await h.frame(); samples.push({ tag: `wheel-${i}-drawn`, ...snapshot() });
      }
      return samples;
    }, { windowed, count, mode, burst });
    await info.attach('samples', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    const drawn = result.filter(s => s.tag === 'before' || s.tag.endsWith('-drawn'));
    const initialAnchor = drawn[0].mouseIndex!;
    const drift = mode === 'ctrl' ? Math.max(...drawn.map(s => Math.abs(s.mouseIndex! - initialAnchor)))
      : mode === 'plain' ? Math.max(...drawn.map(s => Math.abs(s.range!.to - 1900))) : null;
    if (mode === 'shift') expect(drawn.at(-1)!.range!.to).toBeCloseTo(1900 + 160 * (windowed ? burst : 1), 5);
    if (mode === 'plain') expect(drift).toBeLessThan(.01);
    if (mode === 'ctrl') {
      const pixelDrift = Math.max(...drawn.map(s => Math.abs(s.anchorX! - drawn[0].anchorX!)));
      // Cursor bins are integer bars; repeated zooms can move the chosen
      // bar within its pixel bin. A date jump moves it by hundreds of pixels.
      expect(pixelDrift).toBeLessThan(2);
    }
  });
}

for (const mode of ['plain', 'ctrl']) {
  test(`3m: wheel between prepended Virtual Axis generations preserves ${mode} anchor`, async ({ page }, info) => {
    await page.route(url => url.pathname === '/', r => r.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"><script>window.$RefreshSig$=()=>type=>type;window.$RefreshReg$=()=>{};window.__vite_plugin_react_preamble_installed=true;</script></body></html>' }));
    await page.goto('/');
    const result = await page.evaluate(async mode => {
      const harnessPath = '/tests/e2e/helpers/wheelViewportHarness.tsx';
      const { mount } = await import(harnessPath);
      const axisPath = '/src/util/virtualAxis.ts';
      const { createVirtualAxis } = await import(axisPath);
      const adapterPath = '/src/chart/windowedChart.ts';
      const { flushWindowedChart, setWindowedChartTimeMapping } = await import(adapterPath);
      const h = await mount(true, 8000, 180);
      const day = 86400000;
      const sessions = Array.from({ length: 90 }, (_, i) => Date.UTC(2026, 6, 1) + i * day)
        .filter(ms => ![0, 6].includes(new Date(ms).getUTCDay()))
        .map(ms => ({ date: new Date(ms).toISOString().slice(0, 10).replaceAll('-', ''),
          sessionOpenMs: ms, sessionCloseMs: ms + 390 * 60000 }));
      const oldSessions = sessions.slice(7);
      const oldAxis = createVirtualAxis(oldSessions, oldSessions[0].sessionOpenMs);
      const nextAxis = createVirtualAxis(sessions, sessions[0].sessionOpenMs);
      const project = (axis: typeof oldAxis, source: typeof sessions) => source.flatMap(s =>
        Array.from({ length: 130 }, (_, i) => ({ time: axis.toVirtual(s.sessionOpenMs + i * 180000) / 1000,
          open: 100, high: 101, low: 99, close: 100 })));
      setWindowedChartTimeMapping(h.chart, {
        toReal: (t: number) => oldAxis.toReal(t * 1000),
        fromReal: (ms: number) => oldAxis.toVirtual(ms) / 1000,
      });
      h.series.setData(project(oldAxis, oldSessions)); flushWindowedChart(h.chart);
      h.chart.timeScale().setVisibleLogicalRange({ from: 1800, to: 2100 }); await h.frame();
      const ts = h.chart.timeScale();
      const index = mode === 'ctrl' ? Math.round(ts.coordinateToLogical(450)!) : 2100;
      const realMs = oldAxis.toReal(Number(h.series.dataByIndex(index)!.time) * 1000);
      const beforeX = ts.timeToCoordinate(oldAxis.toVirtual(realMs) / 1000)!;
      h.wheel(120, mode === 'ctrl');
      setWindowedChartTimeMapping(h.chart, {
        toReal: (t: number) => nextAxis.toReal(t * 1000),
        fromReal: (ms: number) => nextAxis.toVirtual(ms) / 1000,
      });
      h.series.setData(project(nextAxis, sessions)); flushWindowedChart(h.chart);
      h.wheel(120, mode === 'ctrl'); // no intervening draw or caller repair
      await h.frame();
      const afterX = ts.timeToCoordinate(nextAxis.toVirtual(realMs) / 1000)!;
      const rightTime = h.series.dataByIndex(Math.floor(ts.getVisibleLogicalRange()!.to), -1)!.time;
      return { beforeX, afterX, realMs, rightMs: nextAxis.toReal(Number(rightTime) * 1000),
        virtualChanged: oldAxis.toVirtual(realMs) !== nextAxis.toVirtual(realMs) };
    }, mode);
    await info.attach('axis-prepend', { body: JSON.stringify(result), contentType: 'application/json' });
    expect(result.virtualChanged).toBe(true);
    if (mode === 'plain') expect(result.rightMs).toBe(result.realMs);
    else expect(Math.abs(result.afterX - result.beforeX)).toBeLessThan(1);
  });
}

for (const windowed of [true]) for (const mode of ['plain', 'ctrl']) for (const followup of ['immediate', 'after-frame', 'none']) {
  test(`3m prepend windowed=${windowed} mode=${mode} followup=${followup}`, async ({ page }, info) => {
    await page.route(url => url.pathname === '/', r => r.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"><script>window.$RefreshSig$=()=>type=>type;window.$RefreshReg$=()=>{};window.__vite_plugin_react_preamble_installed=true;</script></body></html>' }));
    await page.goto('/');
    const result = await page.evaluate(async ({ windowed, mode, followup }) => {
      const path = '/tests/e2e/helpers/wheelViewportHarness.tsx'; const { mount } = await import(path);
      const adapterPath = '/src/chart/windowedChart.ts'; const { flushWindowedChart } = await import(adapterPath);
      const h = await mount(windowed, 8000, 180);
      h.chart.timeScale().setVisibleLogicalRange({ from: 1800, to: 2100 }); await h.frame();
      const ts = h.chart.timeScale();
      const cursorIndex = Math.round(ts.coordinateToLogical(450)!);
      const anchorTime = h.rows[cursorIndex].time;
      const before = h.snap(); const beforeX = ts.timeToCoordinate(anchorTime)!;
      h.wheel(120, mode === 'ctrl');
      // A resolved history response commits between wheel events, without a
      // chart draw in between. No viewport API repairs are supplied by the test.
      await Promise.resolve();
      const older = Array.from({ length: 1000 }, (_, i) => ({ ...h.rows[0], time: Number(h.rows[0].time) - (1000 - i) * 180 }));
      h.series.setData([...older, ...h.rows]); flushWindowedChart(h.chart);
      if (followup === 'after-frame') await h.frame();
      if (followup !== 'none') h.wheel(120, mode === 'ctrl');
      await h.frame();
      const after = h.snap();
      const drift = mode === 'plain' ? after.range!.to - before.range!.to - 1000
        : ts.timeToCoordinate(anchorTime)! - beforeX;
      return { before, after, beforeX, afterX: ts.timeToCoordinate(anchorTime), drift,
        rightTimeBefore: h.rows[Math.floor(before.range!.to)].time,
        rightTimeAfter: h.series.dataByIndex(Math.floor(after.range!.to), -1)?.time };
    }, { windowed, mode, followup });
    await info.attach('samples', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    if (windowed) expect(Math.abs(result.drift)).toBeLessThan(mode === 'plain' ? .01 : 2);
  });
}
