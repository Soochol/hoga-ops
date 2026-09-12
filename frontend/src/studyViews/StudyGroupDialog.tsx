import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ModalShell } from '../ui/ModalShell';
import type { StudyViewGroup } from '../api/studyViews';
import { StudyGroupPicker, validStudyGroupChoice, type StudyGroupChoice } from './StudyGroupPicker';
import { useStudyViewMutations } from './useStudyViews';
import { useLivePageStore } from '../state/livePage';

export type StudyGroupAction = { type: 'create' } | { type: 'rename' | 'delete'; group: StudyViewGroup; count: number; ids: string[] } | { type: 'move'; ids: string[] };
export function StudyGroupDialog({ action, groups, onClose }: { action: StudyGroupAction; groups: StudyViewGroup[]; onClose: () => void }) {
  const mutations = useStudyViewMutations();
  const [name, setName] = useState(action.type === 'rename' ? action.group.name : '');
  const [choice, setChoice] = useState<StudyGroupChoice>({});
  const [error, setError] = useState('');
  const pending = mutations.createGroup.isPending || mutations.renameGroup.isPending || mutations.deleteGroup.isPending || mutations.move.isPending;
  const title = action.type === 'create' ? '그룹 만들기' : action.type === 'rename' ? '그룹 이름 변경' : action.type === 'delete' ? '그룹 삭제' : '그룹 이동';
  const submit = async () => {
    if (pending) return;
    setError('');
    try {
      if (action.type === 'create') await mutations.createGroup.mutateAsync(name.trim());
      if (action.type === 'rename') await mutations.renameGroup.mutateAsync({ id: action.group.id, name: name.trim() });
      if (action.type === 'move' && choice.group_id) await mutations.move.mutateAsync({ ids: action.ids, groupId: choice.group_id });
      if (action.type === 'delete') {
        await mutations.deleteGroup.mutateAsync(action.group.id);
        const page = useLivePageStore.getState();
        if (page.savedRangeFocus && action.ids.includes(page.savedRangeFocus.viewId)) page.clearSavedRange();
      }
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : '그룹 변경에 실패했습니다'); }
  };
  return createPortal(<ModalShell ariaLabel={title} width="w-[360px]" onClose={() => { if (!pending) onClose(); }}>
    <form className="space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); void submit(); }} onKeyDown={(e) => { if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault(); }}>
      <h2 className="text-sm font-semibold">{title}</h2>
      {action.type === 'move' ? <><p className="text-xs">저장뷰 {action.ids.length}개 이동</p><StudyGroupPicker groups={groups} value={choice} onChange={setChoice} allowCreate={false} /></>
        : action.type === 'delete' ? <p className="text-sm">{action.group.name} 그룹과 저장뷰 {action.count}개를 삭제합니다</p>
        : <label className="block text-xs">그룹 이름<input aria-label="그룹 이름" value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded border bg-bg-input px-2 py-1 text-sm" /></label>}
      {error && <p role="alert" className="text-xs text-error">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" disabled={pending} className="rounded border px-3 py-1 text-sm" onClick={onClose}>취소</button>
        <button type="submit" disabled={pending || (action.type === 'move' ? !validStudyGroupChoice(groups, choice) : action.type !== 'delete' && !name.trim())} className="rounded border px-3 py-1 text-sm text-accent disabled:opacity-40">
          {pending ? '처리 중' : action.type === 'delete' ? '그룹과 저장뷰 삭제' : action.type === 'move' ? '이동' : '저장'}
        </button>
      </div>
    </form>
  </ModalShell>, document.body);
}
