import type { Tab } from '../state/tabs';

export default function OnboardingCard({ tab }: { tab: Tab }) {
  const step =
    !tab.selection?.code ? 1 :
    !tab.selection?.fromDate || !tab.selection?.toDate ? 2 :
    3;
  return (
    <div className="grid place-items-center h-full">
      <div className="max-w-md bg-bg-card border rounded p-6 space-y-3">
        <h3 className="text-lg font-semibold">분석 시작</h3>
        <Step n={1} done={step > 1} active={step === 1} label="종목 선택" />
        <Step n={2} done={step > 2} active={step === 2} label="기간 선택" />
        <Step n={3} done={false} active={step === 3} label="데이터 불러오기" />
      </div>
    </div>
  );
}

function Step({ n, done, active, label }: { n: number; done: boolean; active: boolean; label: string }) {
  return (
    <div className={`flex gap-3 items-center ${done ? 'text-up' : active ? 'text-fg' : 'text-fg-dim'}`}>
      <span className="font-mono text-xs">{done ? '✓' : n + '.'}</span>
      <span className={active ? 'font-medium' : ''}>{label}</span>
    </div>
  );
}
