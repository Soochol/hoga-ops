interface Props {
  activeCode: string | null;
}

export function LiveWorkarea({ activeCode }: Props) {
  // Workarea takes 1fr in the grid; the inner layout (chart + sidebar + watchlist
  // panel) lands in subsequent stages. For Stage 9-α, surface a clear empty
  // state when there's no active code.
  if (!activeCode) {
    return (
      <div
        data-testid="live-workarea"
        className="flex items-center justify-center"
        style={{ background: 'var(--bg)', color: 'var(--fg-dimmer)' }}
      >
        <div className="text-center">
          <p style={{ fontSize: 'var(--text-md)', color: 'var(--fg-dim)' }}>관심종목을 선택해주세요</p>
          <p style={{ fontSize: 'var(--text-sm)', marginTop: 'var(--space-sm)' }}>
            우측 ★ 토글로 관심종목 패널을 여세요
          </p>
        </div>
      </div>
    );
  }
  return (
    <div
      data-testid="live-workarea"
      className="grid"
      style={{ gridTemplateColumns: '1fr var(--sidebar-w)', background: 'var(--bg)' }}
    >
      <div style={{ padding: 'var(--space-md)', color: 'var(--fg-dim)' }}>
        <div>캔들 차트 영역 (Stage 9-γ)</div>
        <div>호가 지표 차트 영역 (Stage 9-γ)</div>
      </div>
      <div
        style={{
          borderLeft: '1px solid var(--border)',
          padding: 'var(--space-md)',
          color: 'var(--fg-dim)',
        }}
      >
        Live Sidebar (Stage 11)
      </div>
    </div>
  );
}
