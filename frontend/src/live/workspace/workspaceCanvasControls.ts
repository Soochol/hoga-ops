/**
 * WorkspaceCanvas 명령 채널 (ADR-0119 C2c-2c).
 *
 * Tidy 는 캔버스 실측 크기(boxRef)가 필요해 캔버스만 실행할 수 있는데, 트리거
 * 버튼은 캔버스 밖 고정 툴바에 있다. 캔버스가 마운트 시 자기 tidy 실행기를
 * 등록하고 툴바가 호출한다(studySaveSource 류의 모듈 레지스트리 — 캔버스는
 * 페이지당 1개라 단일 슬롯로 충분).
 */
let tidyRunner: (() => void) | null = null;

export function registerWorkspaceTidy(run: () => void): () => void {
  tidyRunner = run;
  return () => {
    if (tidyRunner === run) tidyRunner = null;
  };
}

export function requestWorkspaceTidy(): void {
  tidyRunner?.();
}
