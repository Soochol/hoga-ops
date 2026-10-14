import type { StudyViewGroup } from '../api/studyViews';


export type StudyGroupChoice = { group_id?: string; new_group_name?: string };


export function validStudyGroupChoice(groups: StudyViewGroup[], value: StudyGroupChoice): boolean {
  if (value.new_group_name !== undefined) return !!value.new_group_name.trim() && !groups.some((g) => g.name.toLocaleLowerCase() === value.new_group_name!.trim().toLocaleLowerCase());
  return groups.some((g) => g.id === value.group_id);
}
