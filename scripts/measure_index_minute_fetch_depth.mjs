const BASE = process.env.HOGA_API_BASE ?? 'http://127.0.0.1:8000';
const INDEX = process.env.HOGA_INDEX ?? 'KOSPI';
const TO = process.env.HOGA_TO ?? '20260622';
const FROM = process.env.HOGA_FROM ?? '20260601';
const TIMEFRAMES = (process.env.HOGA_TIMEFRAMES ?? '1m,3m,5m,10m,15m,30m')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const kstParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function kstDay(tsMs) {
  const parts = kstParts.formatToParts(new Date(tsMs));
  return [
    parts.find((p) => p.type === 'year').value,
    parts.find((p) => p.type === 'month').value,
    parts.find((p) => p.type === 'day').value,
  ].join('');
}

async function measure(name, timeframe, from, to) {
  const url = `${BASE}/api/live/index-candles?index_id=${INDEX}&timeframe=${timeframe}&from=${from}&to=${to}`;
  const t0 = performance.now();
  const res = await fetch(url, { cache: 'no-store' });
  const body = await res.json();
  const candles = Array.isArray(body.candles) ? body.candles : [];
  const byDay = {};
  for (const candle of candles) {
    const day = kstDay(candle.t_ms);
    byDay[day] = (byDay[day] ?? 0) + 1;
  }
  const reasons = {};
  for (const warning of body.data_warnings ?? []) {
    reasons[warning.reason] = (reasons[warning.reason] ?? 0) + 1;
  }
  return {
    name,
    timeframe,
    status: res.status,
    ms: Math.round(performance.now() - t0),
    candles: candles.length,
    days: byDay,
    warning_count: body.data_warnings?.length ?? 0,
    warning_reasons: reasons,
    warning_samples: (body.data_warnings ?? []).slice(0, 5),
  };
}

const rows = [];
for (const timeframe of TIMEFRAMES) {
  rows.push(await measure(`${timeframe}:today:1`, timeframe, TO, TO));
  rows.push(await measure(`${timeframe}:today:2`, timeframe, TO, TO));
  rows.push(await measure(`${timeframe}:wide`, timeframe, FROM, TO));
}

console.log(JSON.stringify({ index: INDEX, from: FROM, to: TO, rows }, null, 2));
console.table(rows.map((row) => ({
  name: row.name,
  ms: row.ms,
  candles: row.candles,
  days: Object.keys(row.days).join(','),
  warning_count: row.warning_count,
})));
