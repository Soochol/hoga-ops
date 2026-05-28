import { useEffect, useRef, useState } from 'react';
import { MA_PALETTE } from '../../state/livePage';

// Single-source MA_PALETTE은 state/livePage에 산다 (nextSlotColor가 사용).
// Tests/colocated UI는 이곳에서 re-export 받아 쓸 수 있다.
export { MA_PALETTE };

type Props = {
  value: string;
  onChange: (next: string) => void;
};

export default function ColorSwatchButton({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        aria-label="MA 색상 선택"
        onClick={() => setOpen((o) => !o)}
        style={{ backgroundColor: value }}
        className="w-5 h-5 rounded-[2px] border border-border"
      />
      {open && (
        <div
          role="dialog"
          aria-label="MA 색상 팔레트"
          className="absolute top-7 left-0 grid grid-cols-4 gap-1 p-1.5 bg-bg-card border border-border-strong rounded shadow-lg z-50"
        >
          {MA_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`MA 색상 후보 ${c}`}
              aria-pressed={c.toLowerCase() === value.toLowerCase()}
              onClick={() => { onChange(c); setOpen(false); }}
              style={{ backgroundColor: c }}
              className="w-5 h-5 rounded-[2px] border border-border hover:scale-110 transition-transform"
            />
          ))}
        </div>
      )}
    </div>
  );
}
