export {};
declare global {
interface Window {
  /** Read-only context supplied by the sandboxed desktop preload. No privileged APIs. */
  hogaDesktop?: Readonly<{ strictConfig: true; apiOrigin: string }>;
}
}
