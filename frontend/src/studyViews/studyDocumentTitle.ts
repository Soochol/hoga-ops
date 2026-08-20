import type { WorkspaceNavLabel } from '../nav/items';

/**
 * 활성 저장뷰가 없을 때의 `/study` 탭 제목.
 *
 * 값은 nav 라벨과 **같아야 한다** — 뷰를 고르기 전의 `/study` 는 사용자에게 여전히
 * 「복기」 페이지이고, 그 라벨은 `nav/items.ts` 가 단일 출처다. 리터럴 타입으로 받아
 * 두면 거기서 라벨을 고쳤는데 여기가 남는 드리프트가 **타입 에러**가 된다(그 파일의
 * `as const satisfies` 가 `label` 을 리터럴로 유지하는 값어치가 여기서 회수된다).
 */
const NO_VIEW_TITLE: WorkspaceNavLabel<'/study'> = '복기';

/** 제목이 읽는 세 필드 — `StudyViewListRow` 와 `StudyActiveView` 의 공통 부분이다. */
export type StudyTitleSource = { label: string; code: string; name: string };

/**
 * `/study` 탭 제목: **종목명 + 저장뷰 이름**(예: `삼성중공업 abcd`).
 *
 * 두 인자는 **소스 단위로** 고른다(필드별 섞기 금지) — 서버에서 온 저장뷰가 우선이고,
 * 없으면 영속된 활성 뷰 스토어가 받는다. 이름 변경(드로어 rename)이 제목에 곧바로
 * 반영되는 것은 앞쪽 소스 덕분이다: 스토어의 `name` 은 `openSave` 때만 갱신돼 rename
 * 뒤 stale 이다.
 *
 * `label`(저장 당시 종목명)이 비면 코드로 떨어지고, 둘 다 비면 뷰가 없는 것과 같게
 * 다룬다 — 제목이 빈 뷰 이름 하나만 남으면 어느 종목인지 못 읽는다.
 */
export function studyDocumentTitle(
  save: StudyTitleSource | null | undefined,
  active: StudyTitleSource | null | undefined,
): string {
  const source = save ?? active;
  if (!source) return NO_VIEW_TITLE;
  const symbol = source.label.trim() || source.code.trim();
  if (!symbol) return NO_VIEW_TITLE;
  const name = source.name.trim();
  return name ? `${symbol} ${name}` : symbol;
}
