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
function record(title: string) {
  return { id: uid(), title, stock: '삼성전자', code: '005930', timeframe: '5m', captured_at_ms: null,
    image_file_id: null, judgment: '지지 확인', action: '조건까지 관망', result: '원칙을 지켰다' };
}
async function seed(request: APIRequestContext, date: string, count = 2) {
  const id = uid();
  const response = await request.post(`${API_URL}/api/whiteboards`, { headers,
    data: { id, mutation_id: uid(), name: `${date} 매일 복기`,
      review: { ...emptyReview(date), summary: '조건을 확인하고 진입한다', principle: '무효화 조건을 먼저 적는다',
        records: Array.from({ length: count }, (_, i) => record(`기록 ${i + 1}`)) } } });
  expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<WhiteboardDocument>;
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

test('날짜 정렬, 빈 날짜 건너뛰기, 읽기 위치와 간단히/자세히 마지막 값', async ({ page, request }, info) => {
  const old = await seed(request, '2199-10-21'), middle = await seed(request, '2199-10-23', 7), latest = await seed(request, '2199-10-24');
  await page.goto(`/whiteboard?board=${middle.id}`);
  await expect(page.getByRole('heading', { name: middle.name, exact: true })).toBeVisible();
  await expect(page.getByLabel('하루 노트 제목')).toHaveCount(0);
  await page.getByRole('button', { name: '이전 기록', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(old.id));
  await page.getByRole('button', { name: '다음 기록', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(middle.id));
  await page.getByRole('button', { name: '전체 펼치기', exact: true }).click();
  await expect(page.locator('.rn-record-summary[aria-expanded=true]')).toHaveCount(7);
  await page.getByTestId('review-document').evaluate(el => { el.scrollTop = 700; });
  await page.getByRole('button', { name: '다음 기록', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(latest.id));
  await expect(page.getByRole('button', { name: '다음 기록', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '이전 기록', exact: true }).click();
  await expect(page.locator('.rn-record-summary[aria-expanded=true]')).toHaveCount(7);
  await expect.poll(() => page.getByTestId('review-document').evaluate(el => el.scrollTop)).toBeGreaterThan(600);
  const row = page.getByTestId(`review-row-${middle.id}`);
  const detailed = (await row.boundingBox())!.height;
  await page.getByRole('button', { name: '목록 표시 방식', exact: true }).click();
  await page.getByRole('button', { name: /간단히/ }).click();
  await expect(row.locator('.rn-row-summary')).toBeHidden();
  expect((await row.boundingBox())!.height).toBeLessThan(detailed);
  await page.reload();
  await expect(page.getByLabel('날짜별 노트 목록')).toHaveAttribute('data-list-display', 'compact');
  await page.getByRole('button', { name: '목록 표시 방식', exact: true }).click();
  await page.getByRole('button', { name: /자세히/ }).click();
  await page.reload();
  await expect(page.getByLabel('날짜별 노트 목록')).toHaveAttribute('data-list-display', 'detail');
  await page.getByRole('searchbox', { name: '노트 검색' }).fill('2199-10-24');
  await expect(page.locator('.rn-date-row')).toHaveCount(1);
  await page.getByRole('searchbox', { name: '노트 검색' }).fill('');
  await page.getByRole('button', { name: '전체 접기', exact: true }).click();
  await expect(page.locator('.rn-record-summary[aria-expanded=true]')).toHaveCount(0);
  for (const width of [1440, 944, 768]) {
    await page.setViewportSize({ width, height: 950 });
    await expect(page.getByRole('button', { name: '이전 기록', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.getByTestId(`review-row-${middle.id}`).click();
  await page.getByRole('button', { name: '전체 펼치기', exact: true }).click();
  await page.getByTestId('review-document').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath('daily-review.png') });
});

test('빈 날짜 작성, 한글·이미지 자동 저장, 완료·재열기와 편집 파일 왕복', async ({ page, request, browser }, info) => {
  await page.goto('/whiteboard?date=2199-11-01');
  await expect(page.getByRole('heading', { name: '아직 작성한 노트가 없습니다' })).toBeVisible();
  await page.getByRole('button', { name: '이 날짜에 작성하기' }).click();
  await expect(page.getByLabel('하루 노트 제목')).toBeVisible();
  const id = new URL(page.url()).searchParams.get('board')!;
  await page.getByLabel('하루 노트 제목').fill('매일 남기는 복기');
  await page.getByLabel('하루 결론', { exact: true }).fill('확인한 근거와 당시 판단');
  await page.getByLabel('잘한 판단', { exact: true }).fill('관망 원칙을 지켰다');
  await page.getByLabel('바꿀 행동', { exact: true }).fill('진입을 서두르지 않는다');
  await page.getByLabel('다음에 적용할 원칙', { exact: true }).fill('무효화 조건을 먼저 적는다');
  await page.getByRole('button', { name: '기록 추가', exact: true }).click();
  await page.locator('.rn-record-summary').click();
  await page.getByLabel('기록 종목명').fill('삼성전자');
  await page.getByLabel('기록 종목 코드').fill('005930');
  await page.getByLabel('기록 제목').fill('첫 눌림 관찰');
  await page.getByLabel('당시 판단', { exact: true }).fill('거래량 확인');
  await page.getByLabel('행동', { exact: true }).fill('지지까지 기다렸다');
  await page.getByLabel('결과', { exact: true }).fill('조건대로 대응');
  await page.getByLabel('복기 이미지 파일 선택').setInputFiles({ name: 'review.png', mimeType: 'image/png', buffer: await image(page) });
  await expect.poll(async () => (await read(request, id)).review?.records.length).toBe(2);
  await page.getByRole('button', { name: '복기 완료', exact: true }).click();
  await expect.poll(async () => (await read(request, id)).review?.completed).toBe(true);
  const saved = await read(request, id);
  expect(saved.review?.date).toBe('2199-11-01');
  expect(saved.review?.records[0].code).toBe('005930');
  await page.reload();
  await expect(page.getByRole('heading', { name: '매일 남기는 복기' })).toBeVisible();
  await expect(page.getByTestId('review-document').getByText('확인한 근거와 당시 판단', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '전체 펼치기', exact: true }).click();
  await expect(page.getByRole('img', { name: 'review.png', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '기록 이미지 크게 보기' }).click();
  await expect(page.getByRole('dialog', { name: '복기 이미지 크게 보기' })).toBeVisible();
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByLabel('노트 더보기').click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '편집 파일 내보내기' }).click();
  const download = await pending, file = await readFile((await download.path())!);
  const exported = JSON.parse(file.toString()); expect(exported.review.principle).toBe('무효화 조건을 먼저 적는다');
  const clean = await browser.newContext(); const restore = await clean.newPage();
  await restore.goto('/whiteboard?legacy=1');
  await restore.getByLabel('보드 파일 선택').setInputFiles({ name: 'review.whiteboard.json', mimeType: 'application/json', buffer: file });
  await expect(restore.getByRole('heading', { name: '매일 남기는 복기' })).toBeVisible();
  await expect(restore.getByText('무효화 조건을 먼저 적는다', { exact: true })).toBeVisible();
  await restore.screenshot({ path: info.outputPath('review-restored.png') }); await clean.close();
  await page.getByRole('link', { name: '기존 보드', exact: true }).click();
  await page.getByRole('link', { name: '← 복기 노트 목록', exact: true }).click();
  await expect(page.getByRole('button', { name: '오늘 작성', exact: true })).toBeVisible();
});

test('저장 장애 중 초안을 새로고침 복구하고 두 창 충돌을 별도 노트로 보관', async ({ page, context, request }) => {
  const doc = await seed(request, '2199-12-01');
  await page.goto(`/whiteboard?board=${doc.id}&mode=edit`);
  await page.route(`**/api/whiteboards/${doc.id}`, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: '테스트 저장 장애' }) }) : route.continue());
  await page.getByLabel('하루 결론', { exact: true }).fill('서버 장애 중에도 보관할 문장');
  await expect(page.getByText('저장 실패', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('하루 결론', { exact: true })).toHaveValue('서버 장애 중에도 보관할 문장');
  await expect(page.getByText('저장 실패', { exact: true })).toBeVisible();
  await page.unroute(`**/api/whiteboards/${doc.id}`);
  await page.getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect.poll(async () => (await read(request, doc.id)).review?.summary).toBe('서버 장애 중에도 보관할 문장');
  const second = await context.newPage(); await second.goto(`/whiteboard?board=${doc.id}&mode=edit`);
  await expect(second.getByLabel('하루 결론', { exact: true })).toHaveValue('서버 장애 중에도 보관할 문장');
  await page.getByLabel('하루 결론', { exact: true }).fill('첫 창의 저장');
  await expect.poll(async () => (await read(request, doc.id)).review?.summary).toBe('첫 창의 저장');
  await second.getByLabel('하루 결론', { exact: true }).fill('두 번째 창의 초안');
  await expect(second.getByText('다른 창의 변경과 충돌', { exact: true })).toBeVisible();
  await second.getByRole('button', { name: '내 편집을 별도 노트로 저장' }).click();
  await expect(second).not.toHaveURL(new RegExp(doc.id));
  await expect(second.getByLabel('하루 결론', { exact: true })).toHaveValue('두 번째 창의 초안');
  expect((await read(request, doc.id)).review?.summary).toBe('첫 창의 저장');
  await second.close();
});

test('오늘 작성은 기존 날짜를 이어 쓰고 휴지통에서도 글과 이미지를 보존', async ({ page, request }) => {
  await page.goto('/whiteboard?date=2199-10-30');
  await page.getByRole('button', { name: '오늘 작성', exact: true }).click();
  await expect(page.getByLabel('하루 노트 제목')).toBeVisible();
  const id = new URL(page.url()).searchParams.get('board')!;
  await page.getByLabel('하루 결론', { exact: true }).fill('오늘도 기준을 확인했다');
  await expect.poll(async () => (await read(request, id)).review?.summary).toBe('오늘도 기준을 확인했다');
  await page.getByRole('button', { name: '오늘 작성', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(id));
  await page.getByLabel('노트 더보기').click();
  await page.getByRole('button', { name: '휴지통으로 이동' }).click();
  await page.getByRole('button', { name: '휴지통', exact: true }).click();
  await page.getByTestId(`review-row-${id}`).click();
  await expect(page.getByRole('heading', { name: '휴지통에 있는 노트입니다' })).toBeVisible();
  await page.getByLabel('노트 더보기').click(); await page.getByRole('button', { name: '노트 복원' }).click();
  expect((await read(request, id)).review?.summary).toBe('오늘도 기준을 확인했다');
});
