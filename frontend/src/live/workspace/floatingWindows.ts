import { useEffect } from 'react';
import { create } from 'zustand';
import { commitFloatingWorkspace, useWorkspaceStore } from '../../state/workspace';
import { useLivePageStore } from '../../state/livePage';
import { useLiveCursorStore } from '../useLiveCursorStore';
import {
  readGroupChartLinks, readRemoteGroupChartLinks, receiveFloatingChartLinks, subscribeGroupChartLinks, type GroupChartLink,
} from './groupChartLinkSource';
import { applyFloatingChanges, floatingChanges, floatingParams, type FloatingWorkspace, type FloatingChange } from './floatingProtocol';

export const useFloatingWindows = create<{
  entries: Record<string, 'opening' | 'floating'>;
  ready: boolean;
  error: string | null;
}>(() => ({ entries: {}, ready: false, error: null }));

type Cursor = ReturnType<typeof cursorSnapshot>;
type Message =
  | { type: 'hello' | 'ready' | 'dock' | 'focus' }
  | { type: 'snapshot'; workspace: FloatingWorkspace; links: GroupChartLink[]; cursor: Cursor }
  | { type: 'changes'; changes: FloatingChange[] }
  | { type: 'links'; links: GroupChartLink[] }
  | { type: 'cursor'; cursor: Partial<Cursor> };
interface Entry { token: string; channel: BroadcastChannel; popup?: Window; timeout: ReturnType<typeof setTimeout>; stop: () => void }
const entries = new Map<string, Entry>();
let childChannel: BroadcastChannel | null = null;
let sendSnapshots: (() => void) | null = null;
let receiving = false;

function workspaceSnapshot(): FloatingWorkspace {
  const { windows, zOrder, groupSymbols, chartRuntime } = useWorkspaceStore.getState();
  const { savedRangeFocus, savedRangeRequestSeq } = useLivePageStore.getState();
  return { windows: Object.fromEntries(windows.map(win => [win.id, win])), zOrder, groupSymbols, chartRuntime,
    savedView: { focus: savedRangeFocus, requestSeq: savedRangeRequestSeq } };
}
function applyWorkspace(snapshot: FloatingWorkspace, persist = false) {
  commitFloatingWorkspace(snapshot, persist);
  const current = useLivePageStore.getState();
  if (JSON.stringify(current.savedRangeFocus) !== JSON.stringify(snapshot.savedView.focus)
    || current.savedRangeRequestSeq !== snapshot.savedView.requestSeq)
    useLivePageStore.setState({ savedRangeFocus: snapshot.savedView.focus, savedRangeRequestSeq: snapshot.savedView.requestSeq });
}
function cursorSnapshot(state = useLiveCursorStore.getState()) {
  const { sidebarCursorMs, sidebarCursorOrigin, syncCursorMs, syncCursorOrigin, syncRange, jumpRequest, jumpSeqLast } = state;
  return { sidebarCursorMs, sidebarCursorOrigin, syncCursorMs, syncCursorOrigin, syncRange, jumpRequest, jumpSeqLast };
}
function cursorChanges(before: Cursor, after: Cursor): Partial<Cursor> {
  return Object.fromEntries((Object.keys(after) as (keyof Cursor)[])
    .filter(key => !Object.is(before[key], after[key])).map(key => [key, after[key]]));
}
function send(channel: BroadcastChannel, message: Message) { channel.postMessage(message); }
function receive(action: () => void) {
  const previous = receiving;
  receiving = true;
  try { action(); } finally { receiving = previous; }
}
function setEntry(id: string, value?: 'opening' | 'floating') {
  useFloatingWindows.setState(state => {
    const next = { ...state.entries };
    if (value) next[id] = value; else delete next[id];
    return { entries: next };
  });
}

export function dockFloatingWindow(id: string): void {
  if (floatingParams()) { if (childChannel) send(childChannel, { type: 'dock' }); window.close(); return; }
  const entry = entries.get(id);
  if (!entry) return;
  send(entry.channel, { type: 'dock' });
  clearTimeout(entry.timeout);
  entry.stop();
  entry.channel.close();
  entry.popup?.close();
  entries.delete(id);
  void window.hogaDesktop?.controls?.closeFloating?.(entry.token).catch(() => {});
  receive(() => receiveFloatingChartLinks(readRemoteGroupChartLinks().filter(link => link.windowId !== id)));
  useLiveCursorStore.getState().resetCursorFrom(id);
  setEntry(id);
}

export function focusFloatingWindow(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  entry.popup?.focus();
  send(entry.channel, { type: 'focus' });
}

export function detachFloatingWindow(id: string): void {
  if (floatingParams()) { dockFloatingWindow(id); return; }
  if (entries.has(id)) { focusFloatingWindow(id); return; }
  const ws = useWorkspaceStore.getState();
  const win = ws.windows.find(item => item.id === id);
  if (!win || !sendSnapshots) return;
  useFloatingWindows.setState({ error: null });
  const token = crypto.randomUUID();
  const url = new URL('/live', window.location.origin);
  url.searchParams.set('floating', token);
  url.searchParams.set('window', id);
  const channel = new BroadcastChannel(`live-floating:${token}`);
  const timeout = setTimeout(() => {
    if (useFloatingWindows.getState().entries[id] !== 'opening') return;
    dockFloatingWindow(id);
    useFloatingWindows.setState({ error: '독립 창을 열지 못했습니다. 팝업 허용 설정을 확인하고 다시 시도하세요.' });
  }, 15_000);
  entries.set(id, { token, channel, timeout, stop: () => {} });
  setEntry(id, 'opening');
  channel.onmessage = ({ data }: MessageEvent<Message>) => {
    if (!entries.has(id) || !data || typeof data.type !== 'string') return;
    if (data.type === 'hello') sendSnapshots?.();
    if (data.type === 'ready') { clearTimeout(timeout); setEntry(id, 'floating'); }
    if (data.type === 'dock') dockFloatingWindow(id);
    if (data.type === 'changes' && Array.isArray(data.changes)) {
      // A detached view never moves or deletes its original slot. Sibling edits
      // (e.g. opening execution history) merge by leaf, preserving concurrent edits.
      const changes = data.changes.filter(change => ['windows', 'groupSymbols', 'chartRuntime', 'zOrder', 'savedView'].includes(change.path?.[0])
        && !(change.path[0] === 'windows' && change.path[1] === id
          && (change.path[2] === 'rect' || (change.path.length === 2 && change.remove))));
      receive(() => applyWorkspace(applyFloatingChanges(workspaceSnapshot(), changes), true));
      sendSnapshots?.();
    }
    if (data.type === 'links') {
      receive(() => receiveFloatingChartLinks([
        ...readRemoteGroupChartLinks().filter(link => link.windowId !== id),
        ...data.links.filter(link => link.windowId === id),
      ]));
      sendSnapshots?.();
    }
    if (data.type === 'cursor') {
      const previous = useLiveCursorStore.getState();
      const cursor = { ...data.cursor };
      if (cursor.syncRange) cursor.syncRange = { ...cursor.syncRange, seq: Math.max(cursor.syncRange.seq, (previous.syncRange?.seq ?? 0) + 1) };
      if (cursor.jumpRequest) {
        const seq = Math.max(cursor.jumpRequest.seq, previous.jumpSeqLast + 1);
        cursor.jumpRequest = { ...cursor.jumpRequest, seq };
        cursor.jumpSeqLast = seq;
      }
      receive(() => useLiveCursorStore.setState(cursor));
      for (const current of entries.values()) send(current.channel, { type: 'cursor', cursor });
    }
    if (data.type === 'focus') useWorkspaceStore.getState().focusWindow(id);
  };
  ws.focusWindow(id);
  if (ws.maximizedId === id) useWorkspaceStore.setState({ maximizedId: null });
  const canvas = ws.canvasSize ?? { w: 1200, h: 800 };
  const width = Math.round(Math.max(240, win.rect.w * canvas.w));
  const height = Math.round(Math.max(180, win.rect.h * canvas.h));
  const desktop = window.hogaDesktop?.controls;
  if (desktop?.openFloating) {
    const stop = desktop.onFloatingClosed?.(closed => { if (closed === token) dockFloatingWindow(id); }) ?? (() => {});
    entries.get(id)!.stop = stop;
    void desktop.openFloating(url.href, width, height).catch(() => {
      dockFloatingWindow(id);
      useFloatingWindows.setState({ error: '독립 창을 열지 못했습니다. 다시 시도하세요.' });
    });
  } else {
    const popup = window.open(url.href, `live-floating-${token}`, `popup=yes,width=${width},height=${height}`);
    if (!popup) {
      dockFloatingWindow(id);
      useFloatingWindows.setState({ error: '독립 창을 열지 못했습니다. 이 사이트의 팝업을 허용한 뒤 다시 시도하세요.' });
      return;
    }
    popup.opener = null;
    entries.get(id)!.popup = popup;
    const timer = setInterval(() => { if (popup.closed) dockFloatingWindow(id); }, 500);
    entries.get(id)!.stop = () => clearInterval(timer);
  }
}

/** One coordinator per app: separate workspaces never share this private channel. */
export function useFloatingWorkspace(): void {
  useEffect(() => {
    const child = floatingParams();
    if (typeof BroadcastChannel === 'undefined') return;
    if (child) {
      const channel = new BroadcastChannel(`live-floating:${child.token}`);
      childChannel = channel;
      let initialized = false;
      let previous = workspaceSnapshot();
      channel.onmessage = ({ data }: MessageEvent<Message>) => {
        if (!data) return;
        if (data.type === 'snapshot') {
          if (!data.workspace.windows[child.id]) { window.close(); return; }
          receive(() => {
            applyWorkspace(data.workspace);
            receiveFloatingChartLinks(data.links);
            useLiveCursorStore.setState(data.cursor);
          });
          previous = workspaceSnapshot();
          initialized = true;
          useFloatingWindows.setState({ ready: true });
          send(channel, { type: 'ready' });
        }
        if (data.type === 'dock') window.close();
        if (data.type === 'focus') { window.focus(); void window.hogaDesktop?.controls?.focusFloating?.(); }
        if (data.type === 'cursor') receive(() => useLiveCursorStore.setState(data.cursor));
      };
      const changed = () => {
        const next = workspaceSnapshot();
        if (initialized && !receiving) {
          const changes = floatingChanges(previous, next);
          if (changes.length) send(channel, { type: 'changes', changes });
        }
        previous = next;
      };
      const stopWorkspace = useWorkspaceStore.subscribe(changed);
      const stopSavedView = useLivePageStore.subscribe((state, prev) => {
        if (state.savedRangeFocus !== prev.savedRangeFocus || state.savedRangeRequestSeq !== prev.savedRangeRequestSeq) changed();
      });
      const stopLinks = subscribeGroupChartLinks(() => {
        if (initialized && !receiving) send(channel, { type: 'links', links: readGroupChartLinks().filter(link => link.windowId === child.id) });
      });
      const stopCursor = useLiveCursorStore.subscribe((state, prev) => {
        if (initialized && !receiving) send(channel, { type: 'cursor', cursor: cursorChanges(cursorSnapshot(prev), cursorSnapshot(state)) });
      });
      const close = () => send(channel, { type: 'dock' });
      const focus = () => {
        useWorkspaceStore.getState().focusWindow(child.id);
        send(channel, { type: 'focus' });
      };
      window.addEventListener('pagehide', close);
      window.addEventListener('focus', focus);
      send(channel, { type: 'hello' });
      const hello = setInterval(() => { if (!initialized) send(channel, { type: 'hello' }); }, 500);
      const timeout = setTimeout(() => {
        if (!initialized) useFloatingWindows.setState({ error: '본창에 연결할 수 없습니다. 본창에서 다시 분리하세요.' });
      }, 15_000);
      return () => {
        clearInterval(hello); clearTimeout(timeout);
        window.removeEventListener('pagehide', close); window.removeEventListener('focus', focus);
        stopWorkspace(); stopSavedView(); stopLinks(); stopCursor(); channel.close(); childChannel = null;
      };
    }
    const snapshot = () => {
      const workspace = workspaceSnapshot();
      const links = readGroupChartLinks();
      const cursor = cursorSnapshot();
      for (const [id, entry] of entries) {
        if (!workspace.windows[id]) { dockFloatingWindow(id); continue; }
        send(entry.channel, { type: 'snapshot', workspace, links: links.filter(link => link.group === workspace.windows[id].group), cursor });
      }
    };
    sendSnapshots = snapshot;
    const stopWorkspace = useWorkspaceStore.subscribe((state, prev) => {
      if (!receiving && (state.windows !== prev.windows || state.groupSymbols !== prev.groupSymbols
        || state.zOrder !== prev.zOrder || state.chartRuntime !== prev.chartRuntime)) snapshot();
    });
    const stopSavedView = useLivePageStore.subscribe((state, prev) => {
      if (!receiving && (state.savedRangeFocus !== prev.savedRangeFocus || state.savedRangeRequestSeq !== prev.savedRangeRequestSeq)) snapshot();
    });
    const stopLinks = subscribeGroupChartLinks(() => { if (!receiving) snapshot(); });
    const stopCursor = useLiveCursorStore.subscribe((state, prev) => {
      if (!receiving) for (const entry of entries.values()) send(entry.channel, { type: 'cursor', cursor: cursorChanges(cursorSnapshot(prev), cursorSnapshot(state)) });
    });
    const close = () => { for (const id of [...entries.keys()]) dockFloatingWindow(id); };
    window.addEventListener('pagehide', close);
    return () => { close(); sendSnapshots = null; stopWorkspace(); stopSavedView(); stopLinks(); stopCursor(); window.removeEventListener('pagehide', close); };
  }, []);
}
