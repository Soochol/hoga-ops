/** 새 탭별 일회성 전달함. 공유 기본 배치는 건드리지 않고, 미수신 항목은 5분 후 만료한다. */
const PREFIX = 'live.workspace.transfer.';
const PARAM = 'workspaceTransfer';
const TTL = 5 * 60 * 1000;

export function stageWorkspaceTransfer(path: string, snapshot: unknown): string {
  try {
    const now = Date.now();
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(PREFIX)) continue;
      try {
        const entry = JSON.parse(localStorage.getItem(key)!);
        if (!(entry?.expiresAt > now)) localStorage.removeItem(key);
      } catch { localStorage.removeItem(key); }
    }
    const id = crypto.randomUUID();
    localStorage.setItem(PREFIX + id, JSON.stringify({ expiresAt: now + TTL, snapshot }));
    const url = new URL(path, window.location.origin);
    url.searchParams.set(PARAM, id);
    return url.pathname + url.search + url.hash;
  } catch {
    // 저장소 사용 불가 시 기존 새 탭 경로로 연다.
    return path;
  }
}

export function consumeWorkspaceTransfer(): Record<string, unknown> | null {
  try {
    const id = new URLSearchParams(window.location.search).get(PARAM);
    if (!id) return null;
    const key = PREFIX + id;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    localStorage.removeItem(key);
    const entry = JSON.parse(raw);
    if (!(entry?.expiresAt > Date.now()) || !Array.isArray(entry.snapshot?.windows)) return null;
    return entry.snapshot;
  } catch {
    return null;
  }
}
