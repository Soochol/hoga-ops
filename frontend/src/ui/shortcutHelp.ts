/** 단축키 도움말 열기 채널 — liveSearchFocus 와 같은 모듈 pub/sub.
 *  호스트(ShortcutHelpHost)가 mount 시 자신을 등록하고, 진입점(툴바 버튼 등)은
 *  openShortcutHelp() 만 부른다 — 열림 상태를 스토어로 승격하지 않는 최소 배선. */
type Listener = () => void;
const listeners = new Set<Listener>();

export function onOpenShortcutHelp(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function openShortcutHelp(): void {
  listeners.forEach((fn) => fn());
}
