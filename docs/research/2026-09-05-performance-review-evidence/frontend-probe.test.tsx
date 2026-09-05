import { afterEach, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLiveSeries } from './liveSeries';
import { usePatternSearch, DEFAULT_FILTERS } from '../pattern/usePatternSearch';
import { DEFAULT_CONDITIONS } from '../pattern/patternConditions';
import * as client from './client';
import { LiveSnapshotBuffer } from '../live/liveSnapshotBuffer';
import { installFakeWebSocket, fakeSockets } from '../test/fakeWebSocket';
import { __resetForTests as resetWs } from './ws';

afterEach(() => { cleanup(); resetWs(); vi.restoreAllMocks(); });
function setup() {
  const qc = new QueryClient({ defaultOptions:{ queries:{retry:false,gcTime:0} } });
  return { qc, wrapper:({children}:{children:React.ReactNode}) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider> };
}

it('measures duplicate processing for eight views of the same code', async () => {
  installFakeWebSocket(); resetWs();
  vi.spyOn(client,'wsUrl').mockResolvedValue('ws://localhost:8080/api/ws');
  const api = vi.spyOn(client,'apiCall').mockImplementation(async (path) =>
    path.startsWith('/api/live/series') ? {
      code:'005930',date:'20260905',session_open_ms:1000,session_close_ms:null,is_open:true,
      snapshots:[],trades:[],brokers:[],programs:[],after_hours:[],expected:[],
    } : []);
  const { qc,wrapper }=setup();
  const push=vi.spyOn(LiveSnapshotBuffer.prototype,'push');
  const hooks=Array.from({length:8},()=>renderHook(()=>useLiveSeries('005930','KRX'),{wrapper}));
  await waitFor(()=>expect(hooks.every(h=>!!h.result.current.initial)).toBe(true));
  await waitFor(()=>expect(fakeSockets.length).toBe(1));
  const sock=fakeSockets[0];sock.open();
  act(()=>sock.message({ch:'live',code:'005930',data:{t_ms:1_000_000,kind:'ob',venue:'KRX'}}));
  await waitFor(()=>expect(hooks.every(h=>h.result.current.ob.length===1)).toBe(true));
  const result={views:8,sockets:fakeSockets.length,
    seriesFetches:api.mock.calls.filter(([p])=>p.startsWith('/api/live/series')).length,
    subscribeFrames:sock.parsedSent().filter((x:any)=>x.action==='subscribe').length,
    bufferPushes:push.mock.calls.length,
    distinctArrays:new Set(hooks.map(h=>h.result.current.ob)).size};
  console.log('LIVE_DUPLICATION',JSON.stringify(result));
  writeFileSync('/tmp/hoga-performance-review-20260905/live-duplication.json',JSON.stringify(result));
  expect(result).toEqual({views:8,sockets:1,seriesFetches:1,subscribeFrames:1,bufferPushes:8,distinctArrays:8});
  for(const h of hooks)h.unmount();qc.clear();
});

it.each(['now', 'history'] as const)('measures abandoned %s pattern requests after scrubbing and unmount', async(mode)=>{
  const pending:Array<()=>void>=[];
  const api=vi.spyOn(client,'apiCall').mockImplementation(()=>new Promise(resolve=>pending.push(()=>resolve({results:[]}))));
  const {qc,wrapper}=setup();
  const {rerender,unmount}=renderHook(({length})=>usePatternSearch({
    code:'005930',mode,length,filters:DEFAULT_FILTERS,conditions:DEFAULT_CONDITIONS,
  }),{initialProps:{length:5},wrapper});
  await waitFor(()=>expect(api).toHaveBeenCalledTimes(1));
  for(let length=6;length<=10;length++){
    rerender({length});
    await waitFor(()=>expect(api).toHaveBeenCalledTimes(length-4));
  }
  unmount();
  const result={requests:api.mock.calls.length,
    requestsWithAbortSignal:api.mock.calls.filter(([,init])=>!!init?.signal).length,
    fetchingAfterUnmount:qc.getQueryCache().getAll().filter(q=>q.state.fetchStatus==='fetching').length};
  console.log('PATTERN_CANCELLATION',JSON.stringify(result));
  writeFileSync(`/tmp/hoga-performance-review-20260905/pattern-cancellation-${mode}.json`,JSON.stringify(result));
  expect(result).toEqual({requests:6,requestsWithAbortSignal:0,fetchingAfterUnmount:6});
  await act(async()=>{for(const resolve of pending)resolve();});qc.clear();
});
