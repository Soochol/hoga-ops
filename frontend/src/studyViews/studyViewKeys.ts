/** 저장뷰 목록 의 쿼리 키 — 소비처가 **둘**이라 단일 출처로 둔다: ① 이 창의 저장
 *  mutation ② 다른 창·다른 브라우저의 변경이 WS 로 도착했을 때(api/eventStream).
 *
 *  **api 모듈이 아니라 여기(키 전용 모듈)에 두는 이유**: `api/studyViews` 는 테스트가
 *  통째로 `vi.mock` 하는 모듈이다. 거기에 상수를 얹으면 mock 객체에 그 export 가
 *  없어 소비 컴포넌트가 렌더 중 죽는다(실측 3개 파일 37건). 키는 mock 대상이
 *  아니어야 한다 — watchlistKeys·heatmapKeys 와 같은 자리다. */
export const STUDY_VIEW_SAVES_QUERY = ['study-view-saves'] as const;
