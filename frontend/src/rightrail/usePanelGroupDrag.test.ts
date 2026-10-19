import { afterEach, describe, expect, it } from 'vitest';
import { resolvePanelGroupDrop } from './usePanelGroupDrag';

afterEach(() => { document.body.innerHTML = ''; });

function panel() {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => new DOMRect(0, 0, 300, 400);
  ['a', 'b', 'c'].forEach((id, i) => {
    const header = document.createElement('div');
    header.dataset.panelGroupId = id;
    header.getBoundingClientRect = () => new DOMRect(0, 160 + i * 36, 300, 36);
    el.append(header);
  });
  document.body.append(el);
  return el;
}

describe('panel group drop intent', () => {
  it('cancels above and below the compact list, even inside the panel', () => {
    const el = panel();
    for (const y of [100, 300]) expect(resolvePanelGroupDrop(el, ['a', 'b', 'c'], 'b', { x: 150, y })).toBeNull();
  });

  it('keeps the original slot and adjacent insertions that would not change order', () => {
    const el = panel();
    for (const y of [190, 210, 238]) expect(resolvePanelGroupDrop(el, ['a', 'b', 'c'], 'b', { x: 150, y })).toBeNull();
  });

  it('inserts before and after the actual header midpoint', () => {
    const el = panel();
    expect(resolvePanelGroupDrop(el, ['a', 'b', 'c'], 'c', { x: 150, y: 165 }))
      .toEqual({ folderId: 'a', side: 'before', orderedIds: ['c', 'a', 'b'] });
    expect(resolvePanelGroupDrop(el, ['a', 'b', 'c'], 'c', { x: 150, y: 190 }))
      .toEqual({ folderId: 'a', side: 'after', orderedIds: ['a', 'c', 'b'] });
  });

  it('ignores visible headers outside the panel and groups excluded from the sortable list', () => {
    const el = panel();
    el.getBoundingClientRect = () => new DOMRect(0, 200, 300, 200);
    expect(resolvePanelGroupDrop(el, ['a', 'b', 'c'], 'b', { x: 150, y: 165 })).toBeNull();
    expect(resolvePanelGroupDrop(el, ['b', 'c'], 'c', { x: 150, y: 210 }))
      .toEqual({ folderId: 'b', side: 'before', orderedIds: ['c', 'b'] });
    expect(resolvePanelGroupDrop(el, ['b', 'c'], 'b', { x: 350, y: 250 })).toBeNull();
    expect(resolvePanelGroupDrop(el, ['b', 'c'], 'missing', { x: 150, y: 250 })).toBeNull();
  });
});
