/** 페이지 중립 워크스페이스 코어 — z순서 정규화.
 *
 * `/live`(`state/workspace.ts`)와 `/study`(`state/studyWorkspace.ts`)가 **문자 단위로
 * 같은 함수**를 각자 들고 있었다. 차이는 시그니처의 창 타입 이름 하나뿐이었고 본문
 * 16줄은 완전히 동일했다 — 본문이 쓰는 것은 `w.id` 하나라 타입이 갈릴 이유가 없다.
 *
 * 두 스토어가 "서로의 미러여야 한다" 는 것은 `studyWorkspace.ts` 의 주석이 선언하지만
 * 그것을 지키는 장치는 산문뿐이다. 같은 축이 이미 한 번 절단돼 있다 —
 * `workspace/WorkspaceCanvas.tsx` 가 페이지 중립 코어이고 adapter 가 둘이다. 이 파일은
 * 그 배치를 스토어 축의 한 조각에 적용한 것이다.
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
