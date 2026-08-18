import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createStudyLayoutPreset,
  deleteStudyLayoutPreset,
  listStudyLayoutPresets,
  updateStudyLayoutPreset,
  type StudyLayoutPresetWriteRequest,
} from '../../api/studyLayoutPresets';
import { STUDY_LAYOUT_PRESETS_QUERY } from './studyLayoutPresetKeys';

export { STUDY_LAYOUT_PRESETS_QUERY };

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
