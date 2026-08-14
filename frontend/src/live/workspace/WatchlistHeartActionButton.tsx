/**
 * 「관심」 하트 — 차트 창 헤더 액션 행 소유(그리기 왼쪽).
 *
 * 대상은 **이 창이 보고 있는 종목**이다 — CollectButton 이 전역 활성 그룹에서
 * 창 로컬로 내려온 것과 같은 이유로, 창마다 독립적으로 자명하다.
 *
 * **라벨을 달지 않는다(아이콘 전용).** 이웃 넷(그리기·보조지표·저장·수집)은 전부
 * 동사라 라벨이 정보를 나르지만, 하트는 동작이 아니라 **상태**이고 그 상태는
 * 채움/빔이 나른다 — "관심" 이라는 라벨은 등록 여부를 말해 주지 않는다. 스크리너
 * 행·심볼 검색의 하트도 아이콘 전용이라 글리프는 이미 학습돼 있다.
 * 실측 근거도 같은 방향이다(2026-08-14, `/browse` #905 복제 절차, 1.0×):
 * 라벨을 달면 헤더 요구폭이 +52px 라 1단계 접힘 임계가 384→~436 이 되어 **창 폭
 * 384~436px 구간에서 기존 네 라벨이 전부 같이 접힌다**. 아이콘 전용은 +22px 다.
 *
 * `compact` 는 라벨 접힘이 아니라 **패딩만** 따라간다 — 라벨이 애초에 없으므로
 * 접을 것이 없고, 이웃이 좁아질 때 혼자 넓은 패딩을 유지하면 클릭 타겟이 어긋난다.
 *
 * 지수 창은 숨기지 않고 `disabled` 로 둔다(CollectButton 과 같은 규칙) — 행
 * 레이아웃이 창마다 흔들리지 않고, 접힘 임계도 종목 유무에 따라 달라지지 않는다.
 */
import { useState } from 'react';
import { IconToolbarButton } from '../../ui/WorkspaceShell';
import { HeartIcon } from '../../ui/HeartIcon';
import { WatchlistGroupPicker } from '../../watchlist/WatchlistGroupPicker';
import { COMPACT_PADDING_INLINE } from './chartHeaderCompact';

export function WatchlistHeartActionButton({
  code,
  name,
  isMember,
  compact = false,
}: {
  /** 이 창의 종목 코드. 지수이거나 종목 미선택이면 null → 비활성. */
  code: string | null;
  name: string | null;
  /** ≥1 그룹 소속 여부. 창이 `useWatchlistMembership()` 을 한 번 불러 내린다
   *  (그 훅의 "컴포넌트당 한 번" 계약 — 이 버튼이 직접 부르지 않는다). */
  isMember: boolean;
  /** 헤더 1단계 접힘. 이웃 버튼이 아이콘만 남을 때 패딩을 같이 좁힌다. */
  compact?: boolean;
}) {
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);

  return (
    <>
      <IconToolbarButton
        data-testid="live-watchlist-heart-button"
        disabled={code == null}
        aria-label="관심 그룹 편집"
        aria-pressed={isMember}
        title={code == null ? '관심 그룹 편집 — 지수는 지원하지 않습니다' : '관심 그룹 편집'}
        onClick={(e) => {
          if (code == null) return;
          const r = e.currentTarget.getBoundingClientRect();
          setPicker({ x: r.left, y: r.bottom + 4 });
        }}
        style={compact ? { paddingInline: COMPACT_PADDING_INLINE } : undefined}
        icon={(
          // 색은 **아이콘에** 건다. 버튼 클래스(`text-fg-dim`)를 뒤 클래스로 덮으려
          // 하면 Tailwind 유틸 충돌은 문자열 순서가 아니라 CSS 순서로 갈려 조용히
          // 죽는다. 자식이 자기 color 를 가지면 상속을 확실히 이기고, 미등록일 때는
          // 클래스가 없어 부모의 hover:text-fg 를 그대로 상속받는다.
          <HeartIcon filled={isMember} className={`h-3 w-3${isMember ? ' text-fg' : ''}`} />
        )}
      />
      {picker && code != null && (
        <WatchlistGroupPicker
          code={code}
          name={name ?? undefined}
          x={picker.x}
          y={picker.y}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  );
}
