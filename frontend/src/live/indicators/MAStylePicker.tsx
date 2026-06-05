import { useRef, useState } from 'react';
import { useDismissablePopover } from '../../util/useDismissablePopover';

/** 8 hue × 4 shade. shade 인덱스 0=darkest → 3=lightest. mockup의
 *  컬러 palette layout과 1:1 일치. tokens.css의 --ma-N 8색 (단일 행)
 *  과는 별개의 확장 set — 사용자가 슬롯당 색상을 더 풍부하게 고를 수
 *  있도록 한다. tokens.css의 --ma-N 은 default 슬롯 자동 배정용으로
 *  남는다. */
export const MA_COLOR_ROWS: readonly (readonly string[])[] = [
  ['#374151', '#1E3A8A', '#581C87', '#7F1D1D', '#7C2D12', '#78350F', '#134E4A', '#14532D'],
  ['#6B7280', '#1D4ED8', '#7E22CE', '#B91C1C', '#C2410C', '#B45309', '#0F766E', '#15803D'],
  ['#9CA3AF', '#3B82F6', '#A855F7', '#EF4444', '#F97316', '#FBBF24', '#14B8A6', '#22C55E'],
  ['#D1D5DB', '#93C5FD', '#D8B4FE', '#FCA5A5', '#FDBA74', '#FDE68A', '#5EEAD4', '#86EFAC'],
];

const LINE_WIDTHS: readonly (1 | 2 | 3 | 4)[] = [1, 2, 3, 4];

type Props = {
  color: string;
  lineWidth: 1 | 2 | 3 | 4;
  onChange: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }) => void;
};

/** MA 슬롯의 color + lineWidth 를 한 popover에서 동시에 고른다.
 *  trigger는 현재 색을 보여주는 작은 swatch. 클릭하면 32색 grid +
 *  4개 굵기 카드가 같이 뜬다. ColorSwatchButton + LineWidthSelect 합본. */
export default function MAStylePicker({ color, lineWidth, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 공용 dismiss 계약(바깥 mousedown + Escape)으로 통일 — 자체 useEffect 복붙 제거.
  // 이 픽커는 IndicatorPanel(ModalShell) 안에 떠서 Escape는 모달이 먼저 먹지만,
  // 계약을 한곳(useDismissablePopover)으로 모아 document→window 리스너까지 일관화.
  useDismissablePopover(open, containerRef, () => setOpen(false));

  return (
    <div ref={containerRef} className="relative inline-block">
      {/* Trigger 자체로 color + lineWidth 가 한눈에 보이도록: 컴팩트한
         가로 셀에 (1) 색상 dot 과 (2) 현재 굵기 굵기로 그어진 짧은 가로선
         을 나란히. trigger만 봐도 line 두께를 알 수 있어 popover를 열지
         않고도 빠르게 확인 가능. */}
      <button
        type="button"
        aria-label="MA 스타일 선택"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          padding: '2px 6px',
          background: 'var(--bg-input)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          cursor: 'pointer',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: 10,
            height: 10,
            borderRadius: '50%',
            backgroundColor: color,
          }}
        />
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: 18,
            height: `${lineWidth}px`,
            backgroundColor: color,
          }}
        />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="MA 스타일 팔레트"
          className="absolute top-7 left-0 z-50 p-3 rounded shadow-lg"
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-strong)',
            minWidth: 280,
          }}
        >
          <div
            style={{
              color: 'var(--fg-dim)',
              fontSize: 'var(--text-xs)',
              marginBottom: 'var(--space-xs)',
            }}
          >
            컬러
          </div>
          <div className="flex flex-col mb-3" style={{ gap: 'var(--space-xs)' }}>
            {MA_COLOR_ROWS.map((row, ri) => (
              <div key={ri} className="grid grid-cols-8" style={{ gap: 'var(--space-xs)' }}>
                {row.map((c) => {
                  const selected = c.toLowerCase() === color.toLowerCase();
                  return (
                    <button
                      key={c}
                      type="button"
                      aria-label={`MA 색상 ${c}`}
                      aria-pressed={selected}
                      onClick={() => {
                        onChange({ color: c });
                        setOpen(false);
                      }}
                      style={{
                        backgroundColor: c,
                        width: 22,
                        height: 22,
                        borderRadius: '50%',
                        outline: selected ? '2px solid var(--fg)' : 'none',
                        outlineOffset: '2px',
                        cursor: 'pointer',
                        border: 'none',
                        padding: 0,
                      }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          <div
            style={{
              color: 'var(--fg-dim)',
              fontSize: 'var(--text-xs)',
              marginBottom: 'var(--space-xs)',
            }}
          >
            굵기
          </div>
          <div className="grid grid-cols-4" style={{ gap: 'var(--space-xs)' }}>
            {LINE_WIDTHS.map((w) => {
              const selected = w === lineWidth;
              return (
                <button
                  key={w}
                  type="button"
                  aria-label={`MA 굵기 ${w}px`}
                  aria-pressed={selected}
                  onClick={() => {
                    onChange({ lineWidth: w });
                  }}
                  style={{
                    background: 'var(--bg-input)',
                    border: selected ? '1px solid var(--fg)' : '1px solid var(--border)',
                    borderRadius: '4px',
                    padding: '10px 0 6px',
                    cursor: 'pointer',
                  }}
                >
                  {/* Line 미리보기는 현재 선택된 color 로 렌더 — 사용자가 굵기
                      카드만 봐도 실제 차트에 그려질 선 모양을 그대로 확인할 수
                      있다. tokens.css의 --fg 같은 고정색이 아니라 prop으로 받은
                      `color` 를 그대로 칠하는 게 핵심. */}
                  <div
                    style={{
                      width: '32px',
                      height: `${w}px`,
                      background: color,
                      margin: '0 auto',
                    }}
                  />
                  <div
                    style={{
                      color: 'var(--fg-dim)',
                      fontSize: 'var(--text-xs)',
                      marginTop: '6px',
                    }}
                  >
                    {w}px
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
