/** `/study` 레이아웃 프리셋 목록 의 쿼리 키 — 소비처가 **둘**이라 단일 출처로 둔다: ① 이 창의 프리셋
 *  mutation(useStudyLayoutPresets) ② 다른 창·다른 브라우저의 변경이 WS 로 도착했을 때
 *  (api/eventStream).
 *
 *  **훅 파일이 아니라 키 전용 모듈에 두는 이유**: `useStudyLayoutPresets` 은 테스트가 통째로
 *  `vi.mock` 하는 모듈이다(StudyLayoutPresetMenu.test · StudyPage.test). 거기서 상수를 가져오면 mock 객체에 그
 *  export 가 없어 소비 측이 렌더 중 죽는다 — 같은 실수를 스크리너·저장뷰에서
 *  이미 한 번 했다(실측 3파일 37건). 키는 mock 대상이 아니어야 한다. */
export const STUDY_LAYOUT_PRESETS_QUERY = ['study-layout-presets'] as const;
