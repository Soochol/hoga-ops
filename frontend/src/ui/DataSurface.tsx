import type {
  CSSProperties,
  ElementType,
  HTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
} from 'react';
import { useId } from 'react';

export function DataSection({
  title,
  children,
  className = '',
  contentClassName = '',
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const headerId = useId();
  return (
    <section
      aria-label={typeof title === 'string' ? title : undefined}
      aria-labelledby={headerId}
      className={`border-t border-border first:border-t-0 ${className}`.trim()}
    >
      <header
        id={headerId}
        className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-fg-dimmer"
      >
        {title}
      </header>
      <div className={contentClassName}>{children}</div>
    </section>
  );
}

type DataTableShellProps = {
  children: ReactNode;
  className?: string;
  minWidth?: string;
};

export function DataTableShell({ children, className = '', minWidth = '640px' }: DataTableShellProps) {
  return (
    <div className={`min-w-0 bg-bg-card border rounded-lg flex flex-col min-h-0 overflow-auto ${className}`.trim()}>
      <div className="flex min-h-full flex-col" style={{ minWidth }}>
        {children}
      </div>
    </div>
  );
}

type DataGridProps<T extends ElementType> = {
  as?: T;
  columns: string;
  className?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, 'className' | 'children'>;

export function DataTableHeader<T extends ElementType = 'div'>({
  as,
  columns,
  className = '',
  children,
  ...props
}: DataGridProps<T>) {
  const Tag = (as ?? 'div') as ElementType;
  return (
    <Tag
      {...props}
      className={`grid ${columns} items-center gap-2 px-sm py-1 border-b ${className}`.trim()}
    >
      {children}
    </Tag>
  );
}

export function DataTableRow<T extends ElementType = 'div'>({
  as,
  columns,
  className = '',
  children,
  ...props
}: DataGridProps<T>) {
  const Tag = (as ?? 'div') as ElementType;
  return (
    <Tag
      {...props}
      className={`grid ${columns} items-center gap-2 px-sm h-orderbook-row border-b text-sm text-fg ${className}`.trim()}
    >
      {children}
    </Tag>
  );
}

export function ListRow<T extends ElementType = 'div'>({
  as,
  active = false,
  className = '',
  children,
  ...props
}: {
  as?: T;
  active?: boolean;
  className?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, 'className' | 'children'>) {
  const Tag = (as ?? 'div') as ElementType;
  return (
    <Tag
      {...props}
      className={`rounded-md text-sm ${
        active ? 'bg-tint-selection text-fg' : 'text-fg-dim hover:bg-bg-input-hover'
      } ${className}`.trim()}
    >
      {children}
    </Tag>
  );
}

export function EmptyState({
  title,
  children,
  className = '',
  testId,
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`h-full flex flex-col items-center justify-center gap-2 p-lg text-fg-dim font-normal text-sm text-center ${className}`.trim()}
    >
      {title !== undefined && <div className="font-medium text-base text-fg">{title}</div>}
      <div>{children}</div>
    </div>
  );
}

export function FormField({
  label,
  className = '',
  labelProps,
  children,
}: {
  label: ReactNode;
  className?: string;
  labelProps?: LabelHTMLAttributes<HTMLLabelElement>;
  children: ReactNode;
}) {
  return (
    <section className={className}>
      <label
        {...labelProps}
        className={`block font-semibold text-xs tracking-widest uppercase text-fg-dim mb-1.5 ${labelProps?.className ?? ''}`.trim()}
      >
        {label}
      </label>
      {children}
    </section>
  );
}

const INLINE_TONE = {
  neutral: 'border-border bg-bg-input text-fg-dim',
  error: 'border-error bg-tint-error text-error',
  accent: 'border-[--accent]',
  warn: 'border-[--warn]',
} as const;

const INLINE_STYLE: Partial<Record<keyof typeof INLINE_TONE, CSSProperties>> = {
  accent: { background: 'rgba(20,184,166,0.10)', color: 'var(--accent)' },
  warn: { background: 'rgba(245,158,11,0.10)', color: 'var(--warn)' },
};

export function InlineState({
  tone = 'neutral',
  className = '',
  children,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  tone?: keyof typeof INLINE_TONE;
}) {
  return (
    <div
      {...props}
      style={{ ...INLINE_STYLE[tone], ...style }}
      className={`rounded-md border px-3 py-2 text-sm ${INLINE_TONE[tone]} ${className}`.trim()}
    >
      {children}
    </div>
  );
}
