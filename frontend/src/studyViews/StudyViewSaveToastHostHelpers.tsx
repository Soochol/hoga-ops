import { create } from 'zustand';


export type Notice = { id: string; groupId: string; label: string; retryCapture?: () => void };

export const useStudySaveNotice = create<{ notice: Notice | null }>(() => ({ notice: null }));
