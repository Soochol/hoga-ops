import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { WhiteboardDocument } from '../../src/api/whiteboards';
import { emptyReview } from '../../src/whiteboard/review';
import { API_URL, BASE_URL } from './worktreeEnv';

const uid = () => randomUUID().replaceAll('-', '');
const headers = { Origin: BASE_URL };
async function read(request: APIRequestContext, id: string): Promise<WhiteboardDocument> {
  const response = await request.get(`${API_URL}/api/whiteboards/${id}`);
  expect(response.ok()).toBe(true); return response.json();
}
async function seed(request: APIRequestContext, date: string, archive = false) {
  const id = uid(), review = { ...emptyReview(date), ...(archive ? { summary: '당시의 하루 결론', good: '지킨 기준', change: '서두르지 않기', principle: '무효화 조건을 먼저 적는다',
    records: [{ id: uid(), title: '첫 눌림 관찰', stock: '삼성전자', code: '005930', timeframe: '5m', captured_at_ms: null, image_file_id: null, judgment: '거래량 확인', action: '관망', result: '계획대로' }] } : {}) };
  const response = await request.post(`${API_URL}/api/whiteboards`, { headers, data: { id, mutation_id: uid(), name: `${date} 매일 복기`, review } });
  expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<WhiteboardDocument>;
}
const visible = (doc: WhiteboardDocument, type: string) => doc.scene.elements.filter(el => el.type === type && !el.isDeleted);
async function open(page: Page, id: string) {
  await page.goto(`/whiteboard?board=${id}`);
  await expect(page.getByTestId('whiteboard-editor')).toHaveAttribute('data-board-id', id);
  await expect(page.getByRole('button', { name: '연필', exact: true })).toBeEnabled();
}
async function draw(page: Page, y = 300) {
  await page.getByRole('button', { name: '연필', exact: true }).click();
  const box = (await page.locator('canvas.interactive').boundingBox())!;
  await page.mouse.move(box.x + box.width * .58, box.y + y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(box.x + box.width * .58 + i * 5, box.y + y - Math.sin(i / 20 * Math.PI) * 25);
  await page.mouse.up();
  return { x: box.x + box.width * .58 + 50, y: box.y + y - 25 };
}
async function image(page: Page) {
  const url = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 400;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#182014'; ctx.fillRect(0, 0, 900, 400);
    ctx.fillStyle = '#c7fa79'; ctx.font = '30px sans-serif'; ctx.fillText('복기 예시 차트', 40, 80);
    for (let i = 0; i < 25; i++) ctx.fillRect(40 + i * 30, 300 - i * 7, 9, 25);
    return canvas.toDataURL();
  });
  return Buffer.from(url.split(',')[1], 'base64');
}
let baseline = new Set<string>();
test.beforeEach(async ({ request }) => {
  const result = await (await request.get(`${API_URL}/api/whiteboards`)).json();
  baseline = new Set(result.boards.map((b: { id: string }) => b.id));
});
test.afterEach(async ({ request }) => {
  const result = await (await request.get(`${API_URL}/api/whiteboards`)).json();
  for (const board of result.boards as WhiteboardDocument[]) if (!baseline.has(board.id)) {
    const doc = await read(request, board.id);
    await request.put(`${API_URL}/api/whiteboards/${doc.id}`, { headers, data: {
      mutation_id: uid(), expected_revision: doc.revision, name: doc.name, scene: doc.scene, review: doc.review, deleted: true,
    } });
  }
});

test('날짜 목록·이전 다음·표시 옵션을 유지하고 기존 글을 한 번만 자유 캔버스로 펼친다', async ({ page, request }, info) => {
  const old = await seed(request, '2199-10-21'), middle = await seed(request, '2199-10-23', true), latest = await seed(request, '2199-10-24');
  const upload = await request.post(`${API_URL}/api/whiteboards/assets`, { headers: { ...headers, 'Content-Type': 'image/png' }, data: await image(page) });
  expect(upload.ok()).toBe(true);
  const asset = await upload.json();
  middle.review!.records[0].image_file_id = 'archived-chart';
  const archived = await request.put(`${API_URL}/api/whiteboards/${middle.id}`, { headers, data: {
    mutation_id: uid(), expected_revision: middle.revision, name: middle.name, review: middle.review,
    scene: { ...middle.scene, files: { 'archived-chart': { ...asset, created: 1 } } },
  } });
  expect(archived.ok()).toBe(true);
  await open(page, middle.id);
  await expect.poll(async () => visible(await read(request, middle.id), 'text').map(el => el.text).join('\n')).toContain('거래량 확인');
  const migrated = await read(request, middle.id);
  expect(migrated.review).toEqual(middle.review);
  expect(visible(migrated, 'image')).toHaveLength(1);
  expect(Object.keys(migrated.scene.files)).toContain('archived-chart');
  const ids = migrated.scene.elements.map(el => el.id);
  await page.getByRole('button', { name: '이전 기록', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(old.id));
  await page.getByRole('button', { name: '다음 기록', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(middle.id));
  await expect(page.getByRole('button', { name: '연필', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '다음 기록', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(latest.id));
  await expect(page.getByRole('button', { name: '다음 기록', exact: true })).toBeDisabled();
  await page.getByTestId(`review-row-${middle.id}`).click();
  const row = page.getByTestId(`review-row-${middle.id}`), detailed = (await row.boundingBox())!.height;
  await page.getByRole('button', { name: '목록 표시 방식', exact: true }).click(); await page.getByRole('button', { name: /간단히/ }).click();
  await expect(row.locator('.rn-row-summary')).toBeHidden(); expect((await row.boundingBox())!.height).toBeLessThan(detailed);
  await page.reload(); await expect(page.getByLabel('날짜별 노트 목록')).toHaveAttribute('data-list-display', 'compact');
  await expect(page.getByRole('button', { name: '연필', exact: true })).toBeEnabled();
  expect((await read(request, middle.id)).scene.elements.map(el => el.id)).toEqual(ids);
  await page.getByRole('button', { name: '기존 기록 원문', exact: true }).click();
  await expect(page.getByTestId('review-document').getByText('당시의 하루 결론', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '캔버스로 돌아가기', exact: true }).click();
  await expect(page.getByTestId('review-canvas')).toBeVisible();
  await page.getByRole('button', { name: '목록 표시 방식', exact: true }).click(); await page.getByRole('button', { name: /자세히/ }).click();
  await page.reload(); await expect(page.getByLabel('날짜별 노트 목록')).toHaveAttribute('data-list-display', 'detail');
  for (const width of [1440, 944, 768]) {
    await page.setViewportSize({ width, height: 950 });
    await expect(page.getByRole('button', { name: '연필', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 950 }); await page.screenshot({ path: info.outputPath('daily-free-canvas.png') });
});

test('차트 위 연필·색상·굵기·지우개·실행 취소와 다시 실행을 실제 포인터로 검증', async ({ page, request }, info) => {
  const doc = await seed(request, '2199-11-01'); await open(page, doc.id);
  await page.getByLabel('복기 이미지 파일 선택').setInputFiles({ name: 'chart.png', mimeType: 'image/png', buffer: await image(page) });
  await expect.poll(async () => visible(await read(request, doc.id), 'image').length).toBe(1);
  await page.getByRole('button', { name: '선택', exact: true }).click();
  // Clear the selected image before changing the pen's style.
  const canvas = page.locator('canvas.interactive'); await canvas.click({ position: { x: 300, y: 120 } });
  await page.getByRole('button', { name: '빨간색 선', exact: true }).click(); await page.getByLabel('선 굵기', { exact: true }).selectOption('4');
  const hit = await draw(page);
  await expect.poll(async () => visible(await read(request, doc.id), 'freedraw').length).toBe(1);
  const stroke = visible(await read(request, doc.id), 'freedraw')[0];
  expect(stroke.strokeColor).toBe('#e03131'); expect(stroke.strokeWidth).toBe(4); expect((stroke.points as unknown[]).length).toBeGreaterThan(10);
  expect(stroke.frameId).toBe(visible(await read(request, doc.id), 'image')[0].frameId);
  expect(stroke.frameId).toBeTruthy();
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect.poll(async () => visible(await read(request, doc.id), 'freedraw').length).toBe(0);
  await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  await expect.poll(async () => visible(await read(request, doc.id), 'freedraw').length).toBe(1);
  await page.getByRole('button', { name: '지우개', exact: true }).click();
  await page.mouse.move(hit.x - 5, hit.y - 15); await page.mouse.down(); await page.mouse.move(hit.x + 5, hit.y + 15, { steps: 6 }); await page.mouse.up();
  await expect.poll(async () => visible(await read(request, doc.id), 'freedraw').length).toBe(0);
  expect(visible(await read(request, doc.id), 'image')).toHaveLength(1);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect.poll(async () => visible(await read(request, doc.id), 'freedraw').length).toBe(1);
  await page.getByRole('button', { name: '선택', exact: true }).click();
  await page.getByRole('button', { name: '템플릿', exact: true }).click(); await page.getByRole('button', { name: '잘한 판단 추가', exact: true }).click();
  await expect.poll(async () => visible(await read(request, doc.id), 'text').some(el => String(el.text).includes('잘한 판단'))).toBe(true);
  await page.getByRole('button', { name: '+ 페이지', exact: true }).click();
  await expect(page.getByRole('button', { name: '페이지 2', exact: true })).toBeVisible();
  await expect.poll(async () => visible(await read(request, doc.id), 'frame').length).toBe(2);
  await page.getByRole('button', { name: '페이지 1', exact: true }).click();
  await page.reload(); await expect(page.getByRole('button', { name: '연필', exact: true })).toBeEnabled();
  const saved = await read(request, doc.id); expect(visible(saved, 'freedraw')).toHaveLength(1); expect(visible(saved, 'image')).toHaveLength(1); expect(visible(saved, 'frame')).toHaveLength(2);
  await page.screenshot({ path: info.outputPath('review-pencil.png') });
});

test('빈 날짜·한글 메모·완료·PNG 및 편집 파일 왕복에서 배치와 이미지를 보존', async ({ page, request, browser }, info) => {
  await page.goto('/whiteboard?date=2199-11-09'); await expect(page.getByRole('heading', { name: '아직 작성한 노트가 없습니다' })).toBeVisible();
  await page.getByRole('button', { name: '이 날짜에 작성하기' }).click(); await expect(page.getByLabel('하루 노트 제목')).toBeVisible();
  const id = new URL(page.url()).searchParams.get('board')!;
  await page.getByLabel('하루 노트 제목').fill('자유롭게 남기는 복기');
  await page.getByRole('button', { name: '메모 추가', exact: true }).click();
  const box = (await page.locator('canvas.interactive').boundingBox())!;
  await page.mouse.dblclick(box.x + box.width / 2 - 65, box.y + box.height / 2 - 50);
  await expect(page.locator('textarea')).toBeVisible();
  await page.locator('textarea').fill('관망 원칙을 지켰다\n다음에도 기다리기'); await page.locator('textarea').press('Escape');
  await expect.poll(async () => visible(await read(request, id), 'text').some(el => String(el.text).includes('관망 원칙'))).toBe(true);
  await page.getByLabel('복기 이미지 파일 선택').setInputFiles({ name: 'review.png', mimeType: 'image/png', buffer: await image(page) });
  await expect.poll(async () => Object.keys((await read(request, id)).scene.files).length).toBe(1);
  await draw(page, 320); await expect.poll(async () => visible(await read(request, id), 'freedraw').length).toBe(1);
  await page.getByRole('button', { name: '복기 완료', exact: true }).click(); await expect.poll(async () => (await read(request, id)).review?.completed).toBe(true);
  await expect(page.getByRole('button', { name: '연필', exact: true })).toHaveCount(0);
  const readCanvas = page.locator('canvas.interactive');
  await readCanvas.click({ position: { x: 350, y: 200 } });
  await page.keyboard.press('Control+a'); await page.keyboard.press('Delete');
  await page.reload(); await expect(page.getByLabel('하루 노트 제목')).toHaveValue('자유롭게 남기는 복기');
  const pngPending = page.waitForEvent('download'); await page.getByRole('button', { name: 'PNG 내보내기', exact: true }).click();
  const png = await pngPending; expect((await readFile((await png.path())!)).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  await page.getByLabel('노트 더보기').click(); const pending = page.waitForEvent('download'); await page.getByRole('button', { name: '편집 파일 내보내기' }).click();
  const file = await readFile((await (await pending).path())!); const exported = JSON.parse(file.toString()); expect(exported.elements.some((el: { type: string }) => el.type === 'freedraw')).toBe(true);
  const clean = await browser.newContext({ baseURL: BASE_URL }); const restored = await clean.newPage(); await restored.goto('/whiteboard?legacy=1');
  await restored.getByLabel('보드 파일 선택').setInputFiles({ name: 'review.whiteboard.json', mimeType: 'application/json', buffer: file });
  await expect(restored.getByLabel('하루 노트 제목')).toHaveValue('자유롭게 남기는 복기');
  const copyId = new URL(restored.url()).searchParams.get('board')!;
  await expect(restored.getByTestId('whiteboard-editor')).toHaveAttribute('data-board-id', copyId);
  const copy = await read(request, copyId); expect(visible(copy, 'freedraw')).toHaveLength(1); expect(Object.keys(copy.scene.files)).toHaveLength(1);
  expect(copy.scene.elements.map(el => el.id)).toEqual(exported.elements.map((el: { id: string }) => el.id));
  await restored.screenshot({ path: info.outputPath('review-canvas-restored.png') }); await clean.close();
});

test('캔버스 저장 장애·초안 복구와 두 창 충돌에서 원문과 양쪽 그림을 보존', async ({ page, context, request }) => {
  const doc = await seed(request, '2199-12-01'); await open(page, doc.id);
  await expect.poll(async () => visible(await read(request, doc.id), 'frame').length).toBe(1);
  await page.route(`**/api/whiteboards/${doc.id}`, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, json: { detail: '테스트 저장 장애' } }) : route.continue());
  await page.getByLabel('하루 노트 제목').fill('장애 중 그림 초안'); await draw(page);
  await expect(page.getByText('저장 실패', { exact: true })).toBeVisible(); await page.reload();
  await expect(page.getByLabel('하루 노트 제목')).toHaveValue('장애 중 그림 초안'); await expect(page.getByText('저장 실패', { exact: true })).toBeVisible();
  await page.unroute(`**/api/whiteboards/${doc.id}`); await page.getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect.poll(async () => visible(await read(request, doc.id), 'freedraw').length).toBe(1);
  const second = await context.newPage(); await open(second, doc.id);
  await page.getByLabel('하루 노트 제목').fill('첫 창 저장'); await expect.poll(async () => (await read(request, doc.id)).name).toBe('첫 창 저장');
  await second.getByLabel('하루 노트 제목').fill('두 번째 창 초안'); await draw(second, 340);
  await expect(second.getByText('다른 창의 변경과 충돌', { exact: true })).toBeVisible();
  await second.getByRole('button', { name: '내 편집을 별도 노트로 저장' }).click(); await expect(second).not.toHaveURL(new RegExp(doc.id));
  await expect(second.getByLabel('하루 노트 제목')).toHaveValue('두 번째 창 초안 복구본');
  const forkId = new URL(second.url()).searchParams.get('board')!;
  expect(visible(await read(request, forkId), 'freedraw')).toHaveLength(2); expect(visible(await read(request, doc.id), 'freedraw')).toHaveLength(1);
  await second.close();
});

test('오늘 작성 재사용과 휴지통 복원 뒤에도 자유 배치가 남는다', async ({ page, request }) => {
  await page.goto('/whiteboard?date=2199-10-30'); await page.getByRole('button', { name: '오늘 작성', exact: true }).click();
  await expect(page.getByLabel('하루 노트 제목')).toBeVisible(); const id = new URL(page.url()).searchParams.get('board')!;
  await draw(page); await expect.poll(async () => visible(await read(request, id), 'freedraw').length).toBe(1);
  await page.getByRole('button', { name: '오늘 작성', exact: true }).click(); await expect(page).toHaveURL(new RegExp(id));
  await page.getByLabel('노트 더보기').click(); await page.getByRole('button', { name: '휴지통으로 이동' }).click();
  await page.getByRole('button', { name: '휴지통', exact: true }).click(); await page.getByTestId(`review-row-${id}`).click();
  await expect(page.getByRole('heading', { name: '휴지통에 있는 노트입니다' })).toBeVisible(); await page.getByLabel('노트 더보기').click(); await page.getByRole('button', { name: '노트 복원' }).click();
  expect(visible(await read(request, id), 'freedraw')).toHaveLength(1);
});

test('외부 페이지 초안을 링크 메모로 복구하고 삽입 메뉴를 숨긴다', async ({ page, request }) => {
  const doc = await seed(request, '2199-12-09'); await open(page, doc.id);
  await expect(page.getByText('저장됨', { exact: true })).toBeVisible();
  const saved = await read(request, doc.id), frame = visible(saved, 'frame')[0];
  const activeId = uid(), deletedId = uid();
  const embeds = [false, true].map((deleted, index) => ({ ...frame, id: index ? deletedId : activeId,
    type: index ? 'iframe' : 'embeddable', customData: {}, x: 100 + index * 330, y: 120, width: 300, height: 180,
    frameId: frame.id, name: undefined, link: index ? 'https://example.com/deleted' : 'https://example.com/review', isDeleted: deleted,
  }));
  await page.evaluate(async ({ saved, embeds, key }) => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('ticklane-whiteboards-v1', 1);
      req.onsuccess = () => {
        const db = req.result, tx = db.transaction('drafts', 'readwrite');
        tx.objectStore('drafts').put({ id: saved.id, revision: saved.revision, name: saved.name, review: saved.review,
          elements: [...saved.scene.elements, ...embeds], files: {}, assets: saved.scene.files, appState: {},
          changedAt: Date.now(), token: 'external-embed-recovery' }, key);
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
      }; req.onerror = () => reject(req.error);
    });
  }, { saved, embeds, key: `${API_URL}/api/whiteboards::${doc.id}::external-embed-recovery` });
  const externalRequests: string[] = [];
  page.on('request', req => { if (req.url().startsWith('https://example.com/')) externalRequests.push(req.url()); });
  await page.reload(); await expect(page.getByRole('button', { name: '연필', exact: true })).toBeEnabled();
  await expect.poll(async () => (await read(request, doc.id)).scene.elements.find(el => el.id === activeId)?.type).toBe('rectangle');
  const restored = await read(request, doc.id);
  expect(restored.scene.elements.some(el => ['iframe', 'embeddable'].includes(String(el.type)))).toBe(false);
  expect(restored.scene.elements.find(el => el.id === activeId)?.link).toBe('https://example.com/review');
  expect(restored.scene.elements.find(el => el.id === deletedId)?.isDeleted).toBe(true);
  expect(visible(restored, 'text').filter(el => String(el.text).includes('example.com/review'))).toHaveLength(1);
  expect(visible(restored, 'text').some(el => String(el.text).includes('example.com/deleted'))).toBe(false);
  await expect(page.getByText('저장됨', { exact: true })).toBeVisible();
  await page.locator('.App-toolbar__extra-tools-trigger').click();
  await expect(page.getByTestId('toolbar-frame')).toBeVisible();
  await expect(page.getByRole('button', { name: '웹 임베드', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mermaid에서 불러오기', exact: true })).toBeVisible();
  expect(externalRequests).toEqual([]);
});

test('안내·저장 오류·재시도가 캔버스 위치와 높이를 바꾸지 않는다', async ({ page, request }, info) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  const doc = await seed(request, '2199-12-10'); await open(page, doc.id);
  await expect(page.getByText('저장됨', { exact: true })).toBeVisible();
  const canvas = page.locator('canvas.interactive'), before = (await canvas.boundingBox())!;
  async function unchanged() {
    await expect.poll(async () => { const now = (await canvas.boundingBox())!; return Math.abs(now.y - before.y) + Math.abs(now.height - before.height); }).toBeLessThan(1);
  }
  await page.getByLabel('복기 이미지 파일 선택').setInputFiles({ name: 'notice.png', mimeType: 'image/png', buffer: await image(page) });
  await expect(page.getByText('이미지를 캔버스에 추가했습니다', { exact: true })).toBeVisible(); await unchanged();
  await page.getByRole('button', { name: '안내 닫기', exact: true }).click(); await unchanged();
  await expect.poll(async () => visible(await read(request, doc.id), 'image').length).toBe(1);
  await page.route(`**/api/whiteboards/${doc.id}`, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, json: { detail: { code: 'whiteboard_storage_failed', message: '저장 오류 위치 검증' } } }) : route.continue());
  await page.getByLabel('하루 노트 제목').fill('안내가 떠도 캔버스 위치 유지');
  await expect(page.getByText('저장 오류 위치 검증', { exact: true })).toBeVisible(); await unchanged();
  await page.screenshot({ path: info.outputPath('canvas-notice-overlay.png') });
  await page.unroute(`**/api/whiteboards/${doc.id}`); await page.getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect(page.getByText('저장됨', { exact: true })).toBeVisible(); await unchanged();
  expect((await read(request, doc.id)).name).toBe('안내가 떠도 캔버스 위치 유지');
});


test('캔버스 기본 도구·추가 도구·색상은 공통 툴팁으로 표시하고 닫는다', async ({ page, request }, info) => {
  const doc = await seed(request, '2199-12-11'); await open(page, doc.id);
  const canvas = page.locator('canvas.interactive'), before = (await canvas.boundingBox())!;
  const selection = page.getByRole('radio', { name: '선택', exact: true }).locator('..');
  await selection.hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toContainText('선택');
  await expect(tooltip).toHaveClass(/tooltip-surface/);
  await expect(selection).not.toHaveAttribute('title');
  const surface = await tooltip.evaluate(el => {
    const css = getComputedStyle(el);
    return { font: css.fontFamily, size: css.fontSize, background: css.backgroundColor, border: css.borderRadius, padding: css.padding };
  });
  await page.keyboard.press('Escape'); await expect(tooltip).toHaveCount(0);
  const extra = page.locator('.App-toolbar__extra-tools-trigger');
  await extra.hover(); await expect(tooltip).toBeVisible();
  await expect(page.locator('.excalidraw-tooltip--visible')).toBeHidden();
  await page.screenshot({ path: info.outputPath('canvas-common-tooltip.png') });
  await page.keyboard.press('Escape'); await expect(tooltip).toHaveCount(0);
  await expect(page.locator('.excalidraw-tooltip--visible')).toHaveCount(0);
  const green = page.getByRole('button', { name: '초록색 선', exact: true });
  await green.hover(); await expect(tooltip).toHaveText('초록색 선');
  expect(await tooltip.evaluate(el => {
    const css = getComputedStyle(el);
    return { font: css.fontFamily, size: css.fontSize, background: css.backgroundColor, border: css.borderRadius, padding: css.padding };
  })).toEqual(surface);
  await green.click(); await expect(tooltip).toHaveCount(0);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '빨간색 선', exact: true })).toBeFocused();
  await expect(tooltip).toHaveText('빨간색 선');
  await page.evaluate(() => window.dispatchEvent(new Event('scroll'))); await expect(tooltip).toHaveCount(0);
  const after = (await canvas.boundingBox())!;
  expect(Math.abs(after.y - before.y) + Math.abs(after.height - before.height)).toBeLessThan(1);
});
