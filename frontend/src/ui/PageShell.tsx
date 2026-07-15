import type {
  ButtonHTMLAttributes,
  CSSProperties,
  ElementType,
  HTMLAttributes,
  ReactNode,
} from 'react';

type PanelCardProps = {
  as?: 'div' | 'section' | 'article';
  className?: string;
  style?: CSSProperties;
  /**
   * Drop the card `--border`, leaving `--bg-card` + `--shadow-panel` to carry the
   * separation on their own — the `/live`·`/study` 부유 카드 모델(DESIGN.md). Opt-in:
   * feature-route cards keep the border (critical in Ledger, where the border is
   * the only card boundary). Used by `/heatmap` to sit on `--bg` like the live panel.
   */
  borderless?: boolean;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, 'className' | 'children' | 'style'>;

export function PanelCard({ as = 'div', className = '', style, borderless = false, children, ...props }: PanelCardProps) {
  const Tag = as as ElementType;
  const borderClass = borderless ? '' : 'border border-border';
  return (
    <Tag
      {...props}
      className={`bg-bg-card ${borderClass} rounded-lg min-w-0 shadow-panel ${className}`.replace(/\s+/g, ' ').trim()}
      style={style}
    >
      {children}
    </Tag>
  );
}

export function ControlBar({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`min-w-0 flex items-center gap-md ${className}`.trim()}>
      {children}
    </div>
  );
}

const BUTTON_TONE_CLASS = {
  // secondary는 테두리 없는 ghost(2026-07-15) — 라이트에서 bg-input=카드 배경이라 보더 없이
  // 채우면 안 보이므로 투명 배경 + hover 시 배경으로 어포던스. primary/destructive는 채움 유지.
  secondary: 'bg-transparent text-fg-dim hover:bg-bg-input-hover hover:text-fg',
  primary: 'bg-accent text-accent-fg font-semibold hover:brightness-110',
  destructive: 'text-fg font-semibold hover:brightness-110',
} as const;

export function ToolbarButton({
  tone = 'secondary',
  className = '',
  style,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: keyof typeof BUTTON_TONE_CLASS }) {
  const destructiveStyle = tone === 'destructive'
    ? { background: 'var(--error)', ...style }
    : style;
  return (
    <button
      type="button"
      {...props}
      style={destructiveStyle}
      className={`px-3 py-[7px] rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed ${BUTTON_TONE_CLASS[tone]} ${className}`.trim()}
    />
  );
}

export function SegmentedControl({
  className = '',
  children,
  ...props
}: { 'aria-label': string; className?: string; children: ReactNode }) {
  return (
    <div
      role="group"
      {...props}
      // 테두리 없는 세그먼트(2026-07-15) — bg-subtle 트랙 pill로 그룹을 정의(다크에서 bg-input=
      // 카드라 보더 없이 안 보임). 활성 세그먼트의 tint-selection이 선택 앵커.
      className={`inline-flex overflow-hidden rounded-lg bg-bg-subtle ${className}`.trim()}
    >
      {children}
    </div>
  );
}

export function PageState({
  tone = 'neutral',
  className = '',
  children,
}: {
  tone?: 'neutral' | 'error' | 'warn';
  className?: string;
  children: ReactNode;
}) {
  const toneClass = tone === 'error' ? 'text-error' : tone === 'warn' ? '' : 'text-fg-dim';
  const style = tone === 'warn' ? { color: 'var(--warn)' } : undefined;
  return (
    <div className={`p-md text-sm ${toneClass} ${className}`.trim()} style={style}>
      {children}
    </div>
  );
}

export function DefinitionRow({
  label,
  value,
  className = '',
}: {
  label: ReactNode;
  value: ReactNode;
  className?: string;
}) {
  return (
    <div className={`grid grid-cols-[120px_1fr] gap-3 items-center ${className}`.trim()}>
      <span className="text-xs uppercase tracking-wider text-fg-dimmer">{label}</span>
      <span className="font-mono text-xs">{value}</span>
    </div>
  );
}
