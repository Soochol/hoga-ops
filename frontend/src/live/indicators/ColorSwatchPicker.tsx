import { useRef, useState } from 'react';
import { MA_COLOR_ROWS } from './MAStylePicker';
import { useDismissablePopover } from '../../util/useDismissablePopover';

type Props = {
  color: string;
  onChange: (color: string) => void;
  /** aria-label 접두어 (예: '매수 색상', '당일 최대 매물대 색상'). trigger는
   *  `${label} 선택`, 각 스와치는 `${label} ${hex}` 로 라벨링된다. */
  label: string;
  extraColors?: readonly string[];
};

/** 색상 전용 팝오버 픽커. MAStylePicker(색+두께+모양)의 색상만 떼어낸 형제로,
 *  인라인 32색 그리드를 쓰던 지표들(연속체결 매물대 분포·당일 최대 매물대·신규
 *  거래원 등장)을 MAStylePicker와 동일한 "스와치 trigger→팝오버" 패턴으로 통일한다.
 *  팔레트는 MA_COLOR_ROWS(8 hue × 4 shade) 공용 소스를 재사용. */
export default function ColorSwatchPicker({ color, onChange, label, extraColors }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const colorRows = extraColors?.length ? [extraColors, ...MA_COLOR_ROWS] : MA_COLOR_ROWS;
  useDismissablePopover(open, containerRef, () => setOpen(false));

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        aria-label={`${label} 선택`}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center rounded border border-border bg-bg-input p-1"
      >
        <span
          aria-hidden="true"
          className="inline-block h-4 w-7 rounded-sm border border-border-subtle"
          style={{ backgroundColor: color }}
        />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`${label} 팔레트`}
          className="absolute left-0 top-8 z-50 rounded p-3 shadow-lg"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-strong)', minWidth: 240 }}
        >
          <div className="flex flex-col gap-1">
            {colorRows.map((row, ri) => (
              <div key={ri} className="grid grid-cols-8 gap-1">
                {row.map((c) => {
                  const selected = c.toLowerCase() === color.toLowerCase();
                  return (
                    <button
                      key={c}
                      type="button"
                      aria-label={`${label} ${c}`}
                      aria-pressed={selected}
                      className="h-5 w-5 rounded-full"
                      style={{
                        backgroundColor: c,
                        outline: selected ? '2px solid var(--fg)' : 'none',
                        outlineOffset: 2,
                        border: '1px solid var(--border-subtle)',
                      }}
                      onClick={() => {
                        onChange(c);
                        setOpen(false);
                      }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
