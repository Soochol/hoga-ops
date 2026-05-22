import { CaptureForm } from '../capture/CaptureForm';
import { CaptureQueue } from '../capture/CaptureQueue';

function currentKstMonth(): { year: number; month: number } {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  const kst = new Date(utcMs + 9 * 60 * 60_000);
  return { year: kst.getFullYear(), month: kst.getMonth() + 1 };
}

export default function Capture() {
  const { year, month } = currentKstMonth();
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '38fr 62fr',
        gap: 16,
        padding: 16,
        height: '100%',
        background: 'var(--bg)',
        color: 'var(--fg)',
      }}
    >
      <section style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 16,
        overflowY: 'auto',
      }}>
        <CaptureForm referenceYear={year} referenceMonth={month} />
      </section>
      <section style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 12,
        display: 'flex', flexDirection: 'column',
        minHeight: 0,
      }}>
        <CaptureQueue />
      </section>
    </div>
  );
}
