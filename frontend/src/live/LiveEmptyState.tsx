import { Link } from 'react-router';

interface Props {
  cause: 'no_active_code' | 'watchlist_empty';
}

export function LiveEmptyState({ cause }: Props) {
  if (cause === 'watchlist_empty') {
    return (
      <div
        data-testid="live-empty-state"
        className="flex items-center justify-center h-full"
        style={{ background: 'var(--bg)', color: 'var(--fg-dim)' }}
      >
        <div className="text-center" style={{ padding: 'var(--space-2xl)' }}>
          <p style={{ fontSize: 'var(--text-md)', color: 'var(--fg)' }}>
            관심종목이 비어 있습니다
          </p>
          <p style={{ fontSize: 'var(--text-sm)', marginTop: 'var(--space-sm)' }}>
            라이브 폴링은 관심종목에 등록된 종목만 추적합니다
          </p>
          <Link
            to="/capture"
            className="inline-block mt-3 px-3 py-1.5 rounded font-mono"
            style={{
              marginTop: 'var(--space-md)',
              background: 'var(--accent)',
              color: 'var(--accent-fg)',
              fontSize: 'var(--text-sm)',
            }}
          >
            종목 추가
          </Link>
        </div>
      </div>
    );
  }

  // no_active_code
  return (
    <div
      data-testid="live-empty-state"
      className="flex items-center justify-center h-full"
      style={{ background: 'var(--bg)', color: 'var(--fg-dimmer)' }}
    >
      <div className="text-center">
        <p style={{ fontSize: 'var(--text-md)', color: 'var(--fg-dim)' }}>
          <kbd className="bg-bg-input border border-border rounded px-1.5 py-0.5 font-mono">/</kbd>
          {' '}를 눌러 종목을 검색하세요
        </p>
        <p style={{ fontSize: 'var(--text-sm)', marginTop: 'var(--space-sm)' }}>
          최근 본 종목이 있으면 자동으로 불러옵니다
        </p>
      </div>
    </div>
  );
}
