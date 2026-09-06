import { describe, expect, it, vi } from 'vitest';
import { createMovingAverageProjection, createDailyMovingAverageProjection } from './maProjection';
import { computeSMA, selectSource, type MASource } from './movingAverage';
import { computeDailyMaByDate } from './dailyMovingAverage';
import { createVirtualAxis } from '../../util/virtualAxis';
import type { Candle } from '../../api/types';
const OPEN = Date.UTC(2026, 5, 1);
const DAY = 86_400_000;
const axis = createVirtualAxis([0,1].map(i => ({date:`2026060${i+1}`,sessionOpenMs:OPEN+i*DAY,sessionCloseMs:OPEN+i*DAY+390*60000})));
const candle = (ts_ms:number,close:number):Candle => ({ts_ms,open:close*.91,high:close*1.1,low:close*.9,close,vol_a:1,vol_b:2});
const candles = Array.from({length:30},(_,i)=>candle(OPEN+i*60000,(i+1)/3));
const cfg = (source:MASource='close',period=5)=>({id:'a',enabled:true,period,source});
function expected(cs:readonly Candle[], source:MASource, period:number) {
 const inside=cs.filter(c=>axis.contains(c.ts_ms)); const sma=computeSMA(inside.map(c=>selectSource(c,source)),period);
 return inside.map((c,i)=>sma[i]===null?{time:axis.toVirtual(c.ts_ms)/1000}:{time:axis.toVirtual(c.ts_ms)/1000,value:sma[i]});
}
describe('incremental MA projection',()=>{
 it.each<MASource>(['close','open','high','low','hl2','hlc3','ohlc4'])('%s matches full SMA after append, correction, prepend, shrink and slot changes',source=>{
  const project=createMovingAverageProjection();
  const variants=[candles,[...candles,candle(OPEN+30*60000,12.3)],candles.map((c,i)=>i===15?{...c,close:27}:c),[candle(OPEN-60000,400),...candles],candles.slice(0,8),candles];
  for(const period of [1,5,60,0]) for(const cs of variants) expect(project(cs,axis,[cfg(source,period)]).get('a')).toEqual(expected(cs,source,period));
  expect(project(candles,axis,[{...cfg(source),enabled:false}]).size).toBe(0);
  expect(project(candles,axis,[cfg(source)]).get('a')).toEqual(expected(candles,source,5));
 });
 it('reuses the past and shares coordinate work across six slots',()=>{
  const project=createMovingAverageProjection(); const contains=vi.fn(axis.contains),toVirtual=vi.fn(axis.toVirtual);
  const measured={...axis,contains,toVirtual}; const configs=[1,5,10,15,20,25].map((period,i)=>({...cfg('close',period),id:String(i)}));
  const first=project(candles,measured,configs);
  expect(contains).toHaveBeenCalledTimes(candles.length);expect(toVirtual).toHaveBeenCalledTimes(candles.length);
  contains.mockClear();toVirtual.mockClear();
  const next=project([...candles.slice(0,-1),{...candles.at(-1)!,close:99}],measured,configs);
  expect(contains).toHaveBeenCalledTimes(1);expect(toVirtual).toHaveBeenCalledTimes(1);
  expect(next.get('1')![10]).toBe(first.get('1')![10]);
  expect(next.get('1')).toEqual(expected([...candles.slice(0,-1),{...candles.at(-1)!,close:99}],'close',5));
  const remapped=createVirtualAxis([{date:'20260601',sessionOpenMs:OPEN,sessionCloseMs:OPEN+390*60000}],OPEN+10000);
  expect(project(candles,remapped,configs).get('1')![0].time).toBe(remapped.toVirtual(OPEN)/1000);
 });
});

describe('daily MA projection',()=>{
 it('reuses past points but updates every candle of the changed day; daily corrections invalidate values',()=>{
  const project=createDailyMovingAverageProjection();
  const cs=[...candles,...candles.map(c=>({...c,ts_ms:c.ts_ms+DAY}))];
  const daily=[{t_ms:OPEN,open:100,high:100,low:100,close:100,volume:1}];
  const config=[cfg('close',2)];
  const first=project(cs,axis,config,daily,'20260602',200).get('a')!;
  const next=project(cs,axis,config,daily,'20260602',300).get('a')!;
  expect(next[0]).toBe(first[0]);
  expect(next.slice(30).every(p=>'value'in p&&p.value===200)).toBe(true);
  const corrected=[{...daily[0],close:200}];
  const actual=project(cs,axis,config,corrected,'20260602',300).get('a');
  const byDate=computeDailyMaByDate(corrected,2,'close','20260602',300);
  expect(actual).toEqual(cs.map(c=>{const date=axis.segments[axis.findByReal(c.ts_ms)]?.date;const value=byDate.get(date);const time=axis.toVirtual(c.ts_ms)/1000;return value==null?{time}:{time,value};}));
  expect(project(cs,axis,[],daily,'20260602',300).size).toBe(0);
 });
});
