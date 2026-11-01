import { useState, type FormEvent } from 'react';
import { useDrawingsStore } from '../state/drawings';
import { TOOLS } from './drawing/tools';
import type { Drawing, Point } from './drawing/types';
import { FIB_LEVELS } from './drawing/types';
import { validPosition } from './drawing/analysisGeometry';
import '../live/DrawingMenu.css';

type Coordinate = { key: string; label: string; price?: number; realMs?: number };
export function drawingCoordinates(d: Drawing): Coordinate[] {
  if (d.kind === 'hline') return [{ key: 'price', label: '기준', price: d.price }];
  if (d.kind === 'vline') return [{ key: 'realMs', label: '기준', realMs: d.realMs }];
  if (d.kind === 'text' || d.kind === 'hray') return [{ key: 'at', label: '시작', ...d.at }];
  if (d.kind === 'pencil') return [];
  return [{ key: 'a', label: d.kind.endsWith('position') ? '진입' : '시작', ...d.a },
    { key: 'b', label: d.kind.endsWith('position') ? '목표' : '끝', ...d.b },
    ...(d.kind === 'channel' ? [{ key: 'c', label: '채널 폭', ...d.c }] : []),
    ...(d.kind === 'long-position' || d.kind === 'short-position' ? [{ key: 'stop', label: '손절', price: d.stop }] : [])];
}
const localTime = (ms: number) => new Date(ms + 9 * 3600000).toISOString().slice(0, 23);
const EMPTY_TEMPLATES: NonNullable<import('./drawing/types').DrawingDefaults['templates']> = [];

export function coordinatePatch(d: Drawing, values: Record<string, string>): Partial<Drawing> | null {
  const patch: Record<string, unknown> = {};
  for (const c of drawingCoordinates(d)) {
    const p = c.price == null ? undefined : Number(values[`${c.key}.price`]);
    const t = c.realMs == null ? undefined : Date.parse(`${values[`${c.key}.realMs`]}+09:00`);
    if (c.price != null && (!values[`${c.key}.price`]?.trim() || !Number.isFinite(p))) return null;
    if (c.realMs != null && !Number.isFinite(t)) return null;
    if (c.key === 'price' || c.key === 'stop') patch[c.key] = p;
    else if (c.key === 'realMs') patch.realMs = t;
    else patch[c.key] = { price: p, realMs: t };
  }
  if (d.kind === 'rect') {
    const a = patch.a as Point, b = patch.b as Point;
    if (a.realMs !== d.a.realMs || b.realMs !== d.b.realMs) patch.subX = {
      a: a.realMs === d.a.realMs ? d.subX?.a ?? 0 : 0,
      b: b.realMs === d.b.realMs ? d.subX?.b ?? 0 : 0,
    };
  }
  if (d.kind === 'channel' && (patch.a as Point).realMs === (patch.b as Point).realMs) return null;
  if (d.kind === 'long-position' || d.kind === 'short-position') {
    const next = { ...d, ...patch };
    if (!validPosition(next)) return null;
  }
  return patch as Partial<Drawing>;
}

export function DrawingDetails({ drawing: d, scope }: { drawing: Drawing; scope: string }) {
  const templates = useDrawingsStore(s => s.defaults.templates ?? EMPTY_TEMPLATES);
  const coords = drawingCoordinates(d);
  const valueLabel = d.paneId === 'candle' ? '가격' : '값';
  const [name, setName] = useState(d.name ?? '');
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(coords.flatMap(c => [
    ...(c.price == null ? [] : [[`${c.key}.price`, String(c.price)]]),
    ...(c.realMs == null ? [] : [[`${c.key}.realMs`, localTime(c.realMs)]]),
  ])));
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const update = (patch: Partial<Drawing>) => useDrawingsStore.getState().update(scope, d.id, patch);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const patch = coordinatePatch(d, values);
    if (!patch) { setError(d.kind.endsWith('position') ? '롱은 손절 < 진입 < 목표, 숏은 목표 < 진입 < 손절이어야 합니다.' : '유효한 값과 시각을 입력하세요. 채널의 두 기준점은 서로 다른 시각이어야 합니다.'); return; }
    setError(''); update({ ...patch, name: name.trim() }); setStatus('반영됨');
  };
  return <div className="drawing-details" data-testid="drawing-details">
    <div className="drawing-detail-grid mb-2">
      <label className="drawing-detail-wide">스타일 템플릿<select aria-label="스타일 템플릿" disabled={d.locked} value="" onChange={e => {
        const template = templates.find(t => t.kind === d.kind && t.name === e.target.value);
        if (template) {
          const { color, width, lineStyle, fontSize, fillOpacity, labelHidden } = template.style;
          update({ color, ...(d.kind === 'text' ? { fontSize } : { width, lineStyle }),
            ...(d.kind === 'rect' || d.kind === 'channel' ? { fillOpacity } : {}),
            ...(['hline','hray','trendline','fib'].includes(d.kind) && typeof labelHidden === 'boolean' ? { labelHidden } : {}) });
        }
      }}><option value="">저장한 스타일 선택</option>{templates.filter(t => t.kind === d.kind).map(t => <option key={t.name} value={t.name}>{t.name}</option>)}</select></label>
    </div>
    <form onSubmit={submit}>
      <div className="drawing-detail-grid">
        <label className="drawing-detail-wide">이름<input aria-label="그리기 이름" value={name} disabled={d.locked} maxLength={100} placeholder={TOOLS[d.kind].label} onChange={e => setName(e.target.value)} /></label>
        {coords.map(c => <div key={c.key} className="contents">
          {c.price != null && <label>{c.label} {valueLabel}<input aria-label={`${c.label} ${valueLabel}`} type="number" step="any" required disabled={d.locked} value={values[`${c.key}.price`]}
            onChange={e => setValues(v => ({ ...v, [`${c.key}.price`]: e.target.value }))} /></label>}
          {c.realMs != null && <label>{c.label} 시각 · KST<input aria-label={`${c.label} 시각`} type="datetime-local" step="0.001" required disabled={d.locked} value={values[`${c.key}.realMs`]}
            onChange={e => setValues(v => ({ ...v, [`${c.key}.realMs`]: e.target.value }))} /></label>}
        </div>)}
      </div>
      {error && <p className="drawing-detail-error" role="alert">{error}</p>}
      <button type="submit" disabled={d.locked} className="mt-2 rounded px-2 py-1 bg-tint-selection text-accent text-xs disabled:opacity-40">이름 · 좌표 적용</button>
      <span className="ml-2 text-2xs text-fg-dim" aria-live="polite">{status}</span>
      <button type="button" disabled={d.locked} className="mt-2 ml-1 rounded px-2 py-1 text-xs hover:bg-bg-input-hover disabled:opacity-40" onClick={() => {
        const store = useDrawingsStore.getState(), templateName = name.trim() || TOOLS[d.kind].label;
        store.setDefaults({ templates: [...templates.filter(t => t.kind !== d.kind || t.name !== templateName),
          { name: templateName, kind: d.kind, style: { ...store.styleForKind(d.kind) } }].slice(-32) });
        setStatus('스타일 저장됨');
      }}>스타일 저장</button>
    </form>
    <div className="drawing-detail-checks">
      {(d.kind === 'trendline' || d.kind === 'fib' || d.kind === 'channel') && <>
        {d.kind === 'trendline' && <label><input type="checkbox" aria-label="왼쪽 연장" disabled={d.locked} checked={d.extendLeft === true} onChange={e => update({ extendLeft: e.target.checked })} />왼쪽 연장</label>}
        <label><input type="checkbox" aria-label="우측 연장" disabled={d.locked} checked={d.extendRight === true} onChange={e => update({ extendRight: e.target.checked })} />우측 연장</label>
      </>}
      {d.kind === 'channel' && <label><input type="checkbox" disabled={d.locked} checked={!d.middleHidden} onChange={e => update({ middleHidden: !e.target.checked })} />중앙선</label>}
      {(d.kind === 'fib' || d.kind === 'hray') && <label><input type="checkbox" disabled={d.locked} checked={!d.labelHidden} onChange={e => update({ labelHidden: !e.target.checked })} />가격 라벨</label>}
    </div>
    {d.kind === 'channel' && <label className="mt-2 flex items-center gap-2">채우기 농도<select aria-label="채널 채우기 농도" disabled={d.locked} value={d.fillOpacity} onChange={e => update({fillOpacity:Number(e.target.value)})} className="bg-bg-input rounded p-1">
      {[0,0.1,0.2,0.35].map(v=><option key={v} value={v}>{v*100}%</option>)}
    </select></label>}
    {d.kind === 'fib' && <>
      <div className="drawing-detail-checks"><label><input type="checkbox" disabled={d.locked} checked={d.reverse === true} onChange={e => update({ reverse: e.target.checked })} />방향 반전</label></div>
      <div className="drawing-detail-checks" aria-label="피보나치 레벨">{[...new Set([...FIB_LEVELS,1.272,1.618,...d.levels])].sort((a,b)=>a-b).map(level => <label key={level}><input type="checkbox" disabled={d.locked} checked={d.levels.includes(level)}
        onChange={e => update({ levels: e.target.checked ? [...d.levels,level].sort((a,b)=>a-b) : d.levels.filter(v=>v!==level) })} />{level}</label>)}</div>
    </>}
    {(d.kind === 'long-position' || d.kind === 'short-position') && <label className="mt-2 flex items-center gap-2">수량<input aria-label="계획 수량" type="number" min="0" step="any" disabled={d.locked} defaultValue={d.quantity}
      onBlur={e => { const quantity=Number(e.target.value); if (e.target.value.trim() && Number.isFinite(quantity) && quantity>=0) update({ quantity }); else e.target.value=String(d.quantity); }} className="min-w-0 w-24 rounded bg-bg-input p-1" /></label>}
  </div>;
}
