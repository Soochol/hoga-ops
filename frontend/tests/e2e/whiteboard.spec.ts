import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { WhiteboardDocument } from '../../src/api/whiteboards';
import { API_URL, BASE_URL } from './worktreeEnv';

const uid = () => randomUUID().replaceAll('-', '');
const headers = { Origin: BASE_URL };
async function create(request: APIRequestContext, name = '복기 노트') {
  const response = await request.post(`${API_URL}/api/whiteboards`, {
    headers,
    data: { id: uid(), mutation_id: uid(), name },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<WhiteboardDocument>;
}
async function read(request: APIRequestContext, id: string) {
  return (await request.get(`${API_URL}/api/whiteboards/${id}`)).json() as Promise<WhiteboardDocument>;
}
async function open(page: Page, id: string) {
  await page.goto(`/whiteboard?board=${id}`);
  await expect(page.getByTestId('whiteboard-editor')).toBeVisible();
  await expect(page.getByRole('radio', { name: '선택', exact: true })).toBeVisible();
}
async function sampleImage(page: Page) {
  const url = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 900;
    c.height = 400;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#182014';
    ctx.fillRect(0, 0, 900, 400);
    ctx.fillStyle = '#c7fa79';
    ctx.font = '32px sans-serif';
    ctx.fillText('차트 이미지 · 005930 · 예시', 30, 60);
    for (let i = 0; i < 35; i++) {
      ctx.fillStyle = i % 3 ? '#f47f89' : '#82b1fa';
      ctx.fillRect(30 + i * 24, 300 - i * 4, 10, 25);
    }
    return c.toDataURL();
  });
  return Buffer.from(url.split(',')[1], 'base64');
}

test('보드 목록, 한글 메모 편집, 실제 드래그, 실행 취소와 재열기', async ({ page, request }, info) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  const doc = await create(request);
  await open(page, doc.id);
  await page.getByRole('textbox', { name: '보드 이름' }).fill('오전 복기');
  await page.getByRole('button', { name: '메모 추가', exact: true }).click();
  await expect.poll(async () => (await read(request, doc.id)).scene.elements.length).toBe(2);
  const canvas = page.locator('canvas.interactive');
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.dblclick(bounds.x + bounds.width / 2 - 65, bounds.y + bounds.height / 2 - 50);
  await expect(page.locator('textarea')).toBeVisible();
  await page.locator('textarea').fill('');
  const ime = await page.context().newCDPSession(page);
  await ime.send('Input.imeSetComposition', { text: '돌파 후 첫 눌림', selectionStart: 8, selectionEnd: 8 });
  await ime.send('Input.insertText', { text: '돌파 후 첫 눌림\n거래량 확인' });
  await expect(page.locator('textarea')).toHaveValue('돌파 후 첫 눌림\n거래량 확인');
  await page.locator('textarea').press('Escape');
  await expect
    .poll(async () => (await read(request, doc.id)).scene.elements.find((el) => el.type === 'text')?.text)
    .toBe('돌파 후 첫 눌림\n거래량 확인');
  const before = (await read(request, doc.id)).scene.elements.find((el) => el.type === 'rectangle')!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + 55);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 90, bounds.y + bounds.height / 2 + 80, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(async () =>
      Number((await read(request, doc.id)).scene.elements.find((el) => el.type === 'rectangle')!.x),
    )
    .not.toBe(Number(before.x));
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect
    .poll(async () =>
      Number((await read(request, doc.id)).scene.elements.find((el) => el.type === 'rectangle')!.x),
    )
    .toBe(Number(before.x));
  await page.reload();
  await expect(page.getByRole('textbox', { name: '보드 이름' })).toHaveValue('오전 복기');
  await expect(page.getByText('저장됨', { exact: true })).toBeVisible();
  const currentBox = (await page.locator('canvas.interactive').boundingBox())!;
  async function move(fromX: number, fromY: number, toX: number, toY: number) {
    await page.mouse.move(currentBox.x + fromX, currentBox.y + fromY);
    await page.mouse.down(); await page.mouse.move(currentBox.x + toX, currentBox.y + toY, { steps: 10 }); await page.mouse.up();
  }
  await move(currentBox.width / 2, currentBox.height / 2 + 55, currentBox.width * .75, currentBox.height * .32 + 55);
  for (let index = 0; index < 2; index++) {
    await page.getByLabel('이미지 파일 선택', { exact: true }).setInputFiles({ name: `chart-${index}.png`, mimeType: 'image/png', buffer: await sampleImage(page) });
    await expect.poll(async () => (await read(request, doc.id)).scene.elements.filter(el => el.type === 'image').length).toBe(index + 1);
    await move(currentBox.width / 2, currentBox.height / 2, currentBox.width * (index ? .70 : .29), currentBox.height * (index ? .73 : .31));
  }
  await page.mouse.click(bounds.x + bounds.width - 100, bounds.y + 150);
  await page.screenshot({ path: info.outputPath('whiteboard-board-list.png') });
});

test('이미지 포함 자동 저장, PNG 내보내기와 편집 파일 왕복', async ({ page, request, browser }, info) => {
  const doc = await create(request, '이미지 비교');
  await open(page, doc.id);
  const png = await sampleImage(page);
  await page
    .getByLabel('이미지 파일 선택', { exact: true })
    .setInputFiles({ name: 'chart.png', mimeType: 'image/png', buffer: png });
  await expect.poll(async () => Object.keys((await read(request, doc.id)).scene.files).length).toBe(1);
  await page.reload();
  await expect(page.getByText('저장됨', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  let pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PNG로 저장', exact: true }).click();
  const download = await pending;
  const image = info.outputPath('board.png');
  await download.saveAs(image);
  const bytes = await readFile(image);
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(bytes.length).toBeGreaterThan(1000);
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '편집 파일로 저장 (이미지 포함)' }).click();
  const editable = await pending;
  const path = info.outputPath('backup.whiteboard.json');
  await editable.saveAs(path);
  const payload = JSON.parse(await readFile(path, 'utf8'));
  expect(Object.values(payload.files)).toHaveLength(1);
  expect((Object.values(payload.files)[0] as { dataURL: string }).dataURL).toMatch(
    /^data:image\/png;base64,/,
  );
  const clean = await browser.newContext({ baseURL: BASE_URL });
  const fresh = await clean.newPage();
  await fresh.goto('/whiteboard?legacy=1');
  await fresh.getByLabel('보드 파일 선택', { exact: true }).setInputFiles(path);
  await expect(fresh.getByText('보드를 새로 가져왔습니다', { exact: true })).toBeVisible();
  await expect(fresh.getByTestId('whiteboard-editor')).toBeVisible();
  await expect(fresh).toHaveURL(/board=/);
  const newId = new URL(fresh.url()).searchParams.get('board')!;
  expect(newId).not.toBe(doc.id);
  await expect.poll(async () => Object.keys((await read(request, newId)).scene.files).length).toBe(1);
  await clean.close();
});

test('두 창 동시 편집 충돌은 초안을 보존하고 새 보드로 복구한다', async ({ page, context, request }) => {
  const doc = await create(request, '충돌 검증');
  await open(page, doc.id);
  const second = await context.newPage();
  await open(second, doc.id);
  await page.getByRole('textbox', { name: '보드 이름' }).fill('첫 창 저장');
  await expect.poll(async () => (await read(request, doc.id)).name).toBe('첫 창 저장');
  await second.getByRole('textbox', { name: '보드 이름' }).fill('두 번째 창 초안');
  await expect(second.getByText('다른 창의 변경과 충돌', { exact: true })).toBeVisible();
  await expect(second.getByRole('textbox', { name: '보드 이름' })).toHaveValue('두 번째 창 초안');
  await second.getByRole('button', { name: '내 편집을 새 보드로 저장' }).click();
  await expect(second).not.toHaveURL(new RegExp(doc.id));
  await expect(second.getByRole('textbox', { name: '보드 이름' })).toHaveValue('두 번째 창 초안 복사');
  expect((await read(request, doc.id)).name).toBe('첫 창 저장');
  await second.close();
});

test('서버 저장 실패 후 새로고침해도 로컬 초안을 복구한다', async ({ page, request }) => {
  const doc = await create(request, '복구 검증');
  await open(page, doc.id);
  await page.route(`**/api/whiteboards/${doc.id}`, async (route) => {
    if (route.request().method() === 'PUT')
      return route.fulfill({
        status: 503,
        json: { detail: { code: 'whiteboard_storage_failed', message: '저장소 테스트 장애' } },
      });
    return route.continue();
  });
  await page.getByRole('textbox', { name: '보드 이름' }).fill('서버 장애 중 메모');
  await page.getByRole('button', { name: '메모 추가', exact: true }).click();
  await expect(page.getByText('저장 실패', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('textbox', { name: '보드 이름' })).toHaveValue('서버 장애 중 메모');
  await expect(page.getByText('저장 실패', { exact: true })).toBeVisible();
  await page.unroute(`**/api/whiteboards/${doc.id}`);
  await page.getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect.poll(async () => (await read(request, doc.id)).name).toBe('서버 장애 중 메모');
  await expect.poll(async () => (await read(request, doc.id)).scene.elements.length).toBe(2);
});

test('복제 보드는 독립적이며 삭제한 보드를 휴지통에서 복원한다', async ({ page, request }) => {
  const doc = await create(request, '원본 독립성');
  await open(page, doc.id);
  await page.getByRole('button', { name: '메모 추가', exact: true }).click();
  await expect.poll(async () => (await read(request, doc.id)).scene.elements.length).toBe(2);
  await page.getByRole('button', { name: '보드 복제', exact: true }).click();
  await expect(page).not.toHaveURL(new RegExp(doc.id));
  const cloneId = new URL(page.url()).searchParams.get('board')!;
  await expect(page.getByRole('textbox', { name: '보드 이름' })).toHaveValue('원본 독립성 복사');
  await page.getByRole('textbox', { name: '보드 이름' }).fill('복사본 변경');
  await expect.poll(async () => (await read(request, cloneId)).name).toBe('복사본 변경');
  expect((await read(request, doc.id)).name).toBe('원본 독립성');
  await page.getByRole('button', { name: '보드 삭제', exact: true }).click();
  await expect.poll(async () => (await read(request, cloneId)).deleted_at_ms).not.toBeNull();
  await page.getByRole('button', { name: '휴지통', exact: true }).click();
  await page.getByTestId(`whiteboard-row-${cloneId}`).click();
  await page.getByRole('button', { name: '보드 복원', exact: true }).first().click();
  await expect.poll(async () => (await read(request, cloneId)).deleted_at_ms).toBeNull();
});

test('격리된 부하 보드에서 목록, 이미지, 객체와 반복 전환 성능을 확인한다', async ({
  page,
  request,
}, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 950 });
  const base = await create(request, '성능 기준 보드');
  await open(page, base.id);
  await page.getByRole('button', { name: '메모 추가', exact: true }).click();
  await page
    .getByLabel('이미지 파일 선택', { exact: true })
    .setInputFiles({ name: 'chart.png', mimeType: 'image/png', buffer: await sampleImage(page) });
  await expect.poll(async () => Object.keys((await read(request, base.id)).scene.files).length).toBe(1);
  const seed = await read(request, base.id);
  const rectangle = seed.scene.elements.find((el) => el.type === 'rectangle')!;
  const image = seed.scene.elements.find((el) => el.type === 'image')!;
  const elements: Record<string, unknown>[] = Array.from({ length: 280 }, (_, index) => ({
    ...rectangle,
    id: uid(),
    boundElements: null,
    index: null,
    x: (index % 20) * 90,
    y: Math.floor(index / 20) * 60,
    width: 72,
    height: 42,
  }));
  const files: WhiteboardDocument['scene']['files'] = {};
  for (let index = 0; index < 20; index++) {
    const encoded = await page.evaluate((index) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1600;
      canvas.height = 1000;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#182014';
      ctx.fillRect(0, 0, 1600, 1000);
      ctx.fillStyle = '#c7fa79';
      ctx.font = '40px sans-serif';
      ctx.fillText(`차트 부하 ${index}`, 30, 70);
      for (let i = 0; i < 60; i++) {
        ctx.fillStyle = i % 3 ? '#f47f89' : '#82b1fa';
        ctx.fillRect(30 + i * 24, 800 - i * 9 + index, 10, 50);
      }
      return canvas.toDataURL().split(',')[1];
    }, index);
    const upload = await request.post(`${API_URL}/api/whiteboards/assets`, {
      headers,
      data: Buffer.from(encoded, 'base64'),
    });
    expect(upload.ok()).toBe(true);
    const asset = await upload.json();
    const fileId = uid();
    files[fileId] = { ...asset, created: Date.now() };
    elements.push({
      ...image,
      id: uid(),
      fileId,
      index: null,
      x: (index % 5) * 220,
      y: Math.floor(index / 5) * 140,
      width: 200,
      height: 100,
    });
  }
  const response = await request.put(`${API_URL}/api/whiteboards/${base.id}`, {
    headers,
    data: {
      mutation_id: uid(),
      expected_revision: seed.revision,
      name: '성능 기준 보드',
      scene: { ...seed.scene, elements, files },
    },
  });
  expect(response.ok()).toBe(true);
  // The data set belongs exclusively to this E2E backend.
  const lightweight = await create(request, '가벼운 전환 보드');
  for (let index = 0; index < 98; index++) await create(request, `목록 부하 ${index}`);
  await page.reload();
  await expect(page.getByRole('radio', { name: '선택', exact: true })).toBeVisible();
  const box = (await page.locator('canvas.interactive').boundingBox())!;
  const samples = page.evaluate(
    () =>
      new Promise<{ frames: number[]; latency: number[] }>((resolve) => {
        const frames: number[] = [],
          latency: number[] = [];
        let last = performance.now(),
          count = 0;
        const canvas = document.querySelector('canvas.interactive')!;
        const onMove = () => {
          const start = performance.now();
          requestAnimationFrame(() => latency.push(performance.now() - start));
        };
        canvas.addEventListener('pointermove', onMove, true);
        function frame(now: number) {
          frames.push(now - last);
          last = now;
          if (++count < 150) requestAnimationFrame(frame);
          else {
            canvas.removeEventListener('pointermove', onMove, true);
            resolve({ frames: frames.slice(10), latency });
          }
        }
        requestAnimationFrame(frame);
      }),
  );
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5);
  await page.keyboard.down('Space');
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7, { steps: 50 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  const measured = await samples;
  const percentile = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)] ?? 0;
  const metrics = {
    objects: 300,
    imageInstances: 20,
    uniqueImageFiles: 20,
    imagePixels: 1600 * 1000,
    minimumBoards: 100,
    frameP95Ms: percentile(measured.frames),
    pointerToFrameP95Ms: percentile(measured.latency),
  };
  await info.attach('whiteboard-performance.json', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  });
  console.log('WHITEBOARD_PERFORMANCE', JSON.stringify(metrics));
  expect(metrics.frameP95Ms).toBeLessThan(34);
  expect(metrics.pointerToFrameP95Ms).toBeLessThan(100);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  const before = await cdp.send('Runtime.getHeapUsage');
  for (let index = 0; index < 5; index++) {
    await page.getByTestId(`whiteboard-row-${lightweight.id}`).click();
    await expect(page.getByTestId('whiteboard-editor')).toHaveAttribute('data-board-id', lightweight.id);
    await page.getByTestId(`whiteboard-row-${base.id}`).click();
    await expect(page.getByTestId('whiteboard-editor')).toHaveAttribute('data-board-id', base.id);
  }
  await cdp.send('HeapProfiler.collectGarbage');
  const after = await cdp.send('Runtime.getHeapUsage');
  console.log('WHITEBOARD_HEAP', JSON.stringify({ before: before.usedSize, after: after.usedSize }));
  expect(after.usedSize).toBeLessThan(before.usedSize * 1.5 + 20_000_000);
  await page.screenshot({ path: info.outputPath('whiteboard-load.png') });
});

test('그룹·복제·잠금과 좁은 화면의 앱 메뉴가 정상 동작한다', async ({ page, request }, info) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  const doc = await create(request, '선택과 그룹');
  await open(page, doc.id);
  await page.getByRole('button', { name: '메모 추가', exact: true }).click();
  await page.getByRole('button', { name: '메모 추가', exact: true }).click();
  await expect.poll(async () => (await read(request, doc.id)).scene.elements.length).toBe(4);
  const box = (await page.locator('canvas.interactive').boundingBox())!;
  await page.mouse.click(box.x + box.width - 100, box.y + 140);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+g');
  await expect
    .poll(async () =>
      (await read(request, doc.id)).scene.elements.every((el) => (el.groupIds as string[]).length > 0),
    )
    .toBe(true);
  await page.keyboard.press('Control+d');
  await expect
    .poll(async () => (await read(request, doc.id)).scene.elements.filter((el) => !el.isDeleted).length)
    .toBe(8);
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => (await read(request, doc.id)).scene.elements.filter((el) => !el.isDeleted).length)
    .toBe(4);
  await page.keyboard.press('Control+Shift+l');
  await expect
    .poll(async () =>
      (await read(request, doc.id)).scene.elements.filter((el) => !el.isDeleted).map((el) => el.locked),
    )
    .toEqual([true, true, true, true]);
  const current = await read(request, doc.id);
  await page.keyboard.press('Delete');
  await expect(page.getByText('저장됨', { exact: true })).toBeVisible();
  expect((await read(request, doc.id)).scene.elements.filter((el) => !el.isDeleted).length).toBe(
    current.scene.elements.filter((el) => !el.isDeleted).length,
  );
  for (const width of [1024, 944, 768]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.getByRole('button', { name: '보드 목록 열기/접기' })).toBeVisible();
    await expect(page.getByTestId('whiteboard-editor')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`whiteboard-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.evaluate(async () => { const path = '/src/state/themePrefs.ts'; const { useThemePrefsStore } = await import(path); useThemePrefsStore.getState().setThemePreference('ledger'); });
  await expect(page.locator('.wb-editor .excalidraw')).not.toHaveClass(/theme--dark/);
  await page.screenshot({ path: info.outputPath('whiteboard-light.png') });
});

test('125%·150%와 같은 유효 뷰포트와 DPR에서 포인터 좌표를 유지한다', async ({ page, request }, info) => {
  const doc = await create(request, '배율 검증');
  const cdp = await page.context().newCDPSession(page);
  for (const [index, scale] of [1.25, 1.5].entries()) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: Math.round(1440 / scale), height: Math.round(950 / scale), deviceScaleFactor: scale, mobile: false });
    await open(page, doc.id);
    const canvas = page.locator('canvas.interactive');
    const dimensions = await canvas.evaluate(el => ({ bitmap: (el as HTMLCanvasElement).width, css: el.clientWidth, dpr: devicePixelRatio }));
    expect(dimensions.dpr).toBe(scale);
    expect(Math.abs(dimensions.bitmap - dimensions.css * scale)).toBeLessThanOrEqual(2);
    await canvas.click({ position: { x: 50, y: 150 } });
    await page.keyboard.press('r');
    const bounds = (await canvas.boundingBox())!;
    await page.mouse.move(bounds.x + 350, bounds.y + 220); await page.mouse.down();
    await page.mouse.move(bounds.x + 470, bounds.y + 300, { steps: 8 }); await page.mouse.up();
    await expect.poll(async () => (await read(request, doc.id)).scene.elements.filter(el => el.type === 'rectangle').length).toBe(index + 1);
    const rectangle = (await read(request, doc.id)).scene.elements.filter(el => el.type === 'rectangle').at(-1)!;
    expect(Number(rectangle.width)).toBeGreaterThan(115); expect(Number(rectangle.width)).toBeLessThan(125);
    await page.screenshot({ path: info.outputPath(`whiteboard-dpr-${scale}.png`) });
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
});
