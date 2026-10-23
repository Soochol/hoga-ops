import { create } from 'zustand';
import type { BookDiagnostics } from '../live/orderbookAvailability';

export const useServiceStatusPanel = create<{
  open: boolean;
  operation: string | null;
  book: BookDiagnostics | null;
  show: (operation?: string) => void;
  showBook: (book: BookDiagnostics) => void;
  close: () => void;
}>((set) => ({
  open: false, operation: null, book: null,
  show: (operation) => set({ open: true, operation: operation ?? null, book: null }),
  showBook: (book) => set({ open: true, operation: null, book }),
  close: () => set({ open: false, operation: null, book: null }),
}));
