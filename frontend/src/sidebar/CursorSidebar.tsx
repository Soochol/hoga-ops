import { type ReactNode } from 'react';

type Props = {
  orderbook?: ReactNode;
  program?: ReactNode;
  brokers?: ReactNode;
};

export default function CursorSidebar({ orderbook, program, brokers }: Props) {
  return (
    <aside
      id="replay-sidebar"
      className={[
        'grid gap-[var(--space-sm)] p-[var(--space-sm)] bg-bg h-full min-h-0',
        program
          ? 'grid-rows-[minmax(420px,2fr)_minmax(112px,0.42fr)_minmax(180px,1.15fr)]'
          : 'grid-rows-[minmax(624px,2fr)_1.4fr]',
      ].join(' ')}
    >
      <SidebarCard label="10호가" testId="card-orderbook">
        {orderbook ?? <Placeholder />}
      </SidebarCard>
      {program && (
        <SidebarCard label="프로그램" testId="card-program-trade">
          {program}
        </SidebarCard>
      )}
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
