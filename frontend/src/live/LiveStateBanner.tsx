import { Link } from 'react-router';
import type { BannerCause } from './useLiveBannerState';

interface Props {
  primary: 'watchlist_empty' | 'kis_credentials_missing' | null;
  stack: BannerCause[];
}

const COPY: Record<BannerCause, { title: string; severity: 'error' | 'warn' | 'info' }> = {
  watchlist_empty: { title: '관심종목을 먼저 추가해주세요', severity: 'info' },
  kis_credentials_missing: { title: 'KIS 자격증명이 설정되지 않았습니다', severity: 'error' },
  kis_token_expired: { title: 'KIS 토큰이 만료되었습니다', severity: 'warn' },
  off_hours: { title: '장 외 시간 — 09:00 KST에 폴링이 시작됩니다', severity: 'info' },
};

export function LiveStateBanner({ primary, stack }: Props) {
  // Priority-1 banners render in the header band; priority 2-5 stack below.
  if (primary === null && stack.length === 0) return null;

  return (
    <div data-testid="live-state-banner" className="flex flex-col">
      {primary === 'kis_credentials_missing' && (
        <BannerRow cause="kis_credentials_missing" actionTo="/settings" actionLabel="설정" />
      )}
      {/* watchlist_empty is rendered in the workarea emptystate, not here.
          We surface it as a null in the header banner area but the LiveEmptyState
          consumes the same `primary` flag — see LiveWorkarea. */}
      {stack.map((cause) => (
        <BannerRow key={cause} cause={cause} />
      ))}
    </div>
  );
}

function BannerRow({
  cause,
  actionTo,
  actionLabel,
}: {
  cause: BannerCause;
  actionTo?: string;
  actionLabel?: string;
}) {
  const c = COPY[cause];
  const bg =
    c.severity === 'error' ? 'var(--tint-error)' :
    c.severity === 'warn' ? 'rgba(245, 158, 11, 0.10)' :
    'var(--bg-card)';
  const borderColor =
    c.severity === 'error' ? 'var(--error)' :
    c.severity === 'warn' ? 'var(--warn)' :
    'var(--border)';
  const fg =
    c.severity === 'error' ? 'var(--error)' :
    c.severity === 'warn' ? 'var(--warn)' :
    'var(--fg-dim)';

  return (
    <div
      role="status"
      className="flex items-center justify-between border-b px-3 py-2"
      style={{ background: bg, borderColor, color: fg, fontSize: 'var(--text-sm)' }}
    >
      <span>{c.title}</span>
      {actionTo && actionLabel && (
        <Link
          to={actionTo}
          className="px-2 py-1 rounded font-mono"
          style={{
            background: 'var(--bg-input)',
            color: 'var(--fg)',
            fontSize: 'var(--text-xs)',
            border: '1px solid var(--border-strong)',
          }}
        >
          {actionLabel}
        </Link>
      )}
    </div>
  );
}
