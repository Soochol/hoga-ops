import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createStudyViewGroup, renameStudyViewGroup, deleteStudyViewGroup, moveStudyViews,
  createStudyView,
  deleteStudyView,
  listStudyViews,
  updateStudyViewMetadata,
  updateStudyView,
  type StudyViewMetadataUpdateRequest,
  type StudyViewSaveWriteRequest,
} from '../api/studyViews';
import { STUDY_VIEW_SAVES_QUERY } from './studyViewKeys';

export { STUDY_VIEW_SAVES_QUERY };

export function useStudyViews() {
  return useQuery({ queryKey: STUDY_VIEW_SAVES_QUERY, queryFn: listStudyViews });
}

export function useStudyViewMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: STUDY_VIEW_SAVES_QUERY });
  return {
    createGroup: useMutation({ mutationFn: createStudyViewGroup, onSuccess: invalidate }),
    renameGroup: useMutation({ mutationFn: ({ id, name }: { id: string; name: string }) => renameStudyViewGroup(id, name), onSuccess: invalidate }),
    deleteGroup: useMutation({ mutationFn: deleteStudyViewGroup, onSuccess: invalidate }),
    move: useMutation({ mutationFn: ({ ids, groupId }: { ids: string[]; groupId: string }) => moveStudyViews(ids, groupId), onSuccess: invalidate }),
    create: useMutation({
      mutationFn: (body: StudyViewSaveWriteRequest) => createStudyView(body),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: ({ id, body }: { id: string; body: StudyViewSaveWriteRequest }) => updateStudyView(id, body),
      onSuccess: invalidate,
    }),
    updateMetadata: useMutation({
      mutationFn: ({ id, body }: { id: string; body: StudyViewMetadataUpdateRequest }) =>
        updateStudyViewMetadata(id, body),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: deleteStudyView,
      onSuccess: invalidate,
    }),
  };
}
