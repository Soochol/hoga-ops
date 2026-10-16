/**
 * 링크 그룹 뱃지 + 번호 팔레트 — 창 타이틀바 좌상단의 숫자.
 *
 * `/live`(그룹→종목, #711)와 `/study`(그룹→저장뷰, ADR-0155)가 **같은 것을 그린다**.
 * 번호가 가리키는 대상만 다를 뿐 "숫자를 눌러 바꾼다" 는 제스처는 같아야 두 페이지의
 * 근육 기억이 하나다. 그래서 마크업을 여기 한 벌만 둔다 — 복제하면 `w-max` 같은
 * 함정(아래)이 한쪽에서만 고쳐진다.
 *
 * 팝오버 계약: 트리거(뱃지)와 본체를 **한 앵커로 감싼다**. 외부 클릭·Escape 로 닫는
 * 것은 `useDismissablePopover` 가 맡고(DESIGN 팝오버 계약 — hand-rolled useEffect
 * 금지), 앵커 **내부** 클릭은 무시되므로 그룹 선택·토글이 dismiss 와 경합하지 않는다.
 */
import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { GROUP_IDS, type GroupId } from './groupId';
import { useAnchoredPopover } from '../util/useAnchoredPopover';

export interface GroupBadgeProps {
  group: GroupId;
  open: boolean;
  /** 뱃지 클릭 = 팔레트 토글. dismiss(외부 클릭·Escape)도 같은 콜백으로 온다. */
  onToggle: () => void;
  onPick: (group: GroupId) => void;
  /** 뱃지 호버 툴팁. 페이지마다 번호가 가리키는 것이 달라 문구를 열어 둔다. */
  title?: string;
  descriptions?: Readonly<Record<number, string>>;
}

export function GroupBadge({ group, open, onToggle, onPick, title = '링크 그룹 변경', descriptions }: GroupBadgeProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const { ref, style } = useAnchoredPopover(open, anchorRef, onToggle, descriptions ? 184 : 124);

  return (
    <div ref={anchorRef} className="relative shrink-0">
      <button
        type="button"
        aria-label={`링크 그룹 ${group} 변경`}
        aria-expanded={open}
        className="inline-flex h-5 w-7 items-center justify-center rounded-sm bg-tint-selection px-1.5 font-data text-sm font-semibold text-accent hover:brightness-125"
        // 타이틀바는 창 이동 드래그 핸들이다 — 뱃지에서 시작한 포인터가 창을 끌지
        // 않도록 여기서 끊는다.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onToggle}
        title={title}
      >
        {group}
      </button>
      {open && createPortal(
        <div
          ref={ref}
          style={style}
          role="dialog"
          aria-label="연결 그룹 선택"
          // w-max 필수: 앵커(16px 뱃지)가 containing block 이라 shrink-to-fit 이
          // 팔레트를 16px 로 눌러 grid-cols-5 의 minmax(0,1fr) 열이 0 폭으로
          // 붕괴하고 20px 버튼 5개가 겹친다(행마다 마지막 숫자만 보임).
          className="ui-popover w-max p-1"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {descriptions && <div className="px-1 pb-1 text-xs text-fg-dim">그룹 {group} · {descriptions[group]}</div>}
          <div className="grid w-max grid-cols-5 gap-0.5">
          {GROUP_IDS.map((g) => (
            <button
              key={g}
              type="button"
              aria-pressed={g === group}
              title={descriptions ? `그룹 ${g} · ${descriptions[g]}` : `그룹 ${g}`}
              className={`h-[20px] w-[20px] rounded-sm font-data text-2xs font-semibold ${
                g === group
                  ? 'bg-accent text-accent-fg'
                  : 'bg-bg-input text-fg-dim hover:bg-tint-selection hover:text-accent'
              }`}
              onClick={() => { onPick(g); anchorRef.current?.querySelector('button')?.focus(); }}
            >
              {g}
            </button>
          ))}
          </div>
        </div>, document.body,
      )}
    </div>
  );
}
