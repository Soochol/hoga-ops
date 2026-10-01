import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useRangeSyncFollow } from './useRangeSync';
import { useLiveCursorStore } from './useLiveCursorStore';
import { createVirtualAxis } from '../util/virtualAxis';
import { useSecondHistory } from '../api/secondHistory';
import { todayKstYyyymmdd } from './liveDateTime';

const fixture = vi.hoisted(() => {
  let visits = 0;
  const t = Date.parse('2026-09-30T09:00:00+09:00');
  const bars = Array.from({length:10000},(_,i)=>({t_ms:t+i*1000,open:100,high:110,low:90,close:105,volume:10,count:1,trade_value:1000}));
  return { get visits() {return visits;}, history: {data:{pages:[{fromMs:t,result:{get bars(){visits++;return bars;}}}]}}, live: {data:{bars:[bars.at(-1)!]}}, bars };
});
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({data:{dates:[]},isPending:false}), useInfiniteQuery: () => fixture.history }));
vi.mock('../api/secondAggregates', () => ({useSecondAggregates: () => fixture.live}));
const axis = createVirtualAxis([]);

it.each([false,true])('range follower does not render for disabled or unrelated range publications, enabled=%s', enabled => {
  useLiveCursorStore.getState().resetCursor(); let renders=0;
  const applied=vi.fn();
  const chart={timeScale:()=>({setVisibleLogicalRange:applied})};
  const view=renderHook(()=>{renders++;useRangeSyncFollow({chart:chart as never,axis,candleCount:100,enabled,myWindowId:'group-two',myGroup:2,myCode:'005930',myTimeframe:'1m',allowCrossSymbol:false});});
  const baseline=renders;
  for(let i=0;i<60;i++) act(()=>useLiveCursorStore.getState().setSyncRange(i*60000,(i+20)*60000,{windowId:'other',group:1,code:'005930',timeframe:'1m'},{anchorMs:i*60000,fromBars:-20,toBars:0}));
  expect(renders-baseline).toBe(0);
  expect(applied).not.toHaveBeenCalled();
  view.unmount();useLiveCursorStore.getState().resetCursor();
});

it('does not reread unchanged 10000-bar history on live tail refresh',()=>{
  const view=renderHook(()=>useSecondHistory('005930','KRX',todayKstYyyymmdd(),1,false));
  const baseline=fixture.visits;
  for(let i=0;i<60;i++) {
    fixture.live={data:{bars:[{...fixture.bars.at(-1)!,close:106+i}]}};
    view.rerender();
  }
  expect(fixture.visits-baseline).toBe(0);
  expect(view.result.current.bars).toHaveLength(10000);
  view.unmount();
});
