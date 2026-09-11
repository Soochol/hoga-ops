import {afterEach, expect, it, vi} from 'vitest';
import {act, renderHook, waitFor} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {useQuoteByCode} from './liveQuotes';
import * as client from './client';
import * as ws from './ws';
import {seedSymbolMaster} from '../live/seedSymbolMaster';
import type {LiveVenueOption} from '../state/liveVenue';
const code = '005930';
const start = Date.UTC(2026,8,14,1);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function setup() {
  let now = start;
  vi.spyOn(Date,'now').mockImplementation(()=>now);
  const qc = new QueryClient({defaultOptions:{queries:{retry:false}}});
  seedSymbolMaster(qc);
  const wrapper = ({children}:{children:React.ReactNode}) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return {qc,wrapper,advance:(ms:number)=>{now+=ms;}};
}
const quote = (price:number, extra:Record<string,unknown>={}) => ({phase:'open',quotes:[{code,price,change_pct:10,change_won:9,...extra}]});

it('clears the previous venue placeholder and does not inherit its change fields',async()=>{
  const env=setup();
  let resolveNext!: (value:unknown)=>void;
  vi.spyOn(client,'apiCall').mockResolvedValueOnce(quote(100)).mockImplementation(()=>new Promise(resolve=>{resolveNext=resolve;}));
  const {result,rerender}=renderHook((venue:LiveVenueOption)=>useQuoteByCode([code],venue),{wrapper:env.wrapper,initialProps:'KRX' as LiveVenueOption});
  await waitFor(()=>expect(result.current.get(code)?.price).toBe(100));
  rerender('NXT');
  expect(result.current.get(code)).toBeUndefined();
  await act(async()=>resolveNext(quote(200,{change_pct:null,change_won:null,change_pct_source:'unavailable'})));
  await waitFor(()=>expect(result.current.get(code)?.price).toBe(200));
  expect(result.current.get(code)?.change_pct).toBeNull();
  expect(result.current.get(code)?.change_won).toBeNull();
});

it.each([false,true])('later REST replaces an old tick unless stale=%s',async(stale)=>{
  const env=setup();
  let receive!: Parameters<typeof ws.subscribeLiveLatest>[1];
  vi.spyOn(ws,'subscribeLiveLatest').mockImplementation((_code,handler)=>{receive=handler;return ()=>{};});
  const api=vi.spyOn(client,'apiCall').mockResolvedValue(quote(100));
  const {result}=renderHook(()=>useQuoteByCode([code]),{wrapper:env.wrapper});
  await waitFor(()=>expect(result.current.get(code)?.price).toBe(100));
  env.advance(1000);
  act(()=>receive({kind:'trade',venue:'KRX',t_ms:start+1000,prev_close:100,trades:[{price:110,qty:1,side:1}]}));
  await waitFor(()=>expect(result.current.get(code)?.price).toBe(110));
  env.advance(1000);
  api.mockResolvedValue(quote(200,{stale}));
  await act(async()=>{await env.qc.refetchQueries({queryKey:['live-quotes']});});
  await waitFor(()=>expect(result.current.get(code)?.price).toBe(stale?110:200));
});

it('retains ticks arriving during REST and rejects out-of-order ticks',async()=>{
  const env=setup();
  let receive!: Parameters<typeof ws.subscribeLiveLatest>[1];
  vi.spyOn(ws,'subscribeLiveLatest').mockImplementation((_code,handler)=>{receive=handler;return ()=>{};});
  const api=vi.spyOn(client,'apiCall').mockResolvedValue(quote(100));
  const {result}=renderHook(()=>useQuoteByCode([code]),{wrapper:env.wrapper});
  await waitFor(()=>expect(result.current.get(code)?.price).toBe(100));
  let finish!: (value:unknown)=>void;
  api.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  env.advance(1000);
  let refresh!: Promise<void>;
  act(()=>{refresh=env.qc.refetchQueries({queryKey:['live-quotes']});});
  env.advance(1000);
  act(()=>receive({kind:'trade',venue:'KRX',t_ms:start+2000,prev_close:100,trades:[{price:300,qty:1,side:1}]}));
  await waitFor(()=>expect(result.current.get(code)?.price).toBe(300));
  await act(async()=>{finish(quote(200));await refresh;});
  expect(result.current.get(code)?.price).toBe(300);
  act(()=>receive({kind:'trade',venue:'KRX',t_ms:start+1000,prev_close:100,trades:[{price:50,qty:1,side:1}]}));
  expect(result.current.get(code)?.price).toBe(300);
});

it('does not retain previous-day quotes or change fields after midnight',async()=>{
  const env=setup();
  const api=vi.spyOn(client,'apiCall').mockResolvedValue(quote(100));
  const {result,rerender}=renderHook(()=>useQuoteByCode([code]),{wrapper:env.wrapper});
  await waitFor(()=>expect(result.current.get(code)?.price).toBe(100));
  let finish!: (value:unknown)=>void;
  api.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  env.advance(86400_000);
  rerender();
  expect(result.current.get(code)).toBeUndefined();
  await act(async()=>finish(quote(200,{change_pct:null,change_won:null,change_pct_source:'unavailable'})));
  await waitFor(()=>expect(result.current.get(code)?.price).toBe(200));
  expect(result.current.get(code)?.change_pct).toBeNull();
});


it.each([100, 110])('fresh WS price %s clears REST staleness, including unchanged prices', async (price) => {
  const env = setup();
  let receive!: Parameters<typeof ws.subscribeLiveLatest>[1];
  vi.spyOn(ws, 'subscribeLiveLatest').mockImplementation((_code, handler) => { receive = handler; return () => {}; });
  vi.spyOn(client, 'apiCall').mockResolvedValue(quote(100, {stale:true, stale_reason:'upstream_error'}));
  const {result} = renderHook(() => useQuoteByCode([code]), {wrapper:env.wrapper});
  await waitFor(() => expect(result.current.get(code)?.stale).toBe(true));
  env.advance(1000);
  act(() => receive({kind:'trade', venue:'KRX', t_ms:start+1000, prev_close:100, trades:[{price, qty:1, side:1}]}));
  await waitFor(() => expect(result.current.get(code)?.stale).toBe(false));
  expect(result.current.get(code)?.price).toBe(price);
  expect(result.current.get(code)?.stale_reason).toBeNull();
});

it.each([-86400_000, 86400_000, Number.NaN])('rejects off-day or invalid tick time %s before a valid first tick', async (offset) => {
  vi.useFakeTimers({shouldAdvanceTime:true});
  const env = setup();
  let receive!: Parameters<typeof ws.subscribeLiveLatest>[1];
  vi.spyOn(ws, 'subscribeLiveLatest').mockImplementation((_code, handler) => { receive = handler; return () => {}; });
  vi.spyOn(client, 'apiCall').mockResolvedValue(quote(100));
  const {result} = renderHook(() => useQuoteByCode([code]), {wrapper:env.wrapper});
  await waitFor(() => expect(result.current.get(code)?.price).toBe(100));
  act(() => {
    receive({kind:'trade', venue:'KRX', t_ms:start+offset, prev_close:100, trades:[{price:50, qty:1, side:1}]});
    vi.advanceTimersByTime(200);
  });
  expect(result.current.get(code)?.price).toBe(100);
  act(() => {
    receive({kind:'trade', venue:'KRX', t_ms:start, prev_close:100, trades:[{price:110, qty:1, side:1}]});
    vi.advanceTimersByTime(200);
  });
  expect(result.current.get(code)?.price).toBe(110);
});
