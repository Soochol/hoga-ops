import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analysisHandlePatch, positionStats, projectAnalysis, validPosition } from './analysisGeometry';
import { hitTestDrawings, drawingsInRect } from './hitTest';
import { drawingFromAnalysisDraft, analysisTool, horizontalRayTool, type AnalysisDraft } from './analysisTools';
import { INITIAL_STYLE, FIB_LEVELS, type AnalysisDrawing, type Channel, type Drawing, type Fib, type Position } from './types';
import { normalizeItems, loadDrawings, saveDrawings, loadDefaults, saveDefaults } from './persistence';
import { cloneWithOffset } from './duplicate';
import { translateDrawing } from './translate';
import { useDrawingsStore } from '../../state/drawings';
import { coordinatePatch, drawingCoordinates } from '../DrawingDetails';
import type { ToolCtx } from './tools';

const base = { id:'new', color:'#14B8A6', width:2, lineStyle:'solid' as const, paneId:'candle' as const };
const coords = { x:(ms:number)=>ms, y:(price:number)=>price, width:500 };
const hitCoords = { realMsToCanvasX:coords.x, priceToCanvasY:coords.y, paneIdAtY:()=> 'candle' as const, plotWidth:500 };
const fib: Fib = { ...base, kind:'fib', a:{realMs:100,price:100}, b:{realMs:200,price:200}, levels:[0,0.5,1], extendRight:true };
const channel: Channel = { ...base, kind:'channel', a:{realMs:100,price:100}, b:{realMs:200,price:200}, c:{realMs:150,price:200}, fillOpacity:0.1, extendRight:true };
const long: Position = { ...base, kind:'long-position', a:{realMs:100,price:100}, b:{realMs:200,price:120}, stop:90, quantity:10 };
const variants: AnalysisDrawing[] = [fib,channel,long,{...long,kind:'short-position',b:{realMs:200,price:80},stop:110},{...base,kind:'hray',at:{realMs:100,price:100}}];

describe('analysis geometry and persisted contracts',()=>{
  beforeEach(()=>{ localStorage.clear(); useDrawingsStore.getState().__resetForTests(); });
  it('horizontal ray begins at its anchor, while extended trendline is pickable past its endpoints',()=>{
    const ray=variants[4];
    expect(hitTestDrawings(hitCoords,[ray],40,100)).toBeNull();
    expect(hitTestDrawings(hitCoords,[ray],450,100)).toBe(ray);
    const trend: Drawing={...base,kind:'trendline',a:{realMs:100,price:100},b:{realMs:200,price:200},extendLeft:true,extendRight:true};
    expect(hitTestDrawings(hitCoords,[trend],400,400)).toBe(trend);
    expect(drawingsInRect(hitCoords,[trend],{x1:390,x2:410,y1:390,y2:410})).toEqual([trend]);
  });
  it('fib ratios are retracements from the end, and reverse swaps the prices',()=>{
    const projected=projectAnalysis(fib,coords);
    expect(projected.segments.slice(0,3).map(s=>s.a.y)).toEqual([200,150,100]);
    expect(projectAnalysis({...fib,reverse:true},coords).segments.slice(0,3).map(s=>s.a.y)).toEqual([100,150,200]);
    expect(hitTestDrawings(hitCoords,[fib],450,150)).toBe(fib);
  });
  it('channel edges and midpoint remain parallel, and fill participates in picking and marquee',()=>{
    const g=projectAnalysis(channel,coords);
    expect(g.segments.map(s=>s.b.y-s.a.y)).toEqual([400,400,400]);
    expect(g.segments.map(s=>s.a.y)).toEqual([100,150,125]);
    expect(hitTestDrawings(hitCoords,[channel],175,210)).toBe(channel);
    expect(drawingsInRect(hitCoords,[channel],{x1:170,x2:180,y1:205,y2:215})).toEqual([channel]);
  });
  it('both position directions compute risk/reward and reject crossing stop or entry handles',()=>{
    expect(positionStats(long)).toMatchObject({risk:10,reward:20,ratio:2,loss:100,profit:200});
    expect(positionStats(variants[3] as Position)).toMatchObject({ratio:2,loss:100,profit:200});
    expect(analysisHandlePatch(long,'stop',{realMs:200,price:105})).toBeNull();
    expect(analysisHandlePatch(long,'b',{realMs:200,price:130})).toEqual({b:{realMs:200,price:130}});
    expect(validPosition({...long,stop:100})).toBe(false);
  });
  it.each(variants)('$kind round-trips storage and supports translation, cloning, undo and lock',d=>{
    saveDrawings('005930|D',[d]); expect(loadDrawings('005930|D')).toEqual([d]);
    const moved={...d,...translateDrawing(d,10,5)} as Drawing;
    expect(projectAnalysis(moved as AnalysisDrawing,coords).segments.length).toBeGreaterThan(0);
    const clone=cloneWithOffset({...d,locked:true},10,5);
    expect(clone.id).not.toBe(d.id); expect(clone.locked).toBeUndefined();
    const store=useDrawingsStore.getState(); store.add('005930|D',d);store.update('005930|D',d.id,{locked:true});
    store.update('005930|D',d.id,{color:'#ffffff'});store.remove('005930|D',d.id);
    expect(store.drawingsFor('005930|D')).toEqual([{...d,locked:true}]);
    store.undo('005930|D'); expect(store.drawingsFor('005930|D')).toEqual([d]);
    store.undo('005930|D'); expect(store.drawingsFor('005930|D')).toEqual([]);
  });
  it('hidden drawings neither hit-test nor marquee-select',()=>{
    expect(hitTestDrawings(hitCoords,[{...fib,hidden:true}],200,150)).toBeNull();
    expect(drawingsInRect(hitCoords,[{...channel,hidden:true}],{x1:0,x2:500,y1:0,y2:500})).toEqual([]);
  });
  it('position labels show signed market moves for both directions',()=>{
    expect(projectAnalysis(long,coords).labels.map(l=>l.text).join(' ')).toContain('+20.00%');
    expect(projectAnalysis(long,coords).labels.map(l=>l.text).join(' ')).toContain('-10.00%');
    const short=variants[3] as Position;
    expect(projectAnalysis(short,coords).labels.map(l=>l.text).join(' ')).toContain('-20.00%');
    expect(validPosition({...long,a:{realMs:100,price:-100},b:{realMs:200,price:-80},stop:-110})).toBe(false);
  });
  it('a horizontal ray before the loaded axis uses the same clamped projection for picking',()=>{
    const ray=variants[4];
    const c={...hitCoords,realMsToCanvasX:()=>null,realMsToCanvasXClamped:()=>0};
    expect(hitTestDrawings(c,[ray],300,100)).toBe(ray);
  });
  it('an extended line cannot be selected through another pane',()=>{
    const line:Drawing={...base,kind:'trendline',a:{realMs:100,price:100},b:{realMs:200,price:200},extendRight:true};
    expect(drawingsInRect({...hitCoords,paneBounds:()=>({top:0,bottom:220})},[line],{x1:290,x2:310,y1:290,y2:310})).toEqual([]);
  });
  it('favorites, repeat and named styles survive without a storage namespace change',()=>{
    const store=useDrawingsStore.getState();
    const defaults={...store.defaults,keepDrawing:true,favorites:['hray' as const,'day-high' as const],templates:[{name:'지지',kind:'hray' as const,style:{...INITIAL_STYLE,width:3}}]};
    saveDefaults(defaults);expect(loadDefaults()).toEqual(defaults);
  });
  it('malformed new shapes are dropped without dropping valid older drawings',()=>{
    const legacy={...base,kind:'hline',price:100};
    expect(normalizeItems([legacy,{...fib,a:null},{...long,stop:110},{...channel,c:undefined}])).toEqual([legacy]);
    expect(normalizeItems([{...fib,levels:[0,0.5,0.5,NaN,'bad']}])[0]).toMatchObject({levels:[0,0.5]});
  });
  it('coordinates parse KST, preserve precision, and reject invalid position levels atomically',()=>{
    const values=Object.fromEntries(drawingCoordinates(long).flatMap(c=>[
      ...(c.price==null?[]:[[`${c.key}.price`,String(c.price)]]),...(c.realMs==null?[]:[[`${c.key}.realMs`,'2026-10-30T09:00:00']]),
    ]));
    const patch=coordinatePatch(long,{...values,'a.price':'100.125'});
    expect(patch).toMatchObject({a:{price:100.125,realMs:Date.parse('2026-10-30T00:00:00Z')}});
    expect(coordinatePatch(long,{...values,'stop.price':'110'})).toBeNull();
    expect(coordinatePatch(long,{...values,'a.price':''})).toBeNull();
  });
});

describe('analysis gestures',()=>{
  function context(kind:AnalysisDraft['kind']='fib') {
    const ref:{current:AnalysisDraft|null}={current:null};
    const ctx={px:100,py:100,pointerId:1,analysisDraft:ref,defaults:INITIAL_STYLE,paneIdAtY:()=> 'candle',
      pixelToData:(x:number,y:number)=>({realMs:x,price:y}),capturePointer:vi.fn(),releasePointer:vi.fn(),requestRedraw:vi.fn(),add:vi.fn()} as unknown as ToolCtx;
    return {ctx,tool:analysisTool(kind,kind)};
  }
  it('channel commits only after the width click, with no extra pointerup commit',()=>{
    const {ctx,tool}=context('channel');tool.onPointerDown!(ctx);
    ctx.px=200;ctx.py=200;tool.onPointerUp!(ctx);
    expect(ctx.add).not.toHaveBeenCalled();expect(ctx.analysisDraft?.current?.phase).toBe('width');
    ctx.px=150;ctx.py=220;tool.onPointerMove!(ctx);tool.onPointerDown!(ctx);tool.onPointerUp!(ctx);
    expect(ctx.add).toHaveBeenCalledTimes(1);expect(ctx.add).toHaveBeenCalledWith(expect.objectContaining({kind:'channel',c:{realMs:150,price:220}}));
    expect(ctx.analysisDraft?.current).toBeNull();
  });
  it('position preview and commit use the same geometry and 2:1 initial risk/reward',()=>{
    const {ctx,tool}=context('short-position');tool.onPointerDown!(ctx);ctx.px=200;ctx.py=150;tool.onPointerMove!(ctx);
    const preview=drawingFromAnalysisDraft(ctx.analysisDraft!.current!);tool.onPointerUp!(ctx);
    expect(ctx.add).toHaveBeenCalledWith({...preview,id:expect.any(String)});
    expect(positionStats(preview as Position).ratio).toBe(2);
  });
  it('ray creates one anchored drawing',()=>{
    const {ctx}=context();horizontalRayTool.onPointerDown!(ctx);
    expect(ctx.add).toHaveBeenCalledWith(expect.objectContaining({kind:'hray',at:{realMs:100,price:100}}));
  });
  it('fib draft seeds independent ratios',()=>{
    const {ctx,tool}=context();tool.onPointerDown!(ctx);ctx.px=200;ctx.py=200;tool.onPointerUp!(ctx);
    expect(ctx.add).toHaveBeenCalledWith(expect.objectContaining({levels:[...FIB_LEVELS]}));
  });
});
