export type LiveIndexId = 'KOSPI' | 'KOSDAQ' | 'KOSPI200' | 'KOSDAQ150' | 'KRX100' | 'KRX300';

export type LiveInstrument =
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
  return instrument.kind === 'stock' ? `stock:${instrument.code}` : `index:${instrument.id}`;
}

export function isLiveIndexId(value: unknown): value is LiveIndexId {
  return (
    value === 'KOSPI' ||
    value === 'KOSDAQ' ||
    value === 'KOSPI200' ||
    value === 'KOSDAQ150' ||
    value === 'KRX100' ||
    value === 'KRX300'
  );
}

export function isLiveInstrument(value: unknown): value is LiveInstrument {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  if (o.kind === 'stock') {
    return typeof o.code === 'string' && typeof o.label === 'string';
  }
  if (o.kind === 'index') {
    return isLiveIndexId(o.id) && typeof o.label === 'string';
  }
  return false;
}
