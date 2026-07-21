import { type ReactNode } from 'react';

type Props = {
  orderbook?: ReactNode;
  volumeDistribution?: ReactNode;
  program?: ReactNode;
  brokers?: ReactNode;
};

export default function CursorSidebar({ orderbook, volumeDistribution, program, brokers }: Props) {
  return (
    <aside
      id="replay-sidebar"
      className="grid min-h-full gap-[var(--space-sm)] bg-bg p-[var(--space-sm)]"
      style={{
        gridTemplateRows: [
          'auto',
          volumeDistribution ? 'auto' : null,
          'auto',
          program ? 'auto' : null,
        ].filter(Boolean).join(' '),
      }}
    >
      <SidebarCard label="10호가" testId="card-orderbook">
        {orderbook ?? <Placeholder />}
      </SidebarCard>
      {volumeDistribution && (
        <SidebarCard label="연속체결 매물대 분포" testId="card-volume-distribution">
          {volumeDistribution}
        </SidebarCard>
      )}
      <SidebarCard label="거래원" testId="card-brokers">
        {brokers ?? <Placeholder />}
      </SidebarCard>
      {program && (
        <SidebarCard label="프로그램" testId="card-program-trade">
          {program}
        </SidebarCard>
      )}
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
      className="flex flex-col bg-bg-card border rounded"
    >
      <header className="px-3 py-2 border-b text-xs font-semibold uppercase text-fg-dimmer">
        {label}
      </header>
      <div>{children}</div>
    </section>
  );
}

function Placeholder() {
  return <div className="grid place-items-center h-full text-fg-dimmer text-xs">-</div>;
}
