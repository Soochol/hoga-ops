import { convertToExcalidrawElements } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';

export const isExternalEmbed = (element: Pick<ExcalidrawElement, 'type'>) =>
  element.type === 'embeddable' || element.type === 'iframe';

/** Keep failed/local embeds as editable link notes, including their deletion state. */
export function externalEmbedsAsNotes(elements: readonly ExcalidrawElement[]): readonly ExcalidrawElement[] {
  if (!elements.some(isExternalEmbed)) return elements;
  return elements.flatMap(element => {
    if (!isExternalEmbed(element)) return [element];
    const link = element.link ?? '';
    return convertToExcalidrawElements([{
      type: 'rectangle', id: element.id, x: element.x, y: element.y,
      width: Math.max(260, element.width), height: Math.max(140, element.height),
      backgroundColor: '#e9edcf', strokeColor: '#c5c9af', fillStyle: 'solid', roughness: 0,
      link: /^https?:\/\//i.test(link) ? link : null,
      customData: { ...element.customData, originalEmbed: { type: element.type, link } },
      label: { text: link ? `외부 링크\n${link}` : '외부 링크', fontFamily: 2, fontSize: 20,
        strokeColor: '#1e1e1e', textAlign: 'left', verticalAlign: 'top' },
    }], { regenerateIds: false }).map(note => ({ ...note,
      boundElements: note.id === element.id ? [...(element.boundElements ?? []), ...(note.boundElements ?? [])] : note.boundElements,
      frameId: element.frameId,
      angle: element.angle, groupIds: element.groupIds, locked: element.locked,
      isDeleted: element.isDeleted, version: element.version + 1 }));
  });
}
