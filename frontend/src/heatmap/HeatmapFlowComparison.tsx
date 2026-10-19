import { useId, useLayoutEffect, useMemo, useState } from 'react';
import type { HeatmapFolder } from '../api/heatmap';
import type { useHeatmapGroupFlowData } from '../api/heatmapGroupFlow';
import { LIVE_VENUE_LABELS, type LiveVenueOption } from '../state/liveVenue';
import { FLOW_COMPARISON_MODES, MAX_FLOW_GROUPS, subscribeToHeatmapFlowPrefsStorage, useHeatmapFlowPrefsStore } from '../state/heatmapFlowPrefs';
import { PageState, SegmentedControl, ToolbarButton } from '../ui/PageShell';
import { HeatmapFlowChart } from './HeatmapFlowChart';
import { FLOW_MODE_LABELS, flowPoints, flowTimeLabel, flowValueAt, flowValueLabel, latestFlowTime } from './flowComparison';
import './HeatmapFlowComparison.css';

// 기존 차트 팔레트를 사용하므로 모든 앱 테마에서 선과 범례가 함께 바뀐다.
const COLORS = ['var(--ma-2)', 'var(--ma-3)', 'var(--ma-1)', 'var(--ma-6)', 'var(--ma-4)', 'var(--ma-8)'];
const EMPTY_PCT: (number | null)[] = [];

interface Props {
  folders: HeatmapFolder[];
  venue: LiveVenueOption;
  flow: ReturnType<typeof useHeatmapGroupFlowData>;
  onClose: () => void;
}

export function HeatmapFlowComparison({ folders, venue, flow, onClose }: Props) {
  const { data, error, isLoading, isFetching, dataUpdatedAt, refetch } = flow;
  const savedIds = useHeatmapFlowPrefsStore((s) => s.selectedGroupIds);
  const setIds = useHeatmapFlowPrefsStore((s) => s.setSelectedGroupIds);
  const mode = useHeatmapFlowPrefsStore((s) => s.mode);
  const setMode = useHeatmapFlowPrefsStore((s) => s.setMode);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [inspection, setInspection] = useState<{ key: string; time: number; pinned: boolean } | null>(null);
  const pickerId = useId();
  const sliderId = useId();
  const orderedFolders = useMemo(() => [...folders].sort((a, b) => a.order - b.order), [folders]);
  useLayoutEffect(() => {
    const prefs = useHeatmapFlowPrefsStore.getState();
    prefs.hydrateFromStorage();
    // 기본 그룹도 처음 보인 시점에 고정한다. 이후 폴더 순서가 바뀌어도 유지한다.
    prefs.initializeSelectedGroupIds(orderedFolders.map((folder) => folder.id));
    return subscribeToHeatmapFlowPrefsStorage();
  }, [orderedFolders]);
  const matchingFolders = orderedFolders.filter((f) => f.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected = useMemo(() => {
    const byId = new Map(folders.map((f) => [f.id, f]));
    return savedIds === null ? orderedFolders.slice(0, MAX_FLOW_GROUPS) : savedIds.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
  }, [savedIds, folders, orderedFolders]);
  const selectedIds = useMemo(() => selected.map((f) => f.id), [selected]);
  const colorById = useMemo(() => new Map(selected.map((f, i) => [f.id, COLORS[i]])), [selected]);
  const byId = useMemo(() => new Map(data?.groups.map((g) => [g.folder_id, g.pct])), [data]);
  const series = useMemo(() => selected.map((folder) => {
    const pct = byId.get(folder.id) ?? EMPTY_PCT;
    const base = data?.t_base_ms ?? 0, bucket = data?.bucket_ms ?? 300_000;
    return {
      id: folder.id, name: folder.name, color: colorById.get(folder.id)!,
      points: flowPoints(pct, base, bucket, mode),
      absolute: flowPoints(pct, base, bucket, 'absolute'),
      momentum: flowPoints(pct, base, bucket, 'momentum'),
    };
  }), [selected, byId, data, mode, colorById]);
  const latest = useMemo(() => data ? latestFlowTime(data, selectedIds) : null, [data, selectedIds]);
  const start = data?.t_base_ms ?? 0;
  const end = start + (data?.bucket_ms ?? 300_000) * Math.max(1, ...(data?.groups.map((g) => g.pct.length) ?? [78]));
  const inspectionKey = `${venue}:${data?.date ?? ''}`;
  const currentInspection = inspection?.key === inspectionKey ? inspection : null;
  const pinned = currentInspection?.pinned ?? false;
  const cursor = Math.max(start, Math.min(latest ?? start, currentInspection?.time ?? latest ?? start));
  const unit = mode === 'absolute' ? '%' : '%p';
  const hasPoints = series.some((s) => s.points.some((p) => p.value !== null));
  const toggle = (id: string) => {
    if (selectedIds.includes(id)) setIds(selectedIds.filter((v) => v !== id));
    else if (selectedIds.length < MAX_FLOW_GROUPS) setIds([...selectedIds, id]);
  };
  const inspect = (time: number, pinned: boolean) => setInspection({ key: inspectionKey, time, pinned });

  return (
    <section className="heatmap-flow" data-testid="heatmap-flow-comparison" aria-label="섹터 흐름 비교">
      <header className="heatmap-flow-header">
        <div><h1>섹터 흐름 비교</h1><p>{data?.date ?? '거래일 확인 중'} · {LIVE_VENUE_LABELS[venue]} · 그룹 구성 종목의 평균 등락률</p></div>
        <ToolbarButton onClick={onClose}>← 히트맵으로 돌아가기</ToolbarButton>
      </header>
      <div className="heatmap-flow-toolbar">
        <span className="text-sm text-fg-dim">장중 흐름 · {data ? `${data.bucket_ms / 60_000}분` : '5분'} 단위</span>
        <SegmentedControl aria-label="흐름 비교 기준">
          {FLOW_COMPARISON_MODES.map((key) => <button key={key} type="button" aria-pressed={mode === key} onClick={() => setMode(key)}>{FLOW_MODE_LABELS[key]}</button>)}
        </SegmentedControl>
      </div>
      <div className="heatmap-flow-selection">
        <span className="text-sm text-fg-dim">비교 그룹 {selected.length}/{MAX_FLOW_GROUPS}</span>
        {selected.map((folder) => <button key={folder.id} type="button" className="heatmap-flow-chip" aria-label={`${folder.name} 비교에서 제외`} onClick={() => toggle(folder.id)}>
          <span className="heatmap-flow-dot" style={{ background: colorById.get(folder.id) }} />{folder.name}<span aria-hidden="true">×</span>
        </button>)}
        <ToolbarButton aria-expanded={pickerOpen} aria-controls={pickerId} onClick={() => setPickerOpen(!pickerOpen)}>그룹 선택</ToolbarButton>
      </div>
      {pickerOpen && <section id={pickerId} className="heatmap-flow-picker" aria-label="비교 그룹 선택">
        <div className="heatmap-flow-picker-header"><label>그룹 검색<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="그룹 이름" /></label>
          <span className="text-sm text-fg-dim">최대 {MAX_FLOW_GROUPS}개 · 추가하려면 선택한 그룹을 해제하세요.</span>
          <div className="flex items-center gap-2">
            <ToolbarButton disabled={selected.length === 0} onClick={() => setIds([])}>모두 해제</ToolbarButton>
            <ToolbarButton onClick={() => setPickerOpen(false)}>선택 완료</ToolbarButton>
          </div></div>
        <div className="heatmap-flow-options">{matchingFolders.map((folder) => <label key={folder.id}>
          <input type="checkbox" checked={selectedIds.includes(folder.id)} disabled={selected.length >= MAX_FLOW_GROUPS && !selectedIds.includes(folder.id)} onChange={() => toggle(folder.id)} />{folder.name}
        </label>)}</div>
        {!matchingFolders.length && <p className="text-sm text-fg-dim" role="status">일치하는 그룹이 없습니다.</p>}
      </section>}
      {isLoading && <PageState>그룹별 흐름을 불러오는 중…</PageState>}
      {error && <div role="alert" className="heatmap-flow-notice">{data ? '흐름 갱신에 실패했습니다. 마지막 수신 데이터를 표시합니다.' : '그룹별 흐름을 불러오지 못했습니다.'}<ToolbarButton disabled={isFetching} onClick={() => { void refetch(); }}>다시 시도</ToolbarButton></div>}
      {!isLoading && !selected.length && <PageState>그룹 선택에서 비교할 그룹을 골라 주세요.</PageState>}
      {!isLoading && !error && selected.length > 0 && !hasPoints && <PageState>{latest === null ? '선택한 그룹에 수신된 장중 flow 데이터가 없습니다.' : mode === 'relative' ? '첫 구간 데이터가 없어 기준을 맞출 수 없습니다. 다른 비교 기준을 선택하세요.' : '30분 전과 현재 값이 함께 있는 구간부터 표시합니다.'}</PageState>}
      {data && selected.length > 0 && <>
        <div className="heatmap-flow-main">
          <aside className="heatmap-flow-readout" aria-label="선택 시각의 그룹별 수치">
            <div className="heatmap-flow-readout-header"><strong className="font-data">{latest === null ? '—' : flowTimeLabel(cursor)}</strong><span>{pinned ? '고정 시각' : '시각별 비교'}</span></div>
            <div className="heatmap-flow-column-labels"><span>그룹 / 선택 기준 값</span><span>{mode === 'momentum' ? '전일 대비' : '30분 변화'}</span></div>
            {series.map((s) => {
              const value = latest === null ? null : flowValueAt(s.points, cursor);
              const secondary = latest === null ? null : flowValueAt(mode === 'momentum' ? s.absolute : s.momentum, cursor);
              return <div className="heatmap-flow-value-row" key={s.id} data-testid={`flow-readout-${s.id}`} onPointerEnter={() => setHighlighted(s.id)} onPointerLeave={() => setHighlighted(null)}>
                <div><span className="heatmap-flow-dot" style={{ background: s.color }} />{s.name}</div>
                <div className="heatmap-flow-value-numbers font-data"><strong style={{ color: value === null || value === 0 ? 'var(--fg)' : value > 0 ? 'var(--price-up)' : 'var(--price-down)' }}>{flowValueLabel(value, unit)}</strong><span>{flowValueLabel(secondary, mode === 'momentum' ? '%' : '%p')}</span></div>
              </div>;
            })}
          </aside>
          <div className="heatmap-flow-plot"><div className="heatmap-flow-chart-heading"><span>{FLOW_MODE_LABELS[mode]} ({unit})</span><span>동일 시간 · 공통 Y축</span></div>
            <HeatmapFlowChart series={series} start={start} end={end} latest={latest} cursor={cursor} unit={unit} highlighted={highlighted}
              onHover={(time) => { if (!pinned) inspect(time, false); }} onPin={(time) => inspect(time, !pinned)} />
          </div>
        </div>
        <div className="heatmap-flow-timeline">
          <label htmlFor={sliderId}>비교 시각 <output className="font-data">{latest === null ? '—' : flowTimeLabel(cursor)}</output></label>
          <input id={sliderId} type="range" aria-label="비교 시각 선택" aria-valuetext={latest === null ? '데이터 없음' : flowTimeLabel(cursor)} min={start} max={latest ?? start} step={data.bucket_ms} value={cursor} disabled={latest === null} onChange={(event) => inspect(Number(event.target.value), true)} />
          <span className="text-sm text-fg-dim">{pinned ? '고정됨' : '차트를 클릭해 고정'}</span>
          <ToolbarButton disabled={latest === null} onClick={() => setInspection(null)}>최신 시각</ToolbarButton>
        </div>
      </>}
      <footer className="heatmap-flow-footer"><span>{mode === 'absolute' ? '전일 종가 = 0% · 그룹별 단순 평균' : mode === 'relative' ? '첫 5분 구간 = 0 · 이후 변화 폭(%p) · 첫 구간이 없으면 표시하지 않음' : '각 시각 − 정확히 30분 전 · 데이터가 없는 구간은 표시하지 않음'}</span>
        <span>{latest !== null ? `마지막 구간 ${flowTimeLabel(latest)} · ` : ''}{dataUpdatedAt ? `${flowTimeLabel(dataUpdatedAt)} 수신 · ` : ''}60초마다 갱신{isFetching ? ' · 갱신 중…' : ''}</span></footer>
    </section>
  );
}
