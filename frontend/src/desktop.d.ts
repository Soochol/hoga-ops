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
  zoom(command: 'in' | 'out' | 'reset'): Promise<number>;
  onZoomChange(callback: (factor: number) => void): () => void;
}
declare global {
  interface Window {
    /** Narrow app controls from the sandboxed preload; no arbitrary IPC or URLs. */
    hogaDesktop?: Readonly<{ strictConfig: true; apiOrigin: string; controls?: DesktopControls }>;
  }
}
