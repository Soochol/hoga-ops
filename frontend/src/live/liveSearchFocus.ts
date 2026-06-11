type Listener = () => void;
const listeners = new Set<Listener>();

/** LiveSymbolSearch가 mount 시 자신의 input focus 함수를 등록한다. */
export function onFocusLiveSearch(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** ＋ 버튼·키보드가 헤더 검색에 포커스를 요청한다. */
export function focusLiveSearch(): void {
  listeners.forEach((fn) => fn());
}
