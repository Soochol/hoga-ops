import NavItem from './NavItem';
import StatusDot from './StatusDot';
import { CaptureStatusPill } from './CaptureStatusPill';

export default function LeftNav() {
  return (
    <nav className="flex flex-col h-full bg-bg-subtle border-r">
      <div className="p-4 border-b flex items-center gap-2.5">
        <div className="w-6 h-6 rounded grid place-items-center text-bg font-bold text-xs"
             style={{ background: 'linear-gradient(135deg, var(--accent), var(--accent-shade))' }}>H</div>
        <div>
          <div className="font-semibold text-sm">hoga-ops</div>
          <div className="text-xs text-fg-dim uppercase tracking-wider">orderbook replay</div>
        </div>
      </div>
      <Section label="Workspace">
        <NavItem to="/live" label="Live" />
        <NavItem to="/screener" label="Screener" />
        <NavItem to="/inventory" label="Inventory" />
        <NavItem to="/capture" label="Capture" />
        <NavItem to="/watchlist" label="Watchlist" />
      </Section>
      <div className="flex-1" />
      <CaptureStatusPill />
      <Section label="System">
        <NavItem to="/settings" label="Settings" />
      </Section>
      <div className="p-3 border-t flex justify-between font-mono text-xs text-fg-dimmer">
        <StatusDot />
        <span>v0.1.0</span>
      </div>
    </nav>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="pl-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-fg-dimmer">{label}</div>
      <div className="px-2 py-1 flex flex-col gap-px">{children}</div>
    </div>
  );
}
