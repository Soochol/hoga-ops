import { create } from 'zustand';

export const useServiceStatusPanel = create<{
  open: boolean;
  operation: string | null;
  show: (operation?: string) => void;
  close: () => void;
}>((set) => ({
  open: false, operation: null,
  show: (operation) => set({ open: true, operation: operation ?? null }),
  close: () => set({ open: false, operation: null }),
}));
