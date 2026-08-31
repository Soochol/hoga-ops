import type { ReactNode } from 'react';

/**
 * 아직 추가하지 않은 지표의 상세 — **설정 폼이 아니라 미리보기**다.
 *
 * 종전엔 카탈로그에서 라벨을 누르면 존재하지 않는 지표의 *편집 가능한* 설정 폼이
 * 그대로 떴다. 어휘는 "미리보기" 인데 화면은 편집기라, 지금 저 스위치를 만지면
 * 무슨 일이 나는지가 불분명했다(실제로는 아무 일도 안 나거나, 방향 토글처럼
 * 일부는 실제로 상태를 바꿨다).
 *
 * 지금은 두 상태가 화면으로 갈린다: 없으면 미리보기 + 추가, 있으면 설정.
 * 그리고 **추가하면 이 자리가 그대로 설정 폼이 된다** — 선택은 움직이지 않는다.
 *
 * 무엇을 말하는가는 이 카드 밖이 이미 절반을 답한다. 헤더가 그룹·그릴 위치·이름을,
 * 그 아래 한 줄이 설명을 말하므로, 카드에 남는 것은 **"아직 없다" 와 넣는 방법**뿐이다.
 * (승인된 목업에는 위치 스키마 그림과 기본값 표도 있었으나 이번 판에서는 보류한다 —
 * 지표마다 손으로 그린 그림 15장이 필요해지고, 그 그림은 설정이 바뀌면 낡는다.)
 */
export default function IndicatorPreviewCard({
  glyph,
  placementLabel,
  onAdd,
}: {
  /** 목록 행과 **같은 글리프** — 방금 고른 행이 이 화면이라는 연결이 그림으로 선다. */
  glyph: ReactNode;
  /** '캔들 오버레이' / '하단 패널' — 헤더 eyebrow 와 같은 값. */
  placementLabel: string;
  onAdd: () => void;
}) {
  return (
    <div data-testid="indicator-preview-card">
      <p className="flex items-center gap-2.5 rounded-lg bg-bg-subtle px-4 py-3 text-xs text-fg-dim">
        <span className="flex size-4 shrink-0 items-center justify-center text-fg-dim">{glyph}</span>
        <span>
          아직 이 차트에 추가하지 않은 지표입니다. 추가하면{' '}
          <b className="font-medium text-fg">{placementLabel}</b>에 그려집니다.
        </span>
      </p>
      <div className="mt-4 flex items-center gap-3">
        {/* 미리보기 상태의 액센트는 이 버튼 **하나**다 — 여기서 할 수 있는 일이
            하나뿐이므로 고를 것이 없다. */}
        <button
          type="button"
          onClick={onAdd}
          className="shrink-0 rounded-lg bg-accent px-4 py-2 text-base font-semibold text-accent-fg transition-[filter] hover:brightness-110"
        >
          ＋ 차트에 추가
        </button>
        <span className="text-xs text-fg-dim">
          추가하면 차트에 바로 그려지고, 세부 설정이 이 자리에서 이어집니다.
        </span>
      </div>
    </div>
  );
}
