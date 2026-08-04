import type { ReactNode } from 'react';

/**
 * 워크스페이스 창의 빈/미지원 상태 카드 — `/live` 의 차트 창과 데이터 창이 공유한다.
 *
 * **왜 공유 컴포넌트인가:** 두 파일이 각자 인라인 div 를 들고 있었고 이미 드리프트가
 * 있었다 — 차트 창은 `종목 없음 · 그룹 1`, 데이터 창은 `10호가 · 종목 없음 (그룹 1)`
 * 로 괄호 유무까지 달랐다. 빈 상태는 사용자가 "고장인가?" 를 판정하는 자리라 표현이
 * 갈리면 안 된다.
 *
 * **왜 전면 오버레이가 아닌가:** 창은 자유 배치라 각자 독립적으로 자기 상태를 말해야
 * 한다(`tests/e2e/live-smoke.spec.ts` 가 이 계약을 고정한다 — "전면 안내 없음, 창마다
 * 표시"). 그래서 바뀐 것은 배치가 아니라 **내용**이다: 상태만 알리던 자리에 다음
 * 행동(`hint`)을 붙였다. 종목 496개가 실시간으로 흐르는데 화면이 비어 있으면 사용자는
 * 정상 연결과 고장을 구분할 수 없다.
 *
 * `ui/DataSurface` 의 `EmptyState` 를 쓰지 않는 이유: 그쪽은 `p-lg` + `text-base` 라
 * 페이지 카드용이고, 워크스페이스 창은 사용자가 임의로 작게 줄일 수 있어 한 단계 낮은
 * 타이포가 필요하다(그래도 `--fg-dim` 이라 AA 는 통과한다).
 */
export function WindowEmptyState({ title, hint, testId }: {
  /** 무엇이 비었는지 — `10호가 · 종목 없음` 처럼 창 종류를 앞세운다. */
  title: ReactNode;
  /** 다음 행동 또는 사유. 생략하면 상태만 알린다(사용자가 할 수 있는 일이 없을 때). */
  hint?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex h-full w-full flex-col items-center justify-center gap-1 bg-bg-subtle/40 px-3 py-2 text-center"
    >
      <div className="font-data text-xs font-medium text-fg">{title}</div>
      {hint !== undefined && (
        <div className="max-w-[28rem] text-[11px] leading-snug text-fg-dim">{hint}</div>
      )}
    </div>
  );
}

/** 그룹에 종목이 없을 때의 공통 안내. 종목은 **포커스 창의 그룹**에 배정되므로
 *  (`activeGroupOf`, #711) "이 그룹" 이라고 부를 수 있다 — 창을 클릭해 포커스를 준 뒤
 *  고르면 그 그룹이 채워진다. 진입로 셋 중 검색과 목록만 문장에 담는다(드래그는
 *  발견 후 쓰는 단축 경로라 첫 안내에 넣으면 문장이 길어진다). */
export const PICK_SYMBOL_HINT = '검색(/) 이나 우측 목록에서 종목을 고르면 이 그룹의 창이 함께 채워집니다';

/** 데이터 창용 축약판 — 그룹 번호를 받아 "무엇을 하면 채워지는지" 만 남긴다. */
export function groupPendingHint(group: number): string {
  return `그룹 ${group} 에 종목을 지정하면 표시됩니다`;
}
