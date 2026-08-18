/**
 * `/live` 공장 기본 배치 — 상수와 시드를 한 곳에 (ADR-0122).
 *
 * `workspace.ts`(하이드레이션·스토어)와 `workspaceMigration.ts`(레거시 1회 시드)가
 * **둘 다** 이 값을 쓴다. 종전엔 두 파일이 각자 배치를 만들었고 좌표계까지 갈렸다 —
 * 전자는 비율 여백, 후자는 **px 여백**. 후자가 만든 px 는 `schema_version: 2`(비율)로
 * 저장돼 다음 로드에서 `isFracRect` 에 전량 탈락했다(경위는 `buildWorkspaceSeed` 주석).
 *
 * **`workspace.ts` 에 두면 순환이다** — 그쪽이 migration 을 값으로 import 한다
 * (`readLegacyWorkspaceSeed`). 지금 상수 정의가 `hydrated = readStorage()` 보다 위에
 * 있어 우연히 동작하겠지만, 순서가 바뀌는 순간 TDZ ReferenceError 다. 제3 모듈이 그
 * 취약성을 없앤다. (`WorkspaceWindow` 는 `import type` 이라 런타임 순환이 아니다.)
 *
 * 첫 로드 기본 레이아웃의 px 근거: 1546×776 캔버스 기준 차트 720×760 / book 680×560 /
 * broker 680×188 을 그 캔버스로 나눈 값이라 어느 화면 크기에서도 같은 배치로 열린다.
 *
 * **단, 우측 열은 REF 유래 비율을 쓰지 않는다.** REF 캔버스(1546)는 실제 캔버스보다
 * 넓어서(좁은 쪽 실측 `NARROW_CANVAS_W`) 그 비율이 `BookPanel` 의 절대 계약을 못 채운다 —
 * 가로 스크롤이 생기고 우측 요약 열이 잘린다("시작 58,000" 이 "시작 58" 로 보인다).
 * 비율 좌표계는 절대 하한을 표현하지 못하므로(ADR-0122), 하한이 있는 창의 비율은
 * **REF 가 아니라 좁은 쪽 실측에서 역산**해야 한다.
 *
 * ## 유도 방향이 2026-08-16 에 뒤집혔다
 *
 * 종전에는 하한(560)이 커서 우측 열이 남는 여백을 **먹는** 쪽이었다(차트 고정,
 * 우측 0.5058 = 1226 에서 620px). `BOOK_PANEL_MIN_W` 가 448 로 내려오면서 방향이
 * 반대가 됐다: 우측 열을 계약 + 여유까지만 잡고 **남는 폭을 전부 차트에 넘긴다**.
 * 차트 0.4657 → 0.5715 (1226 캔버스에서 571 → 701px). 아래 여백 절이 좌우 여백까지
 * 차트에 넘겨 0.5715 → 0.6 (736px).
 *
 * ## 여백은 이 좌표계에 담지 않는다 (2026-08-17)
 *
 * 종전엔 창 rect 가 사방 여백을 직접 들고 있었다(`DEFAULT_EDGE_MARGIN` 0.0104 ·
 * y 0.0206 · 차트↔우측 열 `DEFAULT_COL_GAP` 0.0077). 문제는 값이 아니라 **여백을
 * 비율로 표현했다는 것**이다 — 비율 좌표는 캔버스에 비례해 자라므로 고정 px 인 페이지
 * 패딩과 달리 화면이 넓어지면 여백도 커진다(실측: 창 왼쪽 여백이 1440 뷰포트 14px,
 * 2560 뷰포트 26px). 페이지 패딩과 합산되면서 같은 워크스페이스인 `/study` 와의
 * 창 왼쪽 간격 차이가 10px → 22px 로 벌어졌다.
 *
 * 이제 여백 소유권은 페이지 패딩(`WORKSPACE_PAGE_PAD`) **한 곳**이고, 창 rect 는
 * `/study` 시드(`buildStudyWorkspaceSeed`)와 같이 캔버스를 꽉 채운다(0~1 전폭).
 * 인접 창 사이 시각 간격은 `WindowFrameCore` 의 GAP(2px — 좌표는 그대로 두고 카드만
 * 물러난다)이 담당하므로 좌표에 틈을 낼 이유가 없다.
 */
import type { WorkspaceWindow } from './workspace';

/**
 * 우측 열 폭. 좁은 쪽 실측 캔버스(`NARROW_CANVAS_W` = 1208px)에서
 * `BOOK_WINDOW_DEFAULT_W`(487) 를 넘겨야 한다 — 0.41 × 1208 = 495px 로 여유 8px 이다.
 * 이 곱이 487 아래로 내려가면 10호가 창이 첫 로드부터 가로 스크롤된다
 * (`workspace.test.ts` 가 못박는다).
 *
 * **2026-08-18 에 0.40 → 0.41 로 올렸다.** BookPanel 중앙 가격 열이 +10% 되며 패널
 * 하한이 448→455, 창 기본 폭이 480→487 로 따라 올랐는데, 종전 0.40 은 483px 로
 * **여유가 3px 뿐**이라 그 상승분을 못 받았다(그 3px 조차 종전 주석이 1226 기준 10px
 * 라고 잘못 적고 있던 것을 2026-08-17 에 바로잡은 값이다 — 1226 은 시세 스트립·상태바가
 * 있던 시절 실측이라 이미 실제보다 넓었다). 대가는 차트 창이 1208 캔버스에서
 * 725→713px 로 12px 좁아지는 것이다.
 *
 * 하한이 또 움직이면 고칠 곳은 이 한 줄이다 — 아래 두 상수가 여기서 유도된다.
 */
export const LIVE_RIGHT_COL_W = 0.41;
/** 우측 열 시작 = 차트 오른쪽 끝. 둘 사이에 좌표 틈이 없다(위 "여백" 절). */
export const LIVE_RIGHT_COL_X = 1 - LIVE_RIGHT_COL_W;
/**
 * 우측 열 세로 분할 — book 은 십자 배치라 3배 높이 가중을 받는다(`/study` 시드의
 * `SEED_BOOK_HEIGHT_WEIGHT` 와 같은 정책). 3:1 → 0.75/0.25.
 */
export const LIVE_BOOK_H = 0.75;

/**
 * 공장 기본 창 3개(차트 + 10호가 + 거래원). `makeId` 를 주입받는 이유는 순환 회피다 —
 * id 생성기는 `workspace.ts` 소유고 이 모듈은 배치만 안다.
 */
export function liveDefaultWindows(makeId: () => string): WorkspaceWindow[] {
  return [
    {
      id: makeId(),
      kind: 'chart',
      group: 1,
      rect: { x: 0, y: 0, w: LIVE_RIGHT_COL_X, h: 1 },
      chart: { timeframe: '1m' },
    },
    // book 은 십자 배치(BookPanel)라 좁으면 못 담는다 — 차트 오른쪽 열의 위쪽.
    {
      id: makeId(),
      kind: 'book',
      group: 1,
      rect: { x: LIVE_RIGHT_COL_X, y: 0, w: LIVE_RIGHT_COL_W, h: LIVE_BOOK_H },
    },
    {
      id: makeId(),
      kind: 'broker',
      group: 1,
      rect: {
        x: LIVE_RIGHT_COL_X,
        y: LIVE_BOOK_H,
        w: LIVE_RIGHT_COL_W,
        h: 1 - LIVE_BOOK_H,
      },
    },
  ];
}
