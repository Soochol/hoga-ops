import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { runScan, type ScanRequest, type ScreenerResponse } from '../api/screener';
import { activeRunId, needsPreparation, preparationKey, runPreparedScan, type ScreenerRun } from '../api/screenerRuns';
import { ContinuousClient, hasContinuousVolume } from './continuousClient';

export const useScreener = ({ continuous = false, anchor = '', request, onProgress }: {
  continuous?: boolean; anchor?: string; request?: ScanRequest;
  onProgress?: (result: ScreenerResponse, request: ScanRequest) => void;
} = {}) => {
  const [preparation, setPreparation] = useState<ScreenerRun | null>(null);
  const active = useRef<{ controller: AbortController; anchor: string; preparing: boolean } | null>(null);
  const current = useRef({ anchor, onProgress });
  current.current = { anchor, onProgress };
  const client = useRef<ContinuousClient | null>(null);
  client.current ??= new ContinuousClient();
  useEffect(() => {
    const owner = client.current!;
    if (!continuous) { void owner.stop().catch(() => {}); return; }
    const timer = window.setInterval(() => { void owner.heartbeat().catch(() => {}); }, 30_000);
    return () => {
      window.clearInterval(timer);
      void owner.stop().catch(() => {});
    };
  }, [continuous, anchor]);
  const mutation = useMutation({ mutationFn: async (body: ScanRequest) => {
    active.current?.controller.abort();
    const controller = new AbortController();
    const ownAnchor = current.current.anchor;
    const preparing = needsPreparation(body);
    active.current = { controller, anchor: ownAnchor, preparing };
    const check = () => {
      controller.signal.throwIfAborted();
      if (active.current?.controller !== controller || preparing && ownAnchor !== current.current.anchor) {
        throw new DOMException('검색 조건 변경됨', 'AbortError');
      }
    };
    const liveVolume = continuous && hasContinuousVolume(body) && !!body.universe.scopes?.length;
    let result: ScreenerResponse;
    if (preparing) {
      result = await runPreparedScan(body, controller.signal, run => {
        check();
        setPreparation(run);
        if (run.result) current.current.onProgress?.(run.result, body);
      }, activeRunId(body));
      check();
      // Preparation must retain the existing scoped minute-monitor owner.
      if (liveVolume) result = await client.current!.scan(body);
    } else {
      setPreparation(null);
      result = liveVolume
        ? await client.current!.scan(body) : await runScan(body);
    }
    check();
    return result;
  } });
  const resumeKey = request ? preparationKey(request) : '';
  const resume = useRef(mutation.mutateAsync);
  resume.current = mutation.mutateAsync;
  const requestRef = useRef(request);
  requestRef.current = request;
  const reset = mutation.reset;
  useEffect(() => {
    setPreparation(null);
    if (!active.current || active.current.preparing) reset();
    const body = requestRef.current;
    if (body && activeRunId(body)) {
      void resume.current(body).then(result => {
        if (current.current.anchor === anchor) current.current.onProgress?.(result, body);
      }).catch(() => {});
    }
    return () => {
      if (active.current?.anchor === anchor && active.current.preparing) active.current.controller.abort();
    };
    // Only a persisted, previously started run may resume here. Editing a new
    // request never starts collection. Equivalent renders must not restart polls.
  }, [anchor, resumeKey, reset]);
  return { ...mutation, preparation, acceptsVolumeEvent: (id?: string) => client.current!.acceptsEvent(id) };
};
