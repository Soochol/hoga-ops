export interface DesktopState {
  serverName: string;
  origin: string;
  apiOrigin: string;
  zoomFactor: number;
}
export interface DesktopControls {
  getState(): Promise<DesktopState>;
  selectServer(): Promise<void>;
  newWindow(): Promise<void>;
  openFloating?(url: string, width: number, height: number): Promise<void>;
  closeFloating?(token: string): Promise<void>;
  onFloatingClosed?(callback: (token: string) => void): () => void;
  floatingState?(): Promise<{ maximized: boolean; alwaysOnTop: boolean }>;
  toggleFloatingMaximize?(): Promise<boolean>;
  setFloatingAlwaysOnTop?(enabled: boolean): Promise<void>;
  focusFloating?(): Promise<void>;
  zoom(command: 'in' | 'out' | 'reset'): Promise<number>;
  onZoomChange(callback: (factor: number) => void): () => void;
}
declare global {
  interface Window {
    /** Narrow app controls from the sandboxed preload; no arbitrary IPC or URLs. */
    hogaDesktop?: Readonly<{ floatingToolWindow?: boolean; strictConfig: true; apiOrigin: string; controls?: DesktopControls }>;
  }
}
