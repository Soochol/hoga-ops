import type { BinaryFileData, BinaryFiles, DataURL } from '@excalidraw/excalidraw/types';
import type { FileId } from '@excalidraw/excalidraw/element/types';
import type { WhiteboardScene } from '../api/whiteboards';
import { readBoardImage, uploadBoardImage } from '../api/whiteboards';
import { randomId } from '../util/randomId';

export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 24_000_000;
export const dataURL = (blob: Blob): Promise<DataURL> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as DataURL);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
export function fromDataURL(value: string): Blob {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
  if (!match || value.length > MAX_IMAGE_BYTES * 1.4)
    throw new Error('PNG/JPG/WebP, 한 장당 최대 16MB 이미지만 지원합니다');
  const binary = atob(match[2]);
  return new Blob([Uint8Array.from(binary, (c) => c.charCodeAt(0))], { type: match[1] });
}
export async function imageFile(
  file: Blob,
): Promise<{ file: BinaryFileData; width: number; height: number }> {
  if (file.size > MAX_IMAGE_BYTES || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    throw new Error('PNG/JPG/WebP, 한 장당 최대 16MB 이미지만 지원합니다');
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  bitmap.close();
  if (width * height > MAX_IMAGE_PIXELS) throw new Error('이미지는 최대 24메가픽셀까지 지원합니다');
  const bytes = await file.arrayBuffer();
  const id = (
    crypto.subtle
      ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join('')
      : randomId()
  ) as FileId;
  return {
    file: {
      id,
      dataURL: await dataURL(file),
      mimeType: file.type as BinaryFileData['mimeType'],
      created: Date.now(),
    },
    width,
    height,
  };
}
export async function loadImages(scene: WhiteboardScene): Promise<BinaryFiles> {
  const files: BinaryFiles = {};
  const entries = Object.entries(scene.files);
  // Bound concurrent decoding/network work for image-heavy boards.
  for (let index = 0; index < entries.length; index += 3) {
    await Promise.all(
      entries.slice(index, index + 3).map(async ([id, meta]) => {
        files[id] = {
          id: id as FileId,
          dataURL: await dataURL(await readBoardImage(meta.asset_id)),
          mimeType: meta.mime_type as BinaryFileData['mimeType'],
          created: meta.created,
        };
      }),
    );
  }
  return files;
}
export async function persistImages(
  files: BinaryFiles,
  known: WhiteboardScene['files'],
): Promise<WhiteboardScene['files']> {
  const result = { ...known };
  for (const [id, file] of Object.entries(files)) {
    if (!result[id])
      result[id] = { ...(await uploadBoardImage(fromDataURL(file.dataURL))), created: file.created };
  }
  return result;
}
