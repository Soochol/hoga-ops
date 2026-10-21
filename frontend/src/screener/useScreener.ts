import { useEffect, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { runScan, type ScanRequest } from '../api/screener';
import { ContinuousClient, hasContinuousVolume } from './continuousClient';

export const useScreener = ({ continuous = false, anchor = '' }: { continuous?: boolean; anchor?: string } = {}) => {
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
  const mutation = useMutation({ mutationFn: (body: ScanRequest) => continuous && hasContinuousVolume(body) && !!body.universe.scopes?.length
    ? client.current!.scan(body) : runScan(body) });
  return { ...mutation, acceptsVolumeEvent: (id?: string) => client.current!.acceptsEvent(id) };
};
