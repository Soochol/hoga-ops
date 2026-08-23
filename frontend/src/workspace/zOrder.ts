/** 워크스페이스 z순서 정규화.
 *
 * 원래는 `/live`·`/study` 두 스토어가 **문자 단위로 같은 함수**를 각자 들고 있어서
 * 중복을 걷으려고 뽑았다(차이는 시그니처의 창 타입 이름 하나뿐, 본문 16줄 동일 —
 * 본문이 쓰는 것은 `w.id` 하나라 타입이 갈릴 이유가 없었다).
 *
 * `/study` 폐지(ADR-0157) 후 소비처는 `state/workspace.ts` 하나다. 그래도 **여기
 * 그대로 둔다** — 제네릭 16줄 순수 함수라 옮겨서 얻는 것이 없고, 인라인하면 스토어
 * 파일만 길어진다. 「거주자가 하나니 걷어야 한다」가 자동으로 참인 것은 아니다.
 */

/** zOrder 를 실제 창 id 집합에 맞춰 정규화(unknown 드롭, 누락 append). */
export function normalizeZOrder<W extends { readonly id: string }>(
  raw: unknown,
  windows: readonly W[],
): string[] {
  const ids = new Set(windows.map((w) => w.id));
  const seen = new Set<string>();
  const next: string[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string' && ids.has(entry) && !seen.has(entry)) {
        seen.add(entry);
        next.push(entry);
      }
    }
  }
  for (const w of windows) {
    if (!seen.has(w.id)) next.push(w.id);
  }
  return next;
}
