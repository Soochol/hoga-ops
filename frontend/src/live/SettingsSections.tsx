import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CHART_LINE_STYLES,
  CHART_NUMERIC_PREFS,
  CHART_TOGGLES,
  CHART_TOGGLE_GROUPS,
  DAY_BOUNDARY_COLOR_DEFAULT,
  TRADE_HIGHLIGHT_COLOR_DEFAULT,
  categoryOf,
  gatedByOf,
  groupOf,
  useChartPrefsStore,
  type ChartToggleCategory,
  type ChartToggleGroupId,
  type ChartToggleKey,
} from '../state/chartPrefs';
import MAStylePicker from './indicators/MAStylePicker';
import ColorSwatchPicker from './indicators/ColorSwatchPicker';
import IndicatorPrefRows from './settings/IndicatorPrefRows';
import { SettingsRow, highlightLabel } from './settings/SettingsRow';
import { DataSourceDetail } from './settings/DataSourceDetail';
import {
  GeneralSection,
  RoadmapSection,
  SymbolMasterSection,
  ThemeSection,
} from './settings/AppInfoSections';
import SignalAlertSettingsSection from '../signalAlerts/SignalAlertSettingsSection';
import { WORKSPACE_PANEL_SHELL_CLASS } from './workspacePanel';

/**
 * 앱의 **유일한** 설정 본체 — 좌측 목차 240px + 우측 단일 스크롤 문서(지표 드로어와
 * 동일 폭·셸 상수라 툴바에서 보조지표↔설정을 오가도 nav가 흔들리지 않는다).
 *
 * ## 단일 스크롤 + 스크롤 스파이 목차 (2026-08-26 리디자인 · 프로토타입 C 채택)
 *
 * 종전의 마스터-디테일(좌 nav 클릭 → 우측 섹션 교체)을 버렸다. 모든 섹션이 한
 * 문서처럼 이어지고, 좌측 nav 는 섹션을 갈아 끼우는 스위치가 아니라 **현재 스크롤
 * 위치를 비추는 목차**다 — 클릭하면 그리로 스크롤하고, 스크롤하면 하이라이트가
 * 따라온다. 검색은 화면 전환 없는 **인라인 필터**다: 레지스트리 행만 그 자리에서
 * 걸러 내고, 자유 마크업 섹션(알림·데이터소스 등)은 필터 중 숨긴다(빈 상태 문구가
 * 그 경계를 말한다). A/B/C 프로토타입 판정과 실측(차트 섹션 1,705px vs 뷰포트
 * 807px · 이중 구분선 · 게이트 없는 스타일 행)은 DESIGN.md 결정 로그 참조.
 *
 * 차트·체결창 섹션은 `CHART_TOGGLES` 레지스트리 주도이고 소그룹도 레지스트리가
 * 소유한다(`group` 필드 + `CHART_TOGGLE_GROUPS` — 순서가 곧 화면 순서).
 * 'indicator-modal' 카테고리는 제외(그건 「지표」 모달 소관). 나머지는 아래 고정
 * 섹션이다. 토글/pref 추가는 여전히 레지스트리 한 줄.
 *
 * 원래 설정 표면이 **둘**이었다 — 여기(차트 드로어)와 `pages/Settings` 의 앱 설정
 * 모달. 둘은 셸 마크업·testId 규칙·행 컴포넌트를 이미 공유하면서 nav 목록과 셸 상수만
 * 갈라져 있었고, 같은 값에 대해 서로 다른 이야기를 하는 지점까지 생겼다(자세한 사연은
 * `DataSourceDetail` 헤더). 이제 진입점(TopNav ⚙ · `/live`·`/study` 툴바 ⚙ · 캔들
 * 빈 상태 · `/settings` 라우트)이 전부 이 컴포넌트를 연다.
 *
 * `variant` 는 **체결창 섹션 하나**만 가른다(TOC 항목과 본문 섹션이 함께 사라진다).
 * 데이터소스가 쓰던 분기는 삭제됐다 — 값이 전역인데 화면마다 숨기면 어느 문으로
 * 들어왔는지에 답이 달라지기 때문이다.
 */
type NavId =
  | ChartToggleCategory
  | 'data-source'
  | 'alerts'
  | 'theme'
  | 'symbols'
  | 'general'
  | 'roadmap';

const CATEGORY_ORDER: ChartToggleCategory[] = ['chart', 'trade-window'];
const INFO_ORDER = ['alerts', 'data-source', 'theme', 'symbols', 'general', 'roadmap'] as const;
const LABEL: Record<NavId, string> = {
  chart: '차트',
  'indicator-modal': '지표', // never rendered — not in CATEGORY_ORDER; kept for Record<NavId> exhaustiveness
  'trade-window': '체결창',
  'data-source': '데이터소스',
  alerts: '알림',
  theme: '테마',
  symbols: 'Symbol Master',
  general: '앱 정보',
  roadmap: '로드맵',
};

/** 레지스트리 밖의 손 스타일 행(아래 세 컴포넌트) — 라벨·설명을 여기 상수로 두고
 *  렌더와 검색 코퍼스가 **같은 문자열**을 읽는다(각자 적으면 검색만 낡는다). */
const DAY_BOUNDARY_STYLE_ROW = {
  label: '날짜 구분선 스타일',
  description: '거래일 경계를 표시하는 세로 점선의 색상과 두께입니다',
} as const;
const VI_LINE_STYLE_ROW = {
  label: 'VI/상하한가 선 스타일',
  description: 'VI 가격대와 상한가·하한가 가격선을 표시하는 색상과 두께입니다',
} as const;
const TRADE_HIGHLIGHT_COLOR_ROW = {
  label: '강조 배경색',
  description: '대량 체결의 체결량 칸에 칠할 배경색입니다',
} as const;
const CUSTOM_ROW_TEXT: Partial<Record<ChartToggleKey, string>> = {
  dayBoundaryEnabled: `${DAY_BOUNDARY_STYLE_ROW.label} ${DAY_BOUNDARY_STYLE_ROW.description}`,
  viLimitPriceDotsEnabled: `${VI_LINE_STYLE_ROW.label} ${VI_LINE_STYLE_ROW.description}`,
  tradeHighlightEnabled: `${TRADE_HIGHLIGHT_COLOR_ROW.label} ${TRADE_HIGHLIGHT_COLOR_ROW.description}`,
};

/** 설정 필터의 매칭 단위 — 최상위 토글 + 그 아래 종속 행 전부(하위 토글·수치·선
 *  스타일·손 스타일 행)를 **한 유닛**으로 본다. 프로토타입은 행 단위로 걸렀지만,
 *  실제 렌더러(`IndicatorPrefRows`)는 부모+하위를 한 덩어리로 그리고 부모 없는
 *  하위 행은 맥락을 잃으므로 유닛 단위가 정직하다(의도된 이탈). */
type FilterUnit = {
  key: ChartToggleKey;
  category: ChartToggleCategory;
  group: ChartToggleGroupId;
  corpus: string;
};

function buildFilterUnits(): FilterUnit[] {
  return CHART_TOGGLES.flatMap((t) => {
    const group = groupOf(t);
    if (group === undefined || gatedByOf(t) !== undefined) return [];
    const children = CHART_TOGGLES.filter((c) => gatedByOf(c) === t.key);
    const numerics = CHART_NUMERIC_PREFS.filter((n) => 'enabledBy' in n && n.enabledBy === t.key);
    const lines = CHART_LINE_STYLES.filter((l) => l.enabledBy === t.key);
    const corpus = [
      t.label, t.description,
      ...children.flatMap((c) => [c.label, c.description]),
      ...numerics.flatMap((n) => [n.label, n.description]),
      ...lines.map((l) => l.label),
      CUSTOM_ROW_TEXT[t.key] ?? '',
    ].join(' ');
    return [{ key: t.key, category: categoryOf(t), group, corpus }];
  });
}

function GroupHead({ label }: { label: string }) {
  return (
    <div className="mb-0.5 mt-4 text-xs font-semibold uppercase text-fg-dim">{label}</div>
  );
}

/** 종속 스타일 행의 공용 게이트 래퍼 — 들여쓰기 + 부모 OFF 시 dim(값은 보존).
 *  `IndicatorPrefRows` 가 하위 토글에 쓰는 것과 같은 문법이다. 종전엔 날짜
 *  구분선·VI 스타일 행이 게이트 없이 최상위에 서 있어서, 부모를 꺼도 스타일
 *  피커가 살아 있는 죽은 컨트롤이었다(2026-08-26 조사). */
function GatedStyleRow({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return (
    <div className={`ml-4 ${enabled ? '' : 'pointer-events-none opacity-40'}`}>{children}</div>
  );
}

function DayBoundaryStyleRow({ highlight }: { highlight?: string }) {
  const enabled = useChartPrefsStore((s) => s.dayBoundaryEnabled);
  const color = useChartPrefsStore((s) => s.dayBoundaryColor);
  const lineWidth = useChartPrefsStore((s) => s.dayBoundaryLineWidth);
  const setStyle = useChartPrefsStore((s) => s.setDayBoundaryStyle);

  return (
    <GatedStyleRow enabled={enabled}>
      <SettingsRow
        label={highlightLabel(DAY_BOUNDARY_STYLE_ROW.label, highlight)}
        description={DAY_BOUNDARY_STYLE_ROW.description}
      >
        <MAStylePicker
          color={color}
          lineWidth={lineWidth}
          onChange={setStyle}
          label="날짜 구분선"
          extraColors={[DAY_BOUNDARY_COLOR_DEFAULT]}
        />
      </SettingsRow>
    </GatedStyleRow>
  );
}

function TradeHighlightColorRow({ highlight }: { highlight?: string }) {
  const color = useChartPrefsStore((s) => s.tradeHighlightColor);
  const enabled = useChartPrefsStore((s) => s.tradeHighlightEnabled);
  const setColor = useChartPrefsStore((s) => s.setTradeHighlightColor);

  return (
    <GatedStyleRow enabled={enabled}>
      <SettingsRow
        label={highlightLabel(TRADE_HIGHLIGHT_COLOR_ROW.label, highlight)}
        description={TRADE_HIGHLIGHT_COLOR_ROW.description}
      >
        <ColorSwatchPicker
          label="대량 체결 강조 배경색"
          color={color}
          onChange={setColor}
          extraColors={[TRADE_HIGHLIGHT_COLOR_DEFAULT]}
        />
      </SettingsRow>
    </GatedStyleRow>
  );
}

function ViLimitPriceLineStyleRow({ highlight }: { highlight?: string }) {
  // 자기 토글(viLimitPriceDotsEnabled)과 같은 전역 스토어 — 원래는 스타일만
  // 지표 버킷(창×봉)에 있어 한 기능이 두 저장소로 쪼개져 있었다(#759 구현 중
  // 발견). 이 행이 전역이 되면서 설정 모달에 창 소유 필드가 하나도 남지 않는다.
  const enabled = useChartPrefsStore((s) => s.viLimitPriceDotsEnabled);
  const color = useChartPrefsStore((s) => s.viLimitPriceLineColor);
  const lineWidth = useChartPrefsStore((s) => s.viLimitPriceLineWidth);
  const setStyle = useChartPrefsStore((s) => s.setViLimitPriceLineStyle);

  return (
    <GatedStyleRow enabled={enabled}>
      <SettingsRow
        label={highlightLabel(VI_LINE_STYLE_ROW.label, highlight)}
        description={VI_LINE_STYLE_ROW.description}
      >
        <MAStylePicker
          color={color}
          lineWidth={lineWidth}
          onChange={setStyle}
          label="VI/상하한가 선"
        />
      </SettingsRow>
    </GatedStyleRow>
  );
}

function SectionHeading({ id, label }: { id: NavId; label: string }) {
  return (
    <h3
      data-settings-section={id}
      className="border-b border-border-strong pb-1 text-md font-semibold text-fg"
    >
      {label}
    </h3>
  );
}

/** 자유 마크업 섹션(알림·데이터소스·테마 …) — 내부 블록 간격은 종전 상세 패널의
 *  `space-y-3` 을 승계한다(각 섹션 본체가 그 간격을 전제로 짜여 있다). */
function InfoSection({ id, children }: { id: NavId; children: ReactNode }) {
  return (
    <section aria-label={LABEL[id]} className="mt-6">
      <SectionHeading id={id} label={LABEL[id]} />
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function InfoSectionBody({ id }: { id: (typeof INFO_ORDER)[number] }) {
  switch (id) {
    case 'alerts':
      return <SignalAlertSettingsSection />;
    case 'data-source':
      return <DataSourceDetail />;
    case 'theme':
      return <ThemeSection />;
    case 'symbols':
      return <SymbolMasterSection />;
    case 'general':
      return <GeneralSection />;
    case 'roadmap':
      return <RoadmapSection />;
  }
}

// 여기 있던 「저장뷰」 섹션(저장뷰를 열 때 적용할 기본 분봉)은 #1326 에서 제거됐다.
// 차트 창이 봉의 유일한 소유자가 되면서 그 설정이 정할 것이 없어졌다 — 저장뷰는
// 종목과 구간만 정한다. 근거와 버려진 trade-off 는 그 PR 에 있다.

export default function SettingsSections({ variant = 'live', onClose }: { variant?: 'live' | 'study'; onClose?: () => void }) {
  // 체결창은 /live 워크스페이스 전용 데이터 창 — 복기뷰(study) 설정에는 숨긴다.
  // **컨텍스트로 갈리는 유일한 항목**이다.
  const registryIds = CATEGORY_ORDER.filter((c) => (variant === 'live' || c !== 'trade-window')
    && CHART_TOGGLES.some((t) => categoryOf(t) === c));
  const navIds: NavId[] = [...registryIds, ...INFO_ORDER];

  const [query, setQuery] = useState('');
  const [active, setActive] = useState<NavId>(navIds[0]);
  const bodyRef = useRef<HTMLDivElement>(null);
  // 필터 중 TOC 클릭은 「필터 해제 → 점프」다. setState 직후엔 리마운트된 섹션
  // DOM 이 아직 없으므로 대상을 적어 두고 query 가 비워진 뒤의 effect 가 소비한다.
  const pendingJump = useRef<NavId | null>(null);

  const units = useMemo(buildFilterUnits, []);
  const trimmed = query.trim();
  const filtering = trimmed !== '';

  const sections = registryIds.map((category) => ({
    id: category,
    groups: CHART_TOGGLE_GROUPS
      .map((g) => ({
        ...g,
        units: units.filter((u) => u.category === category && u.group === g.id
          && (!filtering || u.corpus.includes(trimmed))),
      }))
      .filter((g) => g.units.length > 0),
  }));
  const anyMatch = sections.some((s) => s.groups.length > 0);

  const scrollToSection = (id: NavId) => {
    // jsdom 에는 scrollIntoView 가 없다 — 옵셔널 호출로 두 환경을 같이 산다.
    bodyRef.current?.querySelector(`[data-settings-section="${id}"]`)
      ?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  };

  const jump = (id: NavId) => {
    setActive(id);
    if (filtering) {
      pendingJump.current = id;
      setQuery('');
      return;
    }
    scrollToSection(id);
  };

  useEffect(() => {
    if (pendingJump.current !== null && trimmed === '') {
      scrollToSection(pendingJump.current);
      pendingJump.current = null;
    }
  }, [trimmed]);

  // 스크롤 스파이 — 컨테이너 상단(+60px 여유)을 지난 마지막 섹션 제목이 활성.
  // 클릭 경로는 위 `jump` 가 동기로 active 를 세우므로, 이 핸들러는 자유 스크롤만
  // 따라오면 된다(스무스 스크롤 중간 발화도 같은 계산이라 목적지에 수렴한다).
  const onScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    const top = body.getBoundingClientRect().top + 60;
    let current: NavId = navIds[0];
    for (const id of navIds) {
      const el = body.querySelector(`[data-settings-section="${id}"]`);
      if (el && el.getBoundingClientRect().top <= top) current = id;
    }
    setActive(current);
  };

  // 지표 패널과 동일한 크롬(중앙 모달, 2026-08-21): 전폭 헤더 바·푸터 없이 nav+콘텐츠가
  // 카드를 edge-to-edge로 채우고, 제목과 닫기 X는 콘텐츠 헤더가 담당.
  // nav↔콘텐츠 분리는 bg-subtle↔bg-card 톤 스텝. rounded-lg는 ModalShell 반경에 맞춰 클립.
  return (
    <div
      data-testid="settings-shell"
      className={WORKSPACE_PANEL_SHELL_CLASS}
    >
      <nav className="flex min-h-0 flex-col bg-bg-subtle" aria-label="설정 카테고리">
        <div className="p-2 pb-1">
          <div className="flex h-7 items-center gap-1.5 rounded-lg border border-border bg-bg-input px-2 focus-within:border-accent">
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" className="shrink-0 text-fg-dim">
              <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <line x1="10.2" y1="10.2" x2="13.5" y2="13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <input
              type="text"
              value={query}
              placeholder="설정 필터"
              aria-label="설정 필터"
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                // Escape 사다리: 검색어가 있으면 여기서 먹고(모달이 닫히지 않게
                // stopPropagation — ModalShell 리스너는 document 에 있다) 지운다.
                // 비어 있으면 그대로 흘려 패널이 닫힌다.
                if (event.key === 'Escape' && query !== '') {
                  event.stopPropagation();
                  setQuery('');
                }
              }}
              className="w-full bg-transparent text-sm text-fg placeholder:text-fg-dimmer focus-visible:outline-none"
            />
            {query !== '' && (
              <button
                type="button"
                aria-label="필터 지우기"
                onClick={() => setQuery('')}
                className="shrink-0 px-0.5 text-sm leading-none text-fg-dim transition-colors hover:text-fg"
              >
                ✕
              </button>
            )}
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2 pt-1">
          {navIds.map((id) => (
            <button
              key={id}
              type="button"
              data-testid={`settings-nav-${id}`}
              aria-current={active === id ? 'true' : undefined}
              onClick={() => jump(id)}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
                active === id
                  ? 'bg-tint-selection font-medium text-fg'
                  : 'text-fg-dim hover:bg-bg-input-hover hover:text-fg'
              }`}
            >
              {LABEL[id]}
            </button>
          ))}
        </div>
      </nav>
      <div className="flex min-h-0 flex-col">
        <header className="flex items-center justify-between px-5 pb-3 pt-4">
          <h2 className="text-lg font-semibold text-fg">설정</h2>
          {onClose && (
            <button
              type="button"
              aria-label="닫기"
              onClick={onClose}
              className="-mr-1 px-1 text-lg leading-none text-fg-dim transition-colors hover:text-fg"
            >
              ✕
            </button>
          )}
        </header>
        <div ref={bodyRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          {sections.map((section) => (
            (!filtering || section.groups.length > 0) && (
              <section key={section.id} aria-label={LABEL[section.id]} className="mt-6 first:mt-0">
                <SectionHeading id={section.id} label={LABEL[section.id]} />
                {section.groups.map((group) => (
                  <Fragment key={group.id}>
                    {!filtering && <GroupHead label={group.label} />}
                    {group.units.map((unit) => (
                      <Fragment key={unit.key}>
                        <IndicatorPrefRows toggleKeys={[unit.key]} highlight={filtering ? trimmed : undefined} />
                        {unit.key === 'dayBoundaryEnabled' && <DayBoundaryStyleRow highlight={filtering ? trimmed : undefined} />}
                        {unit.key === 'viLimitPriceDotsEnabled' && <ViLimitPriceLineStyleRow highlight={filtering ? trimmed : undefined} />}
                        {unit.key === 'tradeHighlightEnabled' && <TradeHighlightColorRow highlight={filtering ? trimmed : undefined} />}
                      </Fragment>
                    ))}
                  </Fragment>
                ))}
              </section>
            )
          ))}
          {filtering && !anyMatch && (
            <div className="mt-6 rounded-lg bg-bg-subtle px-4 py-6 text-center text-xs text-fg-dim">
              「{trimmed}」 에 맞는 설정이 없습니다 — 알림·데이터소스·테마 등 정보
              섹션은 필터 대상이 아닙니다
            </div>
          )}
          {!filtering && INFO_ORDER.map((id) => (
            <InfoSection key={id} id={id}>
              <InfoSectionBody id={id} />
            </InfoSection>
          ))}
        </div>
      </div>
    </div>
  );
}
