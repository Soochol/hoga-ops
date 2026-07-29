import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createStudyLayoutPreset,
  deleteStudyLayoutPreset,
  listStudyLayoutPresets,
  updateStudyLayoutPreset,
  type StudyLayoutPresetWriteRequest,
} from '../../api/studyLayoutPresets';

export const STUDY_LAYOUT_PRESETS_QUERY = ['study-layout-presets'] as const;

export function useStudyLayoutPresets() {
  return useQuery({ queryKey: STUDY_LAYOUT_PRESETS_QUERY, queryFn: listStudyLayoutPresets });
}

export function useStudyLayoutPresetMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: STUDY_LAYOUT_PRESETS_QUERY });
  return {
    create: useMutation({
      mutationFn: (body: StudyLayoutPresetWriteRequest) => createStudyLayoutPreset(body),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: ({ id, body }: { id: string; body: StudyLayoutPresetWriteRequest }) =>
        updateStudyLayoutPreset(id, body),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: deleteStudyLayoutPreset,
      onSuccess: invalidate,
    }),
  };
}
