import { create } from 'zustand';
export const useStudyViewReveal = create<{ target: { id: string; groupId: string } | null }>(() => ({ target: null }));
