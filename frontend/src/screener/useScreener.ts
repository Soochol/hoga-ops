import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { runScan, type ScanRequest, type ScreenerResponse } from '../api/screener';
import { activeRunId, needsDailyPreparation, needsPreparation, preparationKey, runPreparedScan, type ScreenerRun } from '../api/screenerRuns';
import { ContinuousClient, hasContinuousVolume } from './continuousClient';

type ScanState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'success'; data: ScreenerResponse }
  | { kind: 'error'; error: Error };
type ScanOutcome = 'success' | 'failed' | 'retired';
type ResultEvent = {
  result: ScreenerResponse; request: ScanRequest;
  phase: 'progress' | 'complete'; background: boolean;
};
type RunCommand = { mode: 'once' | 'monitor'; background?: boolean; onSuccess?: () => void };
type MonitorLease = { client: ContinuousClient; timer: number };
type Scope = {
  key: string; request: ScanRequest; continuous: boolean;
  invocation: Invocation | null; lease: MonitorLease | null;
};
type Invocation = {
  scope: Scope; controller: AbortController; settled: boolean;
  command: RunCommand;
  operation: { kind: 'once'; released: Promise<void> } | { kind: 'monitor'; lease: MonitorLease | null };
};

function releaseLease(scope: Scope): Promise<void> {
  const lease = scope.lease;
  scope.lease = null;
  if (!lease) return Promise.resolve();
  window.clearInterval(lease.timer);
  return lease.client.stop();
}

export const useScreener = ({ continuous = false, identity = '', request, onResult }: {
  continuous?: boolean; identity?: string; request?: ScanRequest;
  onResult?: (event: ResultEvent) => void;
}) => {
  const scopeKey = request ? JSON.stringify([identity, request]) : null;
  const current = useRef<Scope | null>(null);
  const observed = useRef<Invocation | null>(null);
  const publisher = useRef({ scopeKey, onResult });
  const [preparation, setPreparation] = useState<{ ticket: Invocation; run: ScreenerRun } | null>(null);
  const isCurrent = useCallback((ticket: Invocation) => current.current === ticket.scope
    && ticket.scope.invocation === ticket && !ticket.controller.signal.aborted, []);

  const mutation = useMutation({ mutationFn: async (ticket: Invocation) => {
    const body = ticket.scope.request;
    const check = () => {
      if (!isCurrent(ticket)) throw new DOMException('검색 조건 변경됨', 'AbortError');
    };
    const publish = (result: ScreenerResponse, phase: ResultEvent['phase']) => {
      check();
      if (publisher.current.scopeKey === ticket.scope.key) {
        publisher.current.onResult?.({ result, request: body, phase, background: !!ticket.command.background });
      }
    };
    try {
      check();
      const lease = ticket.operation.kind === 'monitor' ? ticket.operation.lease : null;
      if (ticket.operation.kind === 'once') { await ticket.operation.released; check(); }
      let result: ScreenerResponse;
      if (needsPreparation(body) && (!lease || needsDailyPreparation(body))) {
        result = await runPreparedScan(body, ticket.controller.signal, run => {
          check();
          setPreparation({ ticket, run });
          if (run.result) publish(run.result, 'progress');
        }, activeRunId(body));
        check();
        if (lease) result = await lease.client.scan(body);
      } else {
        result = lease ? await lease.client.scan(body) : await runScan(body);
      }
      publish(result, 'complete');
      check();
      ticket.command.onSuccess?.();
      return result;
    } finally {
      ticket.settled = true;
    }
  } });
  const { reset, mutateAsync } = mutation;
  const retire = useCallback((ticket: Invocation, preserveSettled = false) => {
    ticket.controller.abort();
    if (ticket.scope.invocation === ticket) ticket.scope.invocation = null;
    if (observed.current === ticket && !(preserveSettled && ticket.settled)) {
      observed.current = null;
      reset();
    }
  }, [reset]);
  const stopMonitoring = useCallback((scope: Scope) => {
    if (scope.invocation?.operation.kind === 'monitor') retire(scope.invocation, true);
    void releaseLease(scope).catch(() => {});
  }, [retire]);

  useLayoutEffect(() => {
    if (!request || !scopeKey) return;
    const scope: Scope = { key: scopeKey, request, continuous, invocation: null, lease: null };
    current.current = scope;
    return () => {
      if (scope.invocation) retire(scope.invocation);
      if (current.current === scope) current.current = null;
      void releaseLease(scope).catch(() => {});
    };
  }, [scopeKey, retire]);
  useLayoutEffect(() => { publisher.current = { scopeKey, onResult }; });
  useLayoutEffect(() => {
    const scope = current.current;
    if (!scope) return;
    if (scope.continuous && !continuous) stopMonitoring(scope);
    scope.continuous = continuous;
  }, [continuous, scopeKey, stopMonitoring]);

  const run = useCallback(async (command: RunCommand): Promise<ScanOutcome> => {
    const scope = current.current;
    if (!scope) return 'retired';
    if (scope.invocation) retire(scope.invocation);
    let operation: Invocation['operation'];
    if (command.mode === 'once') operation = { kind: 'once', released: releaseLease(scope) };
    else {
      if (hasContinuousVolume(scope.request) && scope.request.universe.scopes?.length && !scope.lease) {
        const client = new ContinuousClient();
        scope.lease = { client, timer: window.setInterval(() => { void client.heartbeat().catch(() => {}); }, 30_000) };
      }
      operation = { kind: 'monitor', lease: scope.lease };
    }
    const ticket: Invocation = { scope, operation, command, controller: new AbortController(), settled: false };
    scope.invocation = ticket;
    observed.current = ticket;
    setPreparation(null);
    try {
      await mutateAsync(ticket);
      return isCurrent(ticket) ? 'success' : 'retired';
    } catch {
      return isCurrent(ticket) ? 'failed' : 'retired';
    }
  }, [isCurrent, mutateAsync, retire]);

  const resumeKey = request ? preparationKey(request) : '';
  useEffect(() => {
    const scope = current.current;
    if (scope && !scope.invocation && activeRunId(scope.request)) {
      void run({ mode: scope.continuous ? 'monitor' : 'once', background: true });
    }
  }, [scopeKey, resumeKey, run]);

  const ticket = observed.current;
  const visible = ticket && ticket.scope === current.current && ticket.scope.key === scopeKey
    && mutation.variables === ticket;
  let state: ScanState = { kind: 'idle' };
  if (visible) {
    if (mutation.isPending) state = { kind: 'pending' };
    else if (mutation.isSuccess) state = { kind: 'success', data: mutation.data };
    else if (mutation.isError) state = { kind: 'error', error: mutation.error };
  }
  return {
    state, scopeKey, run,
    preparation: visible && preparation?.ticket === ticket ? preparation.run : null,
    acceptsVolumeEvent: (id?: string) => current.current?.lease?.client.acceptsEvent(id) ?? false,
  };
};
