export function LiveHeader() {
  return (
    <div
      data-testid="live-header"
      className="flex items-center border-b px-3"
      style={{ height: 'var(--h-live-header)', borderColor: 'var(--border)', background: 'var(--bg-subtle)' }}
    >
      <h1 className="font-semibold" style={{ fontSize: 'var(--text-md)', color: 'var(--fg)' }}>
        Live
      </h1>
    </div>
  );
}
