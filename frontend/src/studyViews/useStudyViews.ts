import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createStudyView,
  deleteStudyView,
  getStudyViewSnapshot,
  listStudyViews,
  updateStudyViewMetadata,
  updateStudyView,
  type StudyViewMetadataUpdateRequest,
  type StudyViewSaveWriteRequest,
} from '../api/studyViews';

export const STUDY_VIEW_SAVES_QUERY = ['study-view-saves'] as const;
export const studyViewSnapshotQuery = (id: string | null) => ['study-view-snapshot', id] as const;

export function useStudyViews() {
  return useQuery({ queryKey: STUDY_VIEW_SAVES_QUERY, queryFn: listStudyViews });
}

export function useStudyViewSnapshot(id: string | null) {
  return useQuery({
    queryKey: studyViewSnapshotQuery(id),
    queryFn: () => getStudyViewSnapshot(id!),
    enabled: id !== null,
  });
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
      onSuccess: (_save, vars) => {
        invalidate();
        qc.invalidateQueries({ queryKey: studyViewSnapshotQuery(vars.id) });
      },
    }),
    updateMetadata: useMutation({
      mutationFn: ({ id, body }: { id: string; body: StudyViewMetadataUpdateRequest }) =>
        updateStudyViewMetadata(id, body),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: deleteStudyView,
      onSuccess: (_result, id) => {
        invalidate();
        qc.removeQueries({ queryKey: studyViewSnapshotQuery(id) });
      },
    }),
  };
}
