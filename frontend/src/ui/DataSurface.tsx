import type {
  CSSProperties,
  ElementType,
  HTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
} from 'react';
import { useId } from 'react';
import { ChevronIcon } from './ChevronIcon';

/**
 * 데이터 섹션 — 단일 표면 안의 divider 기반 카드(중첩 카드 크롬 금지, DESIGN.md).
 * `onToggleCollapse` 를 넘기면 접기 가능해지고 헤더 전체가 토글 버튼이 된다. 넘기지
 * 않으면(대부분의 호출부) 기존 정적 헤더 그대로라 렌더가 불변한다. 접힘 시 본문은
 * unmount(SSE 틱마다 도는 테이블 재렌더 정지 = 성능 이득). 높이는 스냅(무애니메이션),
 * chevron 회전만 150ms.
 */
export function DataSection({
  title,
  children,
  className = '',
  contentClassName = '',
  collapsed = false,
  onToggleCollapse,
  showEmptyDot = false,
  toggleTestId,
  headerLeading,
  headerTrailing,
  flushHeader = false,
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  showEmptyDot?: boolean;
  toggleTestId?: string;
  /** 정적 헤더(비접기) 좌측에 놓이는 컨트롤(드래그 핸들 등). collapsible 헤더에는
   *  적용되지 않는다 — 그쪽은 좌측이 토글 버튼이다. */
  headerLeading?: ReactNode;
  /** 헤더 우측에 나란히 놓이는 컨트롤(숨김 버튼 등). 넘기지 않으면 렌더 불변. */
  headerTrailing?: ReactNode;
  /** 헤더 밑 구분선(border-b) 제거 — 헤더가 본문과 같은 톤으로 흐르는 부유 카드 스타일
   *  (예: /capture 캡처 요청·대기열). 기본은 구분선 유지. */
  flushHeader?: boolean;
}) {
  const headerId = useId();
  const label = typeof title === 'string' ? title : undefined;
  const collapsible = typeof onToggleCollapse === 'function';
  const headerDivider = flushHeader ? '' : 'border-b border-border';
  const hasStaticControls = headerLeading != null || headerTrailing != null;
  return (
    <section
      aria-label={label}
      aria-labelledby={headerId}
      className={`border-t border-border first:border-t-0 ${className}`.trim()}
    >
      {collapsible ? (
        <header
          id={headerId}
          className={`flex items-center ${headerDivider} text-xs font-semibold uppercase text-fg-dimmer`.trim()}
        >
          <button
            type="button"
            data-testid={toggleTestId}
            aria-expanded={!collapsed}
            aria-label={label ? `${label} ${collapsed ? '펼치기' : '접기'}` : undefined}
            onClick={onToggleCollapse}
            className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-2 text-left hover:bg-bg-input-hover"
          >
            <ChevronIcon collapsed={collapsed} />
            <span className="min-w-0 flex-1 truncate">{title}</span>
            {collapsed && showEmptyDot && (
              <>
                <span
                  aria-hidden
                  className="ml-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-fg-dimmer"
                />
                <span className="sr-only">데이터 없음</span>
              </>
            )}
          </button>
          {headerTrailing != null && (
            <div className="flex shrink-0 items-center gap-0.5 pr-1.5">{headerTrailing}</div>
          )}
        </header>
      ) : hasStaticControls ? (
        <header
          id={headerId}
          className={`flex items-center ${headerDivider} text-xs font-semibold uppercase text-fg-dimmer`.trim()}
        >
          {headerLeading != null && (
            <span className="flex shrink-0 items-center pl-1.5">{headerLeading}</span>
          )}
          <span className="min-w-0 flex-1 truncate px-2 py-2">{title}</span>
          {headerTrailing != null && (
            <span className="flex shrink-0 items-center gap-0.5 pr-1.5">{headerTrailing}</span>
          )}
        </header>
      ) : (
        <header
          id={headerId}
          className={`${headerDivider} px-3 py-2 text-xs font-semibold uppercase text-fg-dimmer`.trim()}
        >
          {title}
        </header>
      )}
      {!collapsed && <div className={contentClassName}>{children}</div>}
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
        className={`block font-semibold text-xs uppercase text-fg-dim mb-1.5 ${labelProps?.className ?? ''}`.trim()}
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
  accent: { background: 'var(--tint-selection)', color: 'var(--accent)' },
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
