type Width = 1 | 2 | 3 | 4;

type Props = {
  value: Width;
  onChange: (next: Width) => void;
};

export default function LineWidthSelect({ value, onChange }: Props) {
  return (
    <select
      role="combobox"
      aria-label="MA 선 굵기"
      value={String(value)}
      onChange={(e) => onChange(Number(e.target.value) as Width)}
      className="text-sm bg-bg-input border border-border rounded-[4px] px-2 py-1"
    >
      {[1, 2, 3, 4].map((w) => (
        <option key={w} value={String(w)}>{`${w}px`}</option>
      ))}
    </select>
  );
}
