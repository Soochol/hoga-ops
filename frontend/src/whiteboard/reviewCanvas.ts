import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/data/transform';
import type { ExcalidrawElement, ExcalidrawFrameElement, FileId } from '@excalidraw/excalidraw/element/types';
import type { ReviewNote, WhiteboardScene } from '../api/whiteboards';

export const PAGE_WIDTH = 1100;
export const PAGE_HEIGHT = 760;
export const isReviewPage = (element: Pick<ExcalidrawElement, 'type' | 'customData'>) =>
  element.type === 'frame' && element.customData?.reviewCanvasVersion === 1;
export const reviewPages = (elements: readonly ExcalidrawElement[]) =>
  elements.filter((element): element is ExcalidrawFrameElement => isReviewPage(element) && !element.isDeleted);

export function pageSkeleton(id: string, x: number, name: string): ExcalidrawElementSkeleton {
  return { type: 'frame', id, x, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT, children: [], name,
    customData: { reviewCanvasVersion: 1 } };
}

/** Build a one-time canvas projection. The original structured review stays unchanged. */
export function reviewCanvasPlan(
  id: string, name: string, note: ReviewNote, scene: Pick<WhiteboardScene, 'files'>,
  existing: readonly ExcalidrawElement[],
): ExcalidrawElementSkeleton[] {
  // Tombstones count: deleting/undoing a page must never re-import the archived text.
  if (existing.some(isReviewPage)) return [];
  const frameId = `review-page-${id}`;
  const left = existing.length ? Math.max(...existing.map(el => el.x + el.width)) + 80 : 0;
  const plan: ExcalidrawElementSkeleton[] = [];
  let y = 42;
  function text(key: string, value: string, size = 20) {
    if (!value.trim()) return;
    // Keep the complete original text, including long paragraphs and explicit newlines.
    plan.push({ type: 'text', id: `review-${id}-${key}`, x: left + 42, y, text: value,
      width: PAGE_WIDTH - 84, autoResize: false, fontSize: size, fontFamily: 2,
      strokeColor: '#1e1e1e', frameId });
    const lines = value.split('\n').reduce((count, line) => count + Math.max(1, Math.ceil([...line].length / 42)), 0);
    y += lines * size * 1.5 + 32;
  }
  const hasText = note.summary || note.good || note.change || note.principle || note.records.length;
  if (hasText) text('title', name, 32);
  if (note.summary) text('summary', `하루 결론\n${note.summary}`);
  note.records.forEach(record => {
    const heading = [record.stock, record.code, record.title, record.timeframe].filter(Boolean).join(' · ');
    if (heading) text(`${record.id}-title`, heading, 24);
    if (record.captured_at_ms) text(`${record.id}-time`, `캡처 ${new Date(record.captured_at_ms).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST`, 16);
    if (record.image_file_id) {
      const file = scene.files[record.image_file_id];
      const width = Math.min(720, file?.width ?? 720), height = width * (file ? file.height / file.width : 0.6);
      plan.push({ type: 'image', id: `review-${id}-${record.id}-image`, x: left + 42, y, width, height,
        fileId: record.image_file_id as FileId, status: 'saved', scale: [1, 1], frameId,
        link: record.code ? `/live?code=${encodeURIComponent(record.code)}` : null,
        customData: { chartSource: { code: record.code, timeframe: record.timeframe, captured_at_ms: record.captured_at_ms } } });
      y += height + 32;
    }
    const copy = [['당시 판단', record.judgment], ['행동', record.action], ['결과', record.result]]
      .filter(([, value]) => value).map(([label, value]) => `${label}\n${value}`).join('\n\n');
    text(`${record.id}-copy`, copy);
  });
  if (note.good) text('good', `잘한 판단\n${note.good}`);
  if (note.change) text('change', `바꿀 행동\n${note.change}`);
  if (note.principle) text('principle', `다음에 적용할 원칙\n${note.principle}`);
  return [{ ...pageSkeleton(frameId, left, '페이지 1'), height: Math.max(PAGE_HEIGHT, y + 42),
    children: plan.map(element => element.id!) } as ExcalidrawElementSkeleton, ...plan];
}
