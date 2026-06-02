/** localStorage 영속 공용 커널 — 각 store 의 write try/catch 와 read-시 object 가드를
 *  한 곳에 모은다. SSR·privacy 모드에서 조용히 폴백. 필드별 검증/마이그레이션은
 *  스토어마다 다르므로 호출부가 parsed object 위에서 수행한다. */
export function persistJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage unavailable (SSR, privacy mode) — silent fallback.
  }
}

/** key 의 JSON 을 객체로 읽는다. 없음/비객체/파싱실패 → {} (호출부가 빈 객체에서
 *  필드를 검증하므로 corrupt/hand-edited 값이 state 로 새지 않는다). */
export function readJsonObject(key: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}
