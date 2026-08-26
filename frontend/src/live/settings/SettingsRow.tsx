import type { ButtonHTMLAttributes, ReactNode } from 'react';

/** 검색어와 겹치는 라벨 구간을 표시한다 — 지표 패널 검색과 같은 문법(tint 배경 +
 *  굵기, 액센트 잉크 금지). **표시용으로만** 쓸 것: `aria-label` 은 문자열이어야
 *  하므로 원본 라벨을 따로 넘겨야 한다(`ToggleRow` 가 그 분리를 진다). */
export function highlightLabel(label: string, query?: string): ReactNode {
  if (query === undefined || query === '') return label;
  const at = label.indexOf(query);
  if (at < 0) return label;
  return (
    <>
      {label.slice(0, at)}
      <mark className="rounded-sm bg-tint-selection font-semibold text-fg">
        {label.slice(at, at + query.length)}
      </mark>
      {label.slice(at + query.length)}
    </>
  );
}

export function SettingsRow({
  label,
  description,
  disabled = false,
  className = '',
  children,
  testId,
}: {
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`flex items-start justify-between gap-4 border-b border-border py-2 last:border-b-0 ${disabled ? 'opacity-50' : ''} ${className}`.trim()}
    >
      <div className="min-w-0 flex-1">
        <div className="text-fg text-sm">{label}</div>
        {description !== undefined && (
          <div className="text-fg-dim text-xs mt-0.5">{description}</div>
        )}
      </div>
      {children}
    </div>
  );
}

/** 스위치 치수 두 벌.
 *
 *  `sm` 은 설정 **행**이 아니라 표의 **셀** 안에 들어가는 크기다 — 최대벽 매트릭스는
 *  한 셀에 스위치·색·개수를 함께 담으므로 `md` 로는 행 높이가 두 배가 된다.
 *  트랙 폭 − 노브 폭 − 여백 2 = 이동 거리라, 세 값이 함께 움직여야 한다. */
const SWITCH_SIZE = {
  md: { track: 'h-5 w-9', knob: 'h-4 w-4', on: 'translate-x-[18px]', off: 'translate-x-[2px]' },
  sm: { track: 'h-[15px] w-[26px]', knob: 'h-[11px] w-[11px]', on: 'translate-x-[13px]', off: 'translate-x-[2px]' },
} as const;

export function ToggleSwitch({
  label,
  checked,
  size = 'md',
  className = '',
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'aria-checked'> & {
  label: string;
  checked: boolean;
  size?: keyof typeof SWITCH_SIZE;
}) {
  const dim = SWITCH_SIZE[size];
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      {...props}
      className={`relative inline-flex ${dim.track} shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 ${
        checked ? 'border-accent bg-accent' : 'border-border bg-bg-input-hover'
      } ${className}`.trim()}
    >
      <span
        className={`inline-block ${dim.knob} transform rounded-full transition-transform ${
          checked ? `bg-accent-fg ${dim.on}` : `bg-fg-dim ${dim.off}`
        }`}
      />
    </button>
  );
}
