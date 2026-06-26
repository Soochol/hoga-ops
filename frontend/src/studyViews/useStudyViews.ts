import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createStudyView,
  deleteStudyView,
  listStudyViews,
  updateStudyViewMetadata,
  updateStudyView,
  type StudyViewMetadataUpdateRequest,
  type StudyViewSaveWriteRequest,
} from '../api/studyViews';

export const STUDY_VIEW_SAVES_QUERY = ['study-view-saves'] as const;

export function useStudyViews() {
  return useQuery({ queryKey: STUDY_VIEW_SAVES_QUERY, queryFn: listStudyViews });
}

export function useStudyViewMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: STUDY_VIEW_SAVES_QUERY });
  return {
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
