import { create } from 'zustand';
import type { SignalAlertEvent } from '../api/signalAlerts';

type Store = {
  unreadCount: number;
  lastSeenAtMs: number;
  noteIncoming: (event: SignalAlertEvent) => void;
  markPanelSeen: () => void;
  resetForClear: (date: string) => void;
};

export const useSignalAlertInboxStore = create<Store>((set) => ({
  unreadCount: 0,
  lastSeenAtMs: 0,
  noteIncoming: (_event) => set((state) => ({ unreadCount: state.unreadCount + 1 })),
  markPanelSeen: () => set({ unreadCount: 0, lastSeenAtMs: Date.now() }),
  resetForClear: (_date) => set({ unreadCount: 0, lastSeenAtMs: Date.now() }),
}));
