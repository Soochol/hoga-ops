import { restoreElements } from '@excalidraw/excalidraw';
import type { BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { createBoard } from '../api/whiteboards';
import type { BoardSession } from './session';
import { imageFile, fromDataURL, persistImages } from './images';

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function safeFilename(name: string) {
  return (
    [...name]
      .map((char) => (char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? '_' : char))
      .join('')
      .slice(0, 100) || '화이트보드'
  );
}
export function selectedElements(
  api: ExcalidrawImperativeAPI,
  selectionOnly: boolean,
): readonly ExcalidrawElement[] {
  const elements = api.getSceneElements();
  if (!selectionOnly) return elements;
  const ids = api.getAppState().selectedElementIds;
  return elements.filter((el) => ids[el.id] || (el.type === 'text' && el.containerId && ids[el.containerId]));
}
export function exportBoardFile(session: BoardSession) {
  const payload = {
    type: 'ticklane-whiteboard',
    schema_version: session.state.review ? 2 : 1,
    engine_version: 'excalidraw/0.18.1',
    name: session.state.name,
    review: session.state.review,
    elements: session.elements,
    appState: session.appState,
    files: session.files,
  };
  downloadBlob(
    new Blob([JSON.stringify(payload)], { type: 'application/json' }),
    safeFilename(session.state.name) + '.whiteboard.json',
  );
}
export async function importBoardFile(file: File) {
  if (file.size > 128 * 1024 * 1024) throw new Error('편집 파일은 최대 128MB까지 가져올 수 있습니다');
  const raw = JSON.parse(await file.text());
  if (
    raw.type !== 'ticklane-whiteboard' ||
    ![1, 2].includes(raw.schema_version) ||
    raw.engine_version !== 'excalidraw/0.18.1' ||
    !Array.isArray(raw.elements) ||
    raw.elements.length > 10_000 ||
    !raw.files ||
    typeof raw.files !== 'object'
  )
    throw new Error('지원하는 화이트보드 편집 파일이 아닙니다');
  const allowed = new Set([
    'rectangle',
    'ellipse',
    'diamond',
    'line',
    'arrow',
    'freedraw',
    'text',
    'image',
    'frame',
  ]);
  if (
    raw.elements.some(
      (el: Record<string, unknown>) =>
        !el || !allowed.has(String(el.type)) || !Number.isFinite(el.x) || !Number.isFinite(el.y),
    )
  )
    throw new Error('지원하지 않거나 손상된 객체가 있습니다');
  const elements = restoreElements(raw.elements, null);
  const files: BinaryFiles = {};
  if (Object.keys(raw.files).length > 100)
    throw new Error('이미지는 한 번에 최대 100장까지 가져올 수 있습니다');
  for (const [id, value] of Object.entries(raw.files)) {
    const candidate = value as { dataURL?: string };
    if (typeof candidate?.dataURL !== 'string') throw new Error('편집 파일의 이미지 데이터가 없습니다');
    const image = await imageFile(fromDataURL(candidate.dataURL));
    files[id] = { ...image.file, id: id as typeof image.file.id };
  }
  if (elements.some((el) => el.type === 'image' && !el.isDeleted && (!el.fileId || !files[el.fileId])))
    throw new Error('편집 파일에 필요한 이미지가 빠져 있습니다');
  const assets = await persistImages(files, {});
  return createBoard(typeof raw.name === 'string' ? raw.name.slice(0, 120) : '가져온 보드', {
    elements: elements as unknown as Record<string, unknown>[],
    appState: {},
    files: assets,
  }, undefined, raw.review ?? undefined);
}
