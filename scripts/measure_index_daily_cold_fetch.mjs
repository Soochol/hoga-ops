const BASE = process.env.HOGA_API_BASE ?? 'http://127.0.0.1:8000';
const FROM = process.env.HOGA_FROM ?? '20240101';
const TO = process.env.HOGA_TO ?? '20260622';

const STOCKS = (process.env.HOGA_STOCKS ?? '373220,207940,105560,012330,066570')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const INDICES = (process.env.HOGA_INDICES ?? 'KOSPI200,KOSPI,KOSDAQ')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function measure(name, url) {
  const t0 = performance.now();
  const res = await fetch(url, { cache: 'no-store' });
  const text = await res.text();
  const ms = Math.round(performance.now() - t0);
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { parse_error: text.slice(0, 160) };
  }
  return {
    name,
    status: res.status,
    ms,
    candles: Array.isArray(body.candles) ? body.candles.length : null,
    cached_batches: Array.isArray(body.cached_batches) ? body.cached_batches.length : null,
    fresh_batches: Array.isArray(body.fresh_batches) ? body.fresh_batches.length : null,
    warnings: Array.isArray(body.data_warnings) ? body.data_warnings.length : null,
  };
}

const rows = [];
for (const code of STOCKS) {
  rows.push(await measure(
    `stock:${code}`,
    `${BASE}/api/live/past-daily-candles?code=${code}&from=${FROM}&to=${TO}&venue=KRX`,
  ));
}
for (const indexId of INDICES) {
  rows.push(await measure(
    `index:${indexId}`,
    `${BASE}/api/live/index-candles?index_id=${indexId}&timeframe=D&from=${FROM}&to=${TO}`,
  ));
}

console.table(rows);
console.log(JSON.stringify({ from: FROM, to: TO, rows }, null, 2));
