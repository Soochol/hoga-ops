import { createContext, useContext } from 'react';
import type { SettingsUndoRecorder } from './useSettingsUndo';

export const SettingsUndoContext = createContext<SettingsUndoRecorder | null>(null);
const ignore: SettingsUndoRecorder = () => {};
/** Server-backed controls register their inverse only after a successful save. */
export const useRecordSettingsUndo = () => useContext(SettingsUndoContext) ?? ignore;
