import type { LiveTimeframe } from '../state/livePage';

/** US prices support calendar bars and bounded native minute windows. */
export function usCalendarTimeframe(timeframe: LiveTimeframe): LiveTimeframe {
  return timeframe === 'W' || timeframe === 'M' ? timeframe : 'D';
}

export const US_MINUTE_TIMEFRAMES = ['1m', '3m', '5m', '10m', '15m', '30m', '60m'] as const;
export function usChartTimeframe(timeframe: LiveTimeframe): LiveTimeframe {
  return (US_MINUTE_TIMEFRAMES as readonly string[]).includes(timeframe) ? timeframe : usCalendarTimeframe(timeframe);
}

export type UsExchange = 'NASDAQ' | 'NYSE' | 'AMEX';

export type LiveIndexId = 'KOSPI' | 'KOSDAQ' | 'KOSPI200' | 'KOSDAQ150' | 'KRX100' | 'KRX300' | 'NASDAQ_COMPOSITE' | 'SP500' | 'SOX';

export type LiveInstrument =
  | { kind: 'us_stock'; exchange: UsExchange; symbol: string; label: string }
  | { kind: 'stock'; code: string; label: string }
  | { kind: 'index'; id: LiveIndexId; label: string };

export function stockInstrument(code: string, label = code): LiveInstrument {
  return { kind: 'stock', code, label };
}

export function indexInstrument(id: LiveIndexId, label: string = id): LiveInstrument {
  return { kind: 'index', id, label };
}

export function instrumentToActiveCode(instrument: LiveInstrument | null): string | null {
  return instrument?.kind === 'stock' ? instrument.code : null;
}

export function instrumentLabel(instrument: LiveInstrument | null): string {
  if (!instrument) return '';
  return instrument.label;
}

export function instrumentToSubjectKey(instrument: LiveInstrument): string {
  if (instrument.kind === 'us_stock') return usStockKey(instrument.exchange, instrument.symbol);
  return instrument.kind === 'stock' ? `stock:${instrument.code}` : `index:${instrument.id}`;
}

/**
 * **workarea 코드 공간** — 차트 창이 `LiveChartRoot` 의 `code` prop 으로 쓰는 식별자.
 * 주식은 6자리 코드 **그대로**, 지수만 `index:<id>` 로 접두사를 단다.
 *
 * 이 파일에 비슷한 이름이 셋이라 반드시 구별할 것:
 *  - `instrumentToActiveCode` → 지수는 **null**(전역 `activeCode` 공간). 수집·WS·
 *    드로잉 등 "종목이어야만 하는" 게이트가 이 공간에 산다.
 *  - `instrumentToSubjectKey` → **양쪽** 다 접두사(`stock:`/`index:`). 구독 키 공간.
 *  - 여기 → 주식만 맨 코드. 차트 prop 공간.
 *
 * 세 공간이 갈린 것이 결함이 아니라 설계다. 결함은 **한 공간의 값을 다른 공간과
 * 비교**하는 것이고, 실제로 그렇게 죽어 있던 곳이 창-스코프 뷰 가드였다
 * (`workspace/windowView.ts` 의 `getWorkareaCode` 주석 참조).
 */
export function indexWorkareaCode(id: LiveIndexId): string {
  return `index:${id}`;
}

/**
 * 이 workarea 코드가 지수인가 — **종목 전용 API 게이트**용.
 *
 * `/api/live/quotes` · `/api/live/past-daily-candles` 는 6자리 종목 코드만 받는다.
 * 지수 코드를 그대로 넘기면 에러가 아니라 **빈 응답**이 와서(실측: `quotes: []`)
 * 증상 없이 헛요청만 남는다 — 그래서 소비처에서 명시적으로 막아야 한다.
 */
export function isIndexWorkareaCode(code: string | null | undefined): boolean {
  return typeof code === 'string' && code.startsWith('index:');
}

export function isLiveIndexId(value: unknown): value is LiveIndexId {
  return (
    value === 'KOSPI' ||
    value === 'KOSDAQ' ||
    value === 'KOSPI200' ||
    value === 'KOSDAQ150' ||
    value === 'KRX100' ||
    value === 'KRX300' || isUsIndexId(value)
  );
}

export function isLiveInstrument(value: unknown): value is LiveInstrument {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  if (o.kind === 'us_stock') {
    return isUsExchange(o.exchange) && typeof o.symbol === 'string' && /^[A-Za-z0-9][A-Za-z0-9._\-]{0,19}$/.test(o.symbol) && typeof o.label === 'string';
  }
  if (o.kind === 'stock') {
    return typeof o.code === 'string' && typeof o.label === 'string';
  }
  if (o.kind === 'index') {
    return isLiveIndexId(o.id) && typeof o.label === 'string';
  }
  return false;
}

export function isUsExchange(value: unknown): value is UsExchange {
  return value === 'NASDAQ' || value === 'NYSE' || value === 'AMEX';
}
export function isUsIndexId(value: unknown): boolean {
  return value === 'NASDAQ_COMPOSITE' || value === 'SP500' || value === 'SOX';
}
export function isUsInstrument(instrument: LiveInstrument | null): boolean {
  return instrument?.kind === 'us_stock' || (instrument?.kind === 'index' && isUsIndexId(instrument.id));
}
export function usStockKey(exchange: UsExchange, symbol: string): string {
  return `us-stock:${exchange}:${symbol}`;
}
export function usStockInstrument(exchange: UsExchange, symbol: string, label = symbol): LiveInstrument {
  return { kind: 'us_stock', exchange, symbol, label };
}
export function usStockFromKey(key: string, label?: string): LiveInstrument | null {
  const parts = key.split(':');
  if (parts.length !== 3) return null;
  const [, exchange, symbol] = parts;
  return key.startsWith('us-stock:') && isUsExchange(exchange) && symbol && /^[A-Za-z0-9][A-Za-z0-9._\-]{0,19}$/.test(symbol)
    ? usStockInstrument(exchange, symbol, label ?? symbol) : null;
}
export function isNonDomesticStockCode(code: string | null | undefined): boolean {
  return !!code && (isIndexWorkareaCode(code) || code.startsWith('us-stock:'));
}
