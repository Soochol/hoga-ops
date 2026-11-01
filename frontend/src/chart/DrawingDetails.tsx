import { useState, type FormEvent } from 'react';
import { useDrawingsStore } from '../state/drawings';
import { TOOLS } from './drawing/tools';
import type { Drawing, Point } from './drawing/types';
import { FIB_LEVELS, FIB_EXTENSION_LEVELS, PATH_MAX_POINTS, REGRESSION_SOURCES } from './drawing/types';
import { validPosition } from './drawing/analysisGeometry';
import '../live/DrawingMenu.css';

type Coordinate = { key: string; label: string; price?: number; realMs?: number };
export function drawingCoordinates(d: Drawing): Coordinate[] {
  if (d.kind === 'hline') return [{ key: 'price', label: '기준', price: d.price }];
  if (d.kind === 'vline') return [{ key: 'realMs', label: '기준', realMs: d.realMs }];
  if (d.kind === 'text' || d.kind === 'hray') return [{ key: 'at', label: '시작', ...d.at }];
  if (d.kind === 'path') return d.points.map((p,i) => ({ key: `point:${i}`, label: `점 ${i+1}`, ...p }));
  if (d.kind === 'callout') return [{key:'a', label:'대상', ...d.a}];
  if (d.kind === 'regression') return [{key:'a',label:'시작',realMs:d.a.realMs},{key:'b',label:'끝',realMs:d.b.realMs}];
  if (d.kind === 'pencil') return [];
  return [{ key: 'a', label: d.kind.endsWith('position') ? '진입' : '시작', ...d.a },
    { key: 'b', label: d.kind.endsWith('position') ? '목표' : '끝', ...d.b },
    ...((d.kind === 'channel' || d.kind === 'fib-extension') ? [{ key: 'c', label: d.kind === 'channel' ? '채널 폭' : '눌림', ...d.c }] : []),
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
    else if (c.key.startsWith('point:') && d.kind === 'path') {
      const points = (patch.points ?? d.points.map(p => ({...p}))) as Point[];
      points[Number(c.key.slice(6))] = {price:p!,realMs:t!}; patch.points = points;
    } else patch[c.key] = { price: p ?? (d.kind === 'regression' ? d[c.key as 'a'|'b'].price : 0), realMs: t };
  }
  if (d.kind === 'rect') {
    const a = patch.a as Point, b = patch.b as Point;
    if (a.realMs !== d.a.realMs || b.realMs !== d.b.realMs) patch.subX = {
      a: a.realMs === d.a.realMs ? d.subX?.a ?? 0 : 0,
      b: b.realMs === d.b.realMs ? d.subX?.b ?? 0 : 0,
    };
  }
  if ((d.kind === 'channel' || d.kind === 'regression') && (patch.a as Point).realMs === (patch.b as Point).realMs) return null;
  if (d.kind === 'fib-extension' && (patch.a as Point).price === (patch.b as Point).price) return null;
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
  const [text, setText] = useState(d.kind === 'callout' ? d.text : '');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const update = (patch: Partial<Drawing>) => useDrawingsStore.getState().update(scope, d.id, patch);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const patch = coordinatePatch(d, values);
    if (!patch || d.kind === 'callout' && !text.trim()) { setError(d.kind.endsWith('position') ? '롱은 손절 < 진입 < 목표, 숏은 목표 < 진입 < 손절이어야 합니다.' : '유효한 값과 시각을 입력하세요. 채널의 두 기준점은 서로 다른 시각이어야 합니다.'); return; }
    setError(''); update({ ...patch, name: name.trim(), ...(d.kind === 'callout' ? {text:text.trim()} : {}) }); setStatus('반영됨');
  };
  return <div className="drawing-details" data-testid="drawing-details">
    <div className="drawing-detail-grid mb-2">
      <label className="drawing-detail-wide">스타일 템플릿<select aria-label="스타일 템플릿" disabled={d.locked} value="" onChange={e => {
        const template = templates.find(t => t.kind === d.kind && t.name === e.target.value);
        if (template) {
          const { color, width, lineStyle, fontSize, fillOpacity, labelHidden } = template.style;
          update({ color, ...(d.kind === 'text' ? { fontSize } : { width, lineStyle, ...(d.kind === 'callout' ? {fontSize} : {}) }),
            ...(d.kind === 'rect' || d.kind === 'channel' || d.kind === 'regression' ? { fillOpacity } : {}),
            ...(['hline','hray','trendline','fib','fib-extension'].includes(d.kind) && typeof labelHidden === 'boolean' ? { labelHidden } : {}) });
        }
      }}><option value="">저장한 스타일 선택</option>{templates.filter(t => t.kind === d.kind).map(t => <option key={t.name} value={t.name}>{t.name}</option>)}</select></label>
    </div>
    <form onSubmit={submit}>
      <div className="drawing-detail-grid">
        <label className="drawing-detail-wide">이름<input aria-label="그리기 이름" value={name} disabled={d.locked} maxLength={100} placeholder={TOOLS[d.kind].label} onChange={e => setName(e.target.value)} /></label>
        {d.kind === 'callout' && <label className="drawing-detail-wide">메모<textarea aria-label="콜아웃 메모" disabled={d.locked} maxLength={4000} value={text} onChange={e=>setText(e.target.value)} /></label>}
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
      {(d.kind === 'trendline' || d.kind === 'fib' || d.kind === 'channel' || d.kind === 'fib-extension' || d.kind === 'regression') && <>
        {d.kind === 'trendline' && <label><input type="checkbox" aria-label="왼쪽 연장" disabled={d.locked} checked={d.extendLeft === true} onChange={e => update({ extendLeft: e.target.checked })} />왼쪽 연장</label>}
        <label><input type="checkbox" aria-label="우측 연장" disabled={d.locked} checked={d.extendRight === true} onChange={e => update({ extendRight: e.target.checked })} />우측 연장</label>
      </>}
      {d.kind === 'channel' && <label><input type="checkbox" disabled={d.locked} checked={!d.middleHidden} onChange={e => update({ middleHidden: !e.target.checked })} />중앙선</label>}
      {(d.kind === 'fib' || d.kind === 'fib-extension' || d.kind === 'hray') && <label><input type="checkbox" disabled={d.locked} checked={!d.labelHidden} onChange={e => update({ labelHidden: !e.target.checked })} />가격 라벨</label>}
    </div>
    {(d.kind === 'channel' || d.kind === 'regression') && <label className="mt-2 flex items-center gap-2">채우기 농도<select aria-label="채널 채우기 농도" disabled={d.locked} value={d.fillOpacity} onChange={e => update({fillOpacity:Number(e.target.value)})} className="bg-bg-input rounded p-1">
      {[0,0.1,0.2,0.35].map(v=><option key={v} value={v}>{v*100}%</option>)}
    </select></label>}
    {(d.kind === 'fib' || d.kind === 'fib-extension') && <>
      {d.kind === 'fib' && <div className="drawing-detail-checks"><label><input type="checkbox" disabled={d.locked} checked={d.reverse === true} onChange={e => update({ reverse: e.target.checked })} />방향 반전</label></div>}
      <div className="drawing-detail-checks" aria-label="피보나치 레벨">{[...new Set([...(d.kind === 'fib' ? FIB_LEVELS : FIB_EXTENSION_LEVELS),1.272,1.618,...d.levels])].sort((a,b)=>a-b).map(level => <label key={level}><input type="checkbox" disabled={d.locked} checked={d.levels.includes(level)}
        onChange={e => update({ levels: e.target.checked ? [...d.levels,level].sort((a,b)=>a-b) : d.levels.filter(v=>v!==level) })} />{level}</label>)}</div>
    </>}
    {d.kind === 'path' && <div className="drawing-detail-checks">
      <label><input type="checkbox" disabled={d.locked} checked={d.arrowStart === true} onChange={e=>update({arrowStart:e.target.checked})} />시작 화살표</label>
      <label><input type="checkbox" disabled={d.locked} checked={d.arrowEnd !== false} onChange={e=>update({arrowEnd:e.target.checked})} />끝 화살표</label>
      <button type="button" disabled={d.locked || d.points.length >= PATH_MAX_POINTS} onClick={()=>{ const a=d.points.at(-2)!, b=d.points.at(-1)!; update({points:[...d.points.slice(0,-1),{realMs:(a.realMs+b.realMs)/2,price:(a.price+b.price)/2},b]}); }}>점 추가</button>
      {d.points.map((_,i)=><button key={i} type="button" disabled={d.locked || d.points.length<=2} aria-label={`점 ${i+1} 삭제`} onClick={()=>update({points:d.points.filter((_,j)=>i!==j)})}>점 {i+1} 삭제</button>)}
    </div>}
    {d.kind === 'callout' && <div className="drawing-detail-grid mt-2">
      <label>글자 크기<select aria-label="콜아웃 글자 크기" disabled={d.locked} value={d.fontSize} onChange={e=>update({fontSize:Number(e.target.value)})}>{[...new Set([11,13,16,20,24,d.fontSize])].sort((a,b)=>a-b).map(v=><option key={v} value={v}>{v}px</option>)}</select></label>
      {(['offsetX','offsetY'] as const).map(key=><label key={key}>메모 {key==='offsetX'?'가로':'세로'} 간격<input aria-label={key==='offsetX'?'메모 가로 간격':'메모 세로 간격'} type="number" step="any" disabled={d.locked} defaultValue={d[key]} onBlur={e=>{const v=Number(e.target.value); if(e.target.value.trim()&&Number.isFinite(v)) update({[key]:v}); else e.target.value=String(d[key]);}} /></label>)}
    </div>}
    {d.kind === 'regression' && <div className="drawing-detail-grid mt-2">
      <label>기준가<select aria-label="회귀 기준가" disabled={d.locked} value={d.source} onChange={e=>update({source:e.target.value as typeof d.source})}>{REGRESSION_SOURCES.map(v=><option key={v} value={v}>{({close:'종가',open:'시가',high:'고가',low:'저가',hl2:'고저 평균',hlc3:'고저종 평균',ohlc4:'시고저종 평균'})[v]}</option>)}</select></label>
      {(['upperDeviation','lowerDeviation'] as const).map(key=><label key={key}>{key==='upperDeviation'?'상단':'하단'} 표준편차<input aria-label={key==='upperDeviation'?'상단 표준편차':'하단 표준편차'} type="number" min="0" max="10" step="0.1" disabled={d.locked} defaultValue={d[key]} onBlur={e=>{const v=Number(e.target.value); if(e.target.value.trim()&&Number.isFinite(v)&&v>=0&&v<=10) update({[key]:v}); else e.target.value=String(d[key]);}} /></label>)}
      <p className="drawing-detail-wide text-2xs text-fg-dim">현재 시간봉에 로드된 구간으로 재계산 · 잔차 표준편차 σ</p>
    </div>}
    {(d.kind === 'long-position'  || d.kind === 'short-position') && <label className="mt-2 flex items-center gap-2">수량<input aria-label="계획 수량" type="number" min="0" step="any" disabled={d.locked} defaultValue={d.quantity}
      onBlur={e => { const quantity=Number(e.target.value); if (e.target.value.trim() && Number.isFinite(quantity) && quantity>=0) update({ quantity }); else e.target.value=String(d.quantity); }} className="min-w-0 w-24 rounded bg-bg-input p-1" /></label>}
  </div>;
}
