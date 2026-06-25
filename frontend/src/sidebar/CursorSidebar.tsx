import { type ReactNode } from 'react';

type Props = {
  orderbook?: ReactNode;
  volumeDistribution?: ReactNode;
  brokers?: ReactNode;
};

export default function CursorSidebar({ orderbook, volumeDistribution, brokers }: Props) {
  return (
    <aside
      id="replay-sidebar"
      className="grid grid-rows-[minmax(480px,1.8fr)_minmax(132px,0.5fr)_minmax(180px,1.2fr)] gap-[var(--space-sm)] p-[var(--space-sm)] bg-bg h-full min-h-0"
    >
      <SidebarCard label="10호가" testId="card-orderbook">
        {orderbook ?? <Placeholder />}
      </SidebarCard>
      <SidebarCard label="연속체결 매물대 분포" testId="card-volume-distribution">
        {volumeDistribution ?? <Placeholder />}
      </SidebarCard>
      <SidebarCard label="거래원" testId="card-brokers">
        {brokers ?? <Placeholder />}
      </SidebarCard>
    </aside>
  );
}

function SidebarCard({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      data-card={testId.replace(/^card-/, '')}
      className="flex flex-col min-h-0 bg-bg-card border rounded overflow-hidden"
    >
      <header className="px-3 py-2 border-b text-xs font-semibold uppercase tracking-wider text-fg-dimmer">
        {label}
      </header>
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
    </section>
  );
}

function Placeholder() {
  return <div className="grid place-items-center h-full text-fg-dimmer text-xs">—</div>;
}
