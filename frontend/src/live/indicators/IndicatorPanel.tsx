import { useThemePrefsStore } from '../../state/themePrefs';
import { useState, useEffect, useRef, useCallback, useContext, Fragment, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { useChartPrefActions, useScopedChartPrefs } from '../../state/chartPrefs';
import { useIndicatorActions, useWindowIndicators, useWindowIndicatorScope, WindowViewContext } from '../workspace/windowView';
import { dotColorsFor } from './indicatorDotColors';
import { INDICATOR_GLYPH } from './indicatorGlyphs';
import { CatalogDraftProvider } from './CatalogDraftProvider';
import EyeGlyph from '../EyeGlyph';
import { IndicatorInstanceProvider } from './IndicatorInstanceProvider';
import { makeIndicatorInstance, instanceSettings, indicatorInstanceSummary, PRIMARY_INDICATOR_ID, indicatorGroupHidden, clearIndicatorGroupHidden, ownsIndicatorKey, MAX_INDICATOR_INSTANCES } from '../../state/indicatorInstances';
import IndicatorConfigContent from './IndicatorConfigContent';
import { createCatalogDraft, catalogDraftPatch, indicatorIsPresent, PANE_CATEGORY_TO_KEY, type CatalogDraft } from './indicatorCatalogDraft';
import IndicatorPanelMenu from './IndicatorPanelMenu';
import { STOCK_CAPABILITIES, type LiveInstrumentCapabilities } from '../liveInstrumentCapabilities';
import { ListRow } from '../../ui/DataSurface';
import { ModalShell } from '../../ui/ModalShell';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { WORKSPACE_PANEL_WIDTH_CLASS, WORKSPACE_PANEL_HEIGHT_CLASS } from '../workspacePanel';
import { isCalendarTimeframe, type LiveTimeframe } from '../../state/livePage';
import { SettingsEditor } from '../settings/SettingsEditor';
import { useSettingsUndo } from '../settings/useSettingsUndo';
import { readIndicatorEditor, restoreIndicatorEditor, subscribeIndicatorEditor } from '../settings/editorSnapshots';
import { type CategoryId, type GroupId, type Placement, CATEGORIES } from './IndicatorPanelHelpers';

const GROUP_LABEL: Record<GroupId, string> = {
  top: '상단 지표',
  hoga: '10호가 지표',
  program: '프로그램 지표',
  broker: '거래원 지표',
};


/** 미추가 행에 넘기는 고정 빈 배열 — 매 렌더 새 리터럴을 만들지 않는다. */
const EMPTY_DOT_COLORS: readonly string[] = [];


/** 검색어와 겹치는 구간을 표시한다. 강조는 tint 배경 + 굵기 — 색 규율 안에 있다
 *  (액센트 잉크를 쓰면 UI 상태색이 데이터 라벨로 새어 나간다). */
function HighlightedLabel({ label, query }: { label: string; query: string }) {
  const at = query === '' ? -1 : label.indexOf(query);
  if (at < 0) return <>{label}</>;
  return (
    <>
      {label.slice(0, at)}
      <mark className="rounded-sm bg-tint-selection font-semibold text-fg">
        {label.slice(at, at + query.length)}
      </mark>
      {label.slice(at + query.length)}
    </>
  );
}

const PLACEMENT_LABEL: Record<Placement, string> = {
  overlay: '캔들 오버레이',
  pane: '하단 패널',
};


// 모든 지표 설정이 현재 봉(분/일/주/월) 버킷에 저장되므로(#699), 카테고리별
// 스코프 칩 대신 헤더에 '현재: 분봉' 배지 하나로 스코프를 알린다(PR-C).
function timeframeLabel(tf: LiveTimeframe): string {
  if (tf === 'D') return '일봉';
  if (tf === 'W') return '주봉';
  if (tf === 'M') return '월봉';
  return '분봉';
}


/** Labels select a form. Only My Indicators has an inline delete action;
 * catalog additions are committed by the footer after configuration. */
function IndicatorNavRow({
  label, glyph, added, selected, kbdFocused, query, dotColors, kbdIndex, onSelect, action, summary,
}: {
  label: string;
  summary?: string;
  /** 무엇을 그리는 지표이고 어디에 그려지는가 — `indicatorGlyphs`. */
  glyph: ReactNode;
  added: boolean;
  selected: boolean;
  /** ↑↓ 로 짚은 행 — 선택(tint)과 **다른 축**이다. 포커스는 검색창에 남아 있고
   *  이 링이 "Enter 를 누르면 여기" 를 말한다. */
  kbdFocused: boolean;
  query: string;
  /** 차트에 그려지는 색들 — 비어 있으면 점을 찍지 않는다(`indicatorDotColors`). */
  dotColors: readonly string[];
  kbdIndex: number;
  onSelect: () => void;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <ListRow
      data-kbd-index={kbdIndex}
      className={`indicator-nav-row flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
        selected ? 'bg-tint-selection' : 'hover:bg-bg-input-hover'
      } ${added ? 'font-medium text-fg' : 'text-fg-dim hover:text-fg'} ${
        kbdFocused ? 'outline outline-2 -outline-offset-2 outline-accent' : ''
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-label={label}
        aria-current={selected ? 'true' : undefined}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left text-inherit"
      >
        {/* 글리프는 잉크를 행과 공유한다 — 미추가 행에서 함께 흐려져야 "아직 없다"
            가 한 덩어리로 읽힌다. `aria-hidden` 이라 접근성 이름은 라벨 그대로다. */}
        <span className="flex size-4 shrink-0 items-center justify-center">{glyph}</span>
        <span className="indicator-nav-label min-w-0" title={label}>
          <span className="indicator-nav-name"><HighlightedLabel label={label} query={query} /></span>
          {summary && <> <span className="indicator-nav-summary" title={summary} aria-hidden="true">{summary}</span></>}
        </span>
      </button>
      {dotColors.length > 0 && (
        // 장식이 아니라 데이터라 `aria-hidden` 이다 — 색은 스크린리더가 읽을 수 없고,
        // 이 행이 무엇인지는 라벨이 이미 말한다. 밝은 사용자 색이 밝은 배경에
        // 잠기지 않도록 상시 헤어라인을 두른다(테마 무관하게 옅은 검정 → 다크에서도
        // 흰 점의 윤곽이 남는다).
        <span aria-hidden="true" className="indicator-nav-colors ml-2 flex shrink-0 items-center gap-[3px]">
          {dotColors.map((color, i) => (
            <i
              key={i}
              className="size-1.5 rounded-full ring-1 ring-inset ring-black/15"
              style={{ background: color }}
            />
          ))}
        </span>
      )}
      {action && <button
        type="button"
        aria-label={action.label}
        title={action.label}
        onClick={action.onClick}
        // 고정 크기 정사각 — 행 높이를 이 버튼의 패딩이 정하게 두면 목록이 조용히
        // 길어진다(실측 45px/행 → 목록 827px). 밀도는 이 패널의 성격이다.
        className="ml-2 flex size-[22px] shrink-0 cursor-pointer items-center justify-center rounded-md text-fg-dim transition-colors hover:bg-bg-input-hover hover:text-fg"
      >
        ✕
      </button>}
    </ListRow>
  );
}


type Props = {
  onClose: () => void;
  capabilities?: LiveInstrumentCapabilities;
  timeframe: LiveTimeframe;
  /** 멀티창 대상 창 표시(#712) — "종목명" 등. 없으면 기존 단일 뷰 헤더. */
  targetLabel?: string;
};


export default function IndicatorPanel({
  onClose,
  capabilities = STOCK_CAPABILITIES,
  timeframe,
  targetLabel,
}: Props) {
  // 창-스코프 절단(ADR-0119 C2c-2a): 읽기=대상 창의 resolve 된 설정, 쓰기=창 봉
  // 버킷. Provider 밖(/study·플립 전 /live)에서는 둘 다 전역 스토어로 폴백.
  const ind = useWindowIndicators();
  const theme = useThemePrefsStore(s => s.themePreference);
  const { windowKey, instrumentKind } = useWindowIndicatorScope();
  const ambient = useContext(WindowViewContext) === null;
  const read = useCallback(() => readIndicatorEditor({ windowKey, instrumentKind }, timeframe, ambient), [windowKey, instrumentKind, timeframe, ambient]);
  const restore = useCallback((patch: Parameters<typeof restoreIndicatorEditor>[2]) => restoreIndicatorEditor({ windowKey, instrumentKind }, timeframe, patch), [windowKey, instrumentKind, timeframe]);
  const undo = useSettingsUndo({ scopeKey: `${windowKey ?? 'ambient'}:${timeframe}`, read, restore, subscribe: subscribeIndicatorEditor });
  const actions = useIndicatorActions();
  const prefs = useScopedChartPrefs();
  // MA 계열의 마스터 토글은 슬롯의 `enabled` 로 접혔다(ADR) — 카테고리 체크박스는
  // "켜진 슬롯이 하나라도 있는가" 의 파생이고, 누르면 전 슬롯을 함께 켜고 끈다.
  const setMaEnabled = actions.setAllMovingAveragesEnabled;
  const setDailyMaEnabled = actions.setAllDailyMovingAveragesEnabled;
  const setAskPeakEnabled = actions.setAskPeakEnabled;
  const setBidPeakEnabled = actions.setBidPeakEnabled;
  const setTradeVolumePocEnabled = actions.setTradeVolumePocEnabled;
  const setVolumeDistributionEnabled = actions.setVolumeDistributionEnabled;
  const setBrokerLateEntryEnabled = actions.setAllBrokerLateEntriesEnabled;
  const setDepthHeatmapEnabled = actions.setDepthHeatmapEnabled;
  const setPanePrefForTimeframe = actions.setPanePrefForTimeframe;

  const resetIndicators = actions.resetIndicators;
  // indicator-modal chartPrefs 도 이제 대상 창의 봉 버킷을 향한다 — #712 에서
  // "전역 유지"로 수용했던 비대칭은 결함이었다: 버킷은 봉별인데 어느 버킷을 볼지는
  // 포커스를 따라다니는 전역 슬롯이 정해, 창마다 엉뚱한 봉의 설정이 적용됐다.
  const { resetIndicatorModalBucket: resetChartPrefsBucket } = useChartPrefActions();

  // 우측 상세가 어느 카테고리를 보여주는가. 행의 라벨을 누르면 여기가 바뀐다 —
  // 추가 여부와 무관하다(아직 없는 지표도 골라서 미리 볼 수 있다).
  const [selected, setSelected] = useState<CategoryId>('moving-average');
  // 좌측 목록의 모드 — 내 지표(존재하는 것) / 카탈로그(추가할 수 있는 것).
  //
  // 2026-08-26 에 한 번 단일 리스트로 합쳤다가 **사용자 결정으로 되돌렸다**. 합친
  // 판의 이점(15종이 한 화면, 행이 안 움직임)보다 「지금 쓰는 것」과 「추가할 수 있는
  // 것」이 **섞이지 않는 것**이 중요하다는 판단이다 — 매일 여는 목록은 대개 전자만
  // 보려고 여는 것이고, 후자는 가끔 찾으러 들어가는 곳이다.
  const [mode, setMode] = useState<'mine' | 'catalog'>('mine');
  const [selectedInstance, setSelectedInstance] = useState(PRIMARY_INDICATOR_ID);
  const [lastAdded, setLastAdded] = useState<CategoryId | null>(null);
  // 검색어와 ↑↓ 커서. 창을 바꾸면 패널이 재마운트되므로(`key={windowId}`) 둘 다
  // 초기화된다 — 이전 창에서 치던 검색어가 따라오지 않는 것이 맞다.
  const [query, setQuery] = useState('');
  // -1 = 커서 없음(마우스만 썼다). 검색어를 치면 첫 결과로 내려앉는다.
  const [kbdIndex, setKbdIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  // 헤더 ⋯ 메뉴. **열림 상태를 패널이 쥔다** — Escape 를 가로채려면 지금 메뉴가
  // 떠 있는지를 알아야 하기 때문이다(아래 `handleEscape`).
  const [menuOpen, setMenuOpen] = useState(false);
  const draftScopeKey = `${windowKey ?? 'ambient'}:${instrumentKind ?? 'stock'}:${timeframe}`;
  const [cache, setCache] = useState<{ scope: string; drafts: Partial<Record<CategoryId, CatalogDraft>> }>(() => ({ scope: draftScopeKey, drafts: {} }));
  const drafts = cache.scope === draftScopeKey ? cache.drafts : {};
  if (cache.scope !== draftScopeKey) {
    setCache({ scope: draftScopeKey, drafts: {} });
    setSelectedInstance(PRIMARY_INDICATOR_ID);
    setLastAdded(null);
  }
  const getDraft = (id: CategoryId) => {
    const existing = drafts[id];
    if (existing) return existing;
    const draft = createCatalogDraft(id, ind, prefs);
    setCache({ scope: draftScopeKey, drafts: { ...drafts, [id]: draft } });
    return draft;
  };


  // "현재 봉 초기화"(PR-C #699): 지표 버킷과 indicator-modal chartPrefs 버킷을
  // 현재 봉만 비운다. 차트 전반 flat(⚙️ 설정 항목)은 패널 밖이라 건드리지 않는다.
  const handleReset = () => {
    resetIndicators();
    setLastAdded(null);
    resetChartPrefsBucket();
    setCache({ scope: draftScopeKey, drafts: {} });
  };

  /** Escape 사다리의 두 번째 칸 — 메뉴가 떠 있으면 **메뉴만** 닫는다.
   *
   *  `ModalShell` 의 Escape 리스너는 `document`, 팝오버의 것은 `window` 라 document
   *  쪽이 먼저 발화한다. 즉 메뉴를 열어 둔 채 Escape 를 누르면 패널이 통째로 닫히고
   *  메뉴는 그 뒤에 사라진다 — 사용자가 취소하려던 것은 메뉴 하나였는데.
   *  (첫 칸은 검색어 지우기이고, 그건 입력이 전파를 끊어서 여기까지 오지 않는다.) */
  const handleEscape = useCallback(() => {
    if (menuOpen) { setMenuOpen(false); return; }
    onClose();
  }, [menuOpen, onClose]);

  const categories = CATEGORIES.filter((c) => {
    if (c.id === 'volume' && capabilities.volume === false) return false;
    if (c.id === 'trade-value') return capabilities.tradeValue === true && isCalendarTimeframe(timeframe);
    if (c.id === 'program-daily') return capabilities.investorNet === 'stock';
    if (c.group === 'hoga' || c.group === 'program') return capabilities.hogaPanes;
    if ((c.id === 'foreign-net' || c.id === 'institution-net') && capabilities.investorNet === 'none') {
      return false;
    }
    return true;
  });

  // Each category maps to a master on/off toggle. Investor bars have an
  // informational detail pane (legend + daily note) but no per-slot config,
  // so the left checkbox is the whole control for them.
  const instancesFor = (id: CategoryId) => [
    ...(indicatorIsPresent(id, ind) ? [{ id: PRIMARY_INDICATOR_ID, category: id, settings: ind, hidden: indicatorGroupHidden(id, ind) }] : []),
    ...(ind.indicatorInstances ?? []).filter(row => row.category === id).map(row => ({ ...row, hidden: row.hidden || indicatorGroupHidden(id, instanceSettings(ind, row)), settings: instanceSettings(ind, row) })),
  ];
  const checkedFor = (id: CategoryId) => instancesFor(id).length > 0;
  const patchInstances = (rows: typeof ind.indicatorInstances) => restore({ 'indicator:indicatorInstances': rows });
  /** 존재 토글 — 추가와 삭제가 **같은 슬롯의 반대 방향**이라 한 함수로 둔다.
   *  `null` 은 조작할 수 없는 카테고리(현재 없음 — 남겨 두는 것은 총계 방어). */
  const setPresenceFor = (id: CategoryId, present: boolean): (() => void) | null => {
    const paneKey = PANE_CATEGORY_TO_KEY[id];
    if (paneKey) return () => setPanePrefForTimeframe(timeframe, paneKey, present);
    switch (id) {
      case 'supertrend': return () => actions.setSupertrendEnabled(present);
      case 'bollinger': return () => actions.setBollingerEnabled(present);
      case 'moving-average': return () => setMaEnabled(present);
      case 'daily-moving-average': return () => setDailyMaEnabled(present);
      // 병합 카테고리: 매도·매수를 함께 움직인다(레전드에서는 각각 별도 행이다).
      case 'peak-walls': return () => { setAskPeakEnabled(present); setBidPeakEnabled(present); };
      case 'trade-volume-poc': return () => setTradeVolumePocEnabled(present);
      case 'volume-distribution': return () => setVolumeDistributionEnabled(present);
      case 'depth-heatmap': return () => setDepthHeatmapEnabled(present);
      case 'broker-late-entry': return () => setBrokerLateEntryEnabled(present);
      default: return null;
    }
  };
  const removeFor = (category: CategoryId, id: string) => {
    setLastAdded(null);
    const remaining = { ...drafts }; delete remaining[category];
    setCache({ scope: draftScopeKey, drafts: remaining });
    if (id === PRIMARY_INDICATOR_ID) setPresenceFor(category, false)?.();
    else patchInstances((ind.indicatorInstances ?? []).filter(row => row.id !== id));
  };
  const toggleInstance = (category: CategoryId, id: string) => {
    if (id === PRIMARY_INDICATOR_ID) {
      const hidden = ind.indicatorPrimaryHidden ?? [];
      const isHidden = indicatorGroupHidden(category, ind);
      const visibility = isHidden ? clearIndicatorGroupHidden(category, ind) : {};
      const patch = Object.fromEntries(Object.entries(visibility).filter(([key]) => key.endsWith('Hidden') && ownsIndicatorKey(category, key)).map(([key, value]) => [`indicator:${key}`, value]));
      restore({ ...patch, 'indicator:indicatorPrimaryHidden': isHidden ? hidden.filter(c => c !== category) : [...hidden, category] });
    } else patchInstances((ind.indicatorInstances ?? []).map(row => row.id === id ? { ...row, hidden: !(row.hidden || indicatorGroupHidden(category, instanceSettings(ind, row))), settings: clearIndicatorGroupHidden(category, row.settings) } : row));
  };
  const copyInstance = () => {
    const row = instancesFor(selectedId).find(row => row.id === selectedInstance) ?? instancesFor(selectedId)[0];
    if (!row) return;
    const source = ind.indicatorInstances?.find(item => item.id === row.id);
    const draft = createCatalogDraft(selectedId, row.settings, { ...prefs, ...source?.prefs });
    setCache({ scope: draftScopeKey, drafts: { ...drafts, [selectedId]: draft } });
    setSelected(selectedId);
    setMode('catalog');
    setLastAdded(null);
    setQuery('');
  };
  // A populated category always gets a new stable instance. Never overwrite its siblings.
  const addFor = (id: CategoryId) => {
    const draft = getDraft(id);
    const prepared = draft.store.getState();
    if (!indicatorIsPresent(id, prepared.settings) || (ind.indicatorInstances?.length ?? 0) >= MAX_INDICATOR_INSTANCES) return;
    if (instancesFor(id).length === 0) {
      restore({ ...catalogDraftPatch(draft, read()), 'indicator:indicatorPrimaryHidden': (ind.indicatorPrimaryHidden ?? []).filter(c => c !== id) });
      setSelectedInstance(PRIMARY_INDICATOR_ID);
    } else {
      const row = makeIndicatorInstance(id, prepared.settings, prepared.prefs);
      patchInstances([...(ind.indicatorInstances ?? []), row]);
      setSelectedInstance(row.id);
    }
    setSelected(id);
    setLastAdded(id);
  };

  // 내 지표는 종류별 항목을 묶고, 카탈로그는 이미 쓰는 종류도 계속 제공한다.
  //
  // 검색은 `categories` **다음** 단계다 — capability 게이트를 통과한 것만 검색된다.
  // 순서를 바꾸면 이 종목에 없는 지표가 검색으로 되살아난다. 그리고 검색은 **지금
  // 보고 있는 모드 안에서만** 거른다: 「내 지표」에서 친 검색어가 아직 추가하지 않은
  // 지표를 끌어오면 두 목록을 가른 의미가 없어진다.
  const trimmedQuery = query.trim();
  const matches = (label: string) => trimmedQuery === '' || label.includes(trimmedQuery);
  const active = categories.filter((c) => checkedFor(c.id) && matches(c.label));
  const catalog = categories.filter((c) => matches(c.label));
  /** ↑↓ 가 짚는 대상 — 지금 모드의 보이는 행들. */
  const visible = mode === 'mine' ? active : catalog;

  // ↑↓ 가 짚는 대상은 **보이는 행의 평탄한 순서**다. 검색으로 목록이 줄면 커서도
  // 범위 안으로 당겨야 하므로, 렌더마다 클램프하지 않고 검색어 변경에서 0으로 되돌린다.
  const kbdTarget = kbdIndex >= 0 ? visible[kbdIndex] : undefined;
  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // **한글 조합 중의 Enter 는 글자 확정이지 명령이 아니다.** 이 가드가 없으면
    // "매물" 을 치는 도중 확정 Enter 가 선택으로 새어 나간다.
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setKbdIndex((i) => Math.min(visible.length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setKbdIndex((i) => Math.max(0, i - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      // Enter selects the form; only the footer CTA adds the prepared indicator.
      if (kbdTarget) { setLastAdded(null); setSelected(kbdTarget.id); setSelectedInstance(PRIMARY_INDICATOR_ID); }
    } else if (event.key === 'Escape' && query !== '') {
      // 검색어가 있으면 Escape 는 **검색만** 지운다. 전파를 끊지 않으면 ModalShell 의
      // document 리스너가 이어받아 패널까지 닫힌다.
      event.stopPropagation();
      setQuery('');
      setKbdIndex(-1);
    }
  };

  useEffect(() => {
    if (kbdIndex < 0) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-kbd-index="${kbdIndex}"]`);
    // jsdom 에는 scrollIntoView 가 없다 — 있으면 쓴다.
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [kbdIndex]);

  // 카탈로그에서는 아직 없는 지표도 미리 볼 수 있으므로 전체에서 찾는다. "내 지표"
  // 모드에서는 선택이 삭제됐을 때 남은 첫 항목으로 넘긴다 — 그 모드의 목록에서 방금
  // 지운 행이 사라지므로, 선택을 그대로 두면 목록에 없는 것의 설정을 보게 된다.
  const selectedCategory = mode === 'catalog'
    ? catalog.find((category) => category.id === selected) ?? catalog[0] ?? categories[0]
    : categories.find((category) => category.id === selected && checkedFor(category.id))
      ?? categories.find((category) => checkedFor(category.id))
      ?? categories[0];
  // 상세 본문은 `selected` 가 아니라 **폴백까지 거친 결과**를 따른다 — capability 로
  // 걸러진 지표가 선택돼 있으면 헤더는 폴백을 그리는데 본문만 아무것도 안 그리는
  // 어긋남이 생긴다.
  const selectedId = selectedCategory.id;
  const selectedAdded = checkedFor(selectedId);
  const currentTimeframeLabel = timeframeLabel(timeframe);
  const emptyCatalog = mode === 'catalog' && catalog.length === 0;
  const draft = mode === 'catalog' && catalog.length > 0 && !(lastAdded === selectedId && selectedAdded) ? getDraft(selectedId) : null;
  const currentInstances = instancesFor(selectedId);
  const currentInstance = currentInstances.find(row => row.id === selectedInstance) ?? currentInstances[0];
  const currentId = currentInstance?.id ?? PRIMARY_INDICATOR_ID;

  return (
    // App settings and indicators share the same header, scope, navigation and undo shell.
    <ModalShell
      ariaLabel="지표"
      width={WORKSPACE_PANEL_WIDTH_CLASS}
      height={WORKSPACE_PANEL_HEIGHT_CLASS}
      onClose={handleEscape}
    >
      <SettingsEditor title="보조지표" onClose={onClose} undo={undo} testId="indicator-panel-shell" className="indicator-editor"
        scope={<span data-testid="indicator-panel-scope-badge">{targetLabel ? `${targetLabel} · ${currentTimeframeLabel}` : `현재: ${currentTimeframeLabel}`}</span>}
        actions={<IndicatorPanelMenu open={menuOpen} onOpenChange={setMenuOpen}
          resetLabel={`${currentTimeframeLabel} 지표 초기화`} confirmLabel={`${currentTimeframeLabel} 초기화?`} onReset={handleReset} />}
        footer={draft ? '설정한 값은 추가할 때 적용돼요.' : '변경 즉시 반영 · 현재 차트에 저장'}
        statusIcon={draft ? null : undefined}
        footerAction={mode === 'catalog' && !emptyCatalog && (draft || selectedAdded) ? (draft
          ? <CatalogAddButton count={ind.indicatorInstances?.length ?? 0} draft={draft} category={selectedId} onAdd={() => addFor(selectedId)} />
          : <><button type="button" onClick={copyInstance} className="indicator-catalog-add">하나 더 추가</button><button type="button" className="indicator-catalog-add" disabled>추가됨</button></>) : undefined}
        sidebar={
      <div className="flex min-h-0 flex-1 flex-col">

        <nav
          className="flex min-h-0 flex-1 flex-col"
          aria-label={mode === 'mine' ? '내 지표' : '지표 추가'}
        >
          <div className="p-2 pb-1">
            <SegmentedControl label="지표 목록" value={mode} className="mb-2 w-full"
              options={[
                { value: 'mine', label: '내 지표', testId: mode === 'catalog' ? 'indicator-panel-mode-toggle' : undefined },
                { value: 'catalog', label: '지표 추가', testId: mode === 'mine' ? 'indicator-panel-mode-toggle' : undefined },
              ]}
              onChange={next => { setMode(next); setLastAdded(null); setQuery(''); setKbdIndex(-1); }} />
            <div className="flex h-7 items-center gap-1.5 rounded-lg border border-border bg-bg-input px-2 focus-within:border-accent">
              <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" className="shrink-0 text-fg-dim">
                <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <line x1="10.2" y1="10.2" x2="13.5" y2="13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <input
                type="text"
                data-modal-autofocus
                value={query}
                aria-label="지표 검색"
                placeholder="지표 검색"
                data-testid="indicator-panel-search"
                onChange={(event) => { setQuery(event.currentTarget.value); setKbdIndex(0); }}
                onKeyDown={onSearchKeyDown}
                // 전역 `:focus-visible` 액센트 링은 맨 `outline-none` 으로는 안 꺼진다
                // (특이도) — variant 를 써야 한다. 테두리는 래퍼가 focus-within 으로 진다.
                className="w-full bg-transparent text-sm text-fg placeholder:text-fg-dimmer focus-visible:outline-none"
              />
            </div>
          </div>
          {/* 「내 지표」는 **평리스트**, 카탈로그는 **그룹 헤더가 있는 목록**이다.
              비대칭이 아니라 각 목록이 답하는 질문이 달라서다 — 전자는 "내가 지금 뭘
              쓰나"(대개 몇 개라 셀 수 있다), 후자는 "뭐가 더 있나"(계열로 훑는다). */}
          <div ref={listRef} className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
            {visible.length === 0 && (
              <p className="px-3 py-4 text-sm text-fg-dim">
                {trimmedQuery !== ''
                  ? '일치하는 지표 없음'
                  : mode === 'mine'
                    ? '추가한 지표가 없습니다.'
                    : '추가할 수 있는 지표를 전부 쓰고 있습니다.'}
              </p>
            )}
            {visible.map((c, i) => {
              const added = checkedFor(c.id);
              // 그룹 헤더는 카탈로그에만. 같은 그룹이 이어지는 동안은 한 번만 낸다.
              const groupHead = mode === 'catalog'
                && (i === 0 || visible[i - 1].group !== c.group);
              return (
                <Fragment key={c.id}>
                  {groupHead && (
                    <div className={`px-3 pb-1 text-xs font-semibold uppercase text-fg-dim${i !== 0 ? ' pt-3' : ''}`}>
                      {GROUP_LABEL[c.group]}
                    </div>
                  )}
                  {/* Catalog rows only select the draft form. The footer commits it. */}
                  <IndicatorNavRow
                    label={c.label}
                    summary={added ? `#${instancesFor(c.id).length}` : undefined}
                    glyph={INDICATOR_GLYPH[c.id]}
                    added={added}
                    selected={selectedId === c.id}
                    kbdFocused={kbdIndex === i}
                    kbdIndex={i}
                    query={trimmedQuery}
                    dotColors={added ? dotColorsFor(c.id, ind, theme) : EMPTY_DOT_COLORS}
                    onSelect={() => { setSelected(c.id); setLastAdded(null); setSelectedInstance(instancesFor(c.id)[0]?.id ?? PRIMARY_INDICATOR_ID); }}
                    action={mode === 'mine' && added && instancesFor(c.id).length === 1
                      ? { label: `${c.label} 삭제`, onClick: () => removeFor(c.id, instancesFor(c.id)[0].id) }
                      : undefined}
                  />
                  {mode === 'mine' && instancesFor(c.id).length > 1 && <div className="indicator-instance-children">
                    {instancesFor(c.id).map((row, ri) => <div className="indicator-instance-row" key={row.id}>
                      <button type="button" className={selectedId === c.id && currentId === row.id ? 'is-selected' : ''}
                        aria-label={`${c.label} ${ri + 1} 설정`} aria-current={selectedId === c.id && currentId === row.id ? 'true' : undefined}
                        onClick={() => { setSelected(c.id); setSelectedInstance(row.id); }}>
                        <span className="font-data">{ri + 1}</span><span>{indicatorInstanceSummary(c.id, row.settings)}</span>
                      </button>
                      <button type="button" aria-label={`${c.label} ${ri + 1} ${row.hidden ? '표시' : '숨기기'}`} onClick={() => toggleInstance(c.id, row.id)}><EyeGlyph hidden={row.hidden === true} /></button>
                      <button type="button" aria-label={`${c.label} ${ri + 1} 삭제`} onClick={() => removeFor(c.id, row.id)}>✕</button>
                    </div>)}
                  </div>}
                </Fragment>
              );
            })}
          </div>
        </nav>
        {/* 모드 전환 — "추가" 는 카탈로그를 열고, 카탈로그에서는 목록으로 돌아간다.
            둘을 한 화면에 섞지 않는 이유: 매일 여는 목록은 대개 「지금 쓰는 것」만
            보려고 여는 것이고, 「추가할 수 있는 것」은 가끔 찾으러 들어가는 곳이다.
            전환할 때 검색어는 지운다 — 한쪽에서 친 검색어가 다른 목록에 그대로
            걸려 있으면 "왜 비어 있지" 가 된다. */}
      </div>}
      >
          <div className="settings-editor-detail-heading">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs text-fg-dim">{GROUP_LABEL[selectedCategory.group]} · {PLACEMENT_LABEL[selectedCategory.placement]}</div>
              <span className="text-xs text-fg-dim">{draft ? '추가 전' : selectedAdded ? '차트에 추가됨' : ''}</span>
            </div>
            <h3>{emptyCatalog ? '지표 추가' : selectedCategory.label}</h3>
            {!draft && currentInstance && <div className="indicator-instance-actions">
              <span>{indicatorInstanceSummary(selectedId, currentInstance.settings)}</span>
              <button type="button" onClick={() => toggleInstance(selectedId, currentId)}>{currentInstance.hidden ? '표시' : '숨기기'}</button>
              <button type="button" onClick={() => removeFor(selectedId, currentId)}>삭제</button>
              <button type="button" onClick={copyInstance}>설정 복사해서 추가</button>
            </div>}
            <p className="settings-editor-description mt-1">{emptyCatalog ? '' : selectedCategory.description}</p>
          </div>
          <section
            aria-label={selectedCategory.label}
            className="settings-editor-content indicator-config space-y-4"
          >
              {emptyCatalog ? <p className="text-sm text-fg-dim">모든 지표를 사용 중이에요.</p> : draft ? <CatalogDraftProvider key={selectedId} draft={draft}>
                <IndicatorConfigContent category={selectedId} capabilities={capabilities} />
              </CatalogDraftProvider> : selectedAdded ? currentId === PRIMARY_INDICATOR_ID
                ? <IndicatorConfigContent key={selectedId} category={selectedId} capabilities={capabilities} />
                : <IndicatorInstanceProvider key={currentId} id={currentId}><IndicatorConfigContent category={selectedId} capabilities={capabilities} /></IndicatorInstanceProvider>
                : <p className="text-sm text-fg-dim">{mode === 'mine' ? '지표 추가에서 원하는 지표를 골라 주세요.' : '추가할 수 있는 지표를 전부 쓰고 있습니다.'}</p>}
          </section>
      </SettingsEditor>
    </ModalShell>
  );
}

/** The footer follows the same draft store as the form, including zero-slot validation. */
function CatalogAddButton({ draft, category, onAdd, count }: { count: number; draft: CatalogDraft; category: CategoryId; onAdd: () => void }) {
  const canAdd = useStore(draft.store, s => indicatorIsPresent(category, s.settings));
  return <button type="button" className="indicator-catalog-add" onClick={onAdd} disabled={!canAdd || count >= MAX_INDICATOR_INSTANCES} title={count >= MAX_INDICATOR_INSTANCES ? '추가한 지표가 128개입니다' : undefined}>설정대로 추가</button>;
}
