import { LiveSymbolSearch } from './LiveSymbolSearch';

export function LiveHeader() {
  return (
    <div
      data-testid="live-header"
      className="flex items-center gap-3 border-b px-3"
      style={{ height: 'var(--h-live-header)', borderColor: 'var(--border)', background: 'var(--bg-subtle)' }}
    >
      {/* No page-title text here: the left nav already marks /live as the active
          page, and the active symbol shows one row down in LiveStatusBar — a
          header "Live" duplicated the nav and added no context. */}
      <LiveSymbolSearch />
    </div>
  );
}
