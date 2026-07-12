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
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, 'className' | 'children' | 'style'>;

export function PanelCard({ as = 'div', className = '', style, children, ...props }: PanelCardProps) {
  const Tag = as as ElementType;
  return (
    <Tag
      {...props}
      className={`bg-bg-card border border-border rounded-lg min-w-0 shadow-panel ${className}`.trim()}
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
  secondary: 'bg-bg-input border border-border text-fg-dim hover:bg-bg-input-hover hover:text-fg',
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
      className={`inline-flex rounded-lg border border-border bg-bg-input overflow-hidden ${className}`.trim()}
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
