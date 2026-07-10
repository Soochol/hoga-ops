import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { loadConfig, type AppConfig } from '../config';
import { getSymbolMasterInfo, refreshSymbols } from '../api/symbols';
import { SYMBOLS_QUERY_KEY } from '../capture/useSymbols';
import { symbolMasterSettingsHints } from '../api/upstream-hints';
import { useLiveSettings, usePatchLiveSettings } from '../api/liveSettings';
import { SettingsRow, ToggleSwitch } from '../live/settings/SettingsRow';
import { DataSourceDetail } from '../live/settings/DataSourceDetail';
import { PageContainer } from '../layout/PageContainer';
import { DataSection } from '../ui/DataSurface';
import { DefinitionRow, PanelCard, SegmentedControl, ToolbarButton } from '../ui/PageShell';
import { THEME_PREFERENCE_OPTIONS, useThemePrefsStore, type ThemePreference } from '../state/themePrefs';

const VERSION = 'v0.1.0';
const SYMBOLS_INFO_QUERY_KEY = ['symbols', 'info'] as const;

type SectionId = 'general' | 'theme' | 'source' | 'data' | 'symbols' | 'roadmap';

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'general', label: '앱 정보' },
  { id: 'theme', label: '테마' },
  { id: 'source', label: '데이터 소스' },
  { id: 'data', label: '데이터 수집' },
  { id: 'symbols', label: 'Symbol Master' },
  { id: 'roadmap', label: '로드맵' },
];

const SECTION_LABEL: Record<SectionId, string> = Object.fromEntries(
  SECTIONS.map((s) => [s.id, s.label]),
) as Record<SectionId, string>;

function formatRelative(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'Never';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} hour ago`;
  return `${Math.floor(delta / 86_400_000)} days ago`;
}

export default function Settings() {
  return (
    <PageContainer className="grid grid-cols-[minmax(0,52rem)] content-start">
      <SettingsPanel />
    </PageContainer>
  );
}

export function SettingsPanel() {
  const [selected, setSelected] = useState<SectionId>('general');
  const [config, setConfig] = useState<AppConfig | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadConfig().then((c) => {
      if (!cancelled) setConfig(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PanelCard
      as="section"
      data-testid="settings-page-primary"
      className="grid min-h-[20rem] grid-cols-[180px_minmax(0,1fr)] overflow-hidden text-sm"
    >
      <nav className="overflow-y-auto py-2 border-r border-border bg-bg-card" aria-label="설정 카테고리">
        {SECTIONS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            data-testid={`settings-nav-${id}`}
            aria-current={selected === id ? 'true' : undefined}
            onClick={() => setSelected(id)}
            className={`flex w-full items-center rounded-none border-l-2 px-4 py-2 text-left text-sm transition-colors ${
              selected === id
                ? 'border-accent bg-tint-selection text-fg'
                : 'border-transparent text-fg-dim hover:bg-bg-input-hover hover:text-fg'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="min-h-0 overflow-y-auto" data-settings-detail={selected}>
        <DataSection title={SECTION_LABEL[selected]} contentClassName="space-y-3 p-md">
          {selected === 'general' && (
            <>
              <DefinitionRow label="API URL" value={config?.api_url ?? '…'} />
              <DefinitionRow label="Version" value={VERSION} />
            </>
          )}
          {selected === 'theme' && <ThemeSection />}
          {selected === 'source' && <DataSourceDetail variant="live" />}
          {selected === 'data' && <DataCollectionSection />}
          {selected === 'symbols' && <SymbolMasterSection />}
          {selected === 'roadmap' && (
            <p className="text-xs text-fg-dimmer">
              편집 가능한 설정은 v1+1에서 `/api/config` 라우트와 함께 제공 예정.
            </p>
          )}
        </DataSection>
      </div>
    </PanelCard>
  );
}

const THEME_LABEL: Record<ThemePreference, string> = {
  obsidian: 'Obsidian',
  ledger: 'Ledger',
  auto: '자동',
};

const THEME_HINT: Record<ThemePreference, string> = {
  obsidian: '어두운 트레이딩 터미널 테마',
  ledger: '밝은 종이·리서치 테마',
  auto: '화면별 — 실시간·히트맵은 어둡게, 나머지는 밝게',
};

function ThemeSection() {
  const themePreference = useThemePrefsStore((s) => s.themePreference);
  const setThemePreference = useThemePrefsStore((s) => s.setThemePreference);
  return (
    <section className="space-y-2">
      <SegmentedControl aria-label="테마 선택">
        {THEME_PREFERENCE_OPTIONS.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={themePreference === value}
            onClick={() => setThemePreference(value)}
            className={`px-3 py-[7px] text-sm ${themePreference === value ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover'}`}
          >
            {THEME_LABEL[value]}
          </button>
        ))}
      </SegmentedControl>
      <p className="text-xs text-fg-dimmer">{THEME_HINT[themePreference]}</p>
    </section>
  );
}

function DataCollectionSection() {
  const { data, isLoading, isError } = useLiveSettings();
  const patch = usePatchLiveSettings();
  // 기본 True: ADR-0097 도입 당시의 무조건 히트맵 합류 동작을 낙관적으로 반영.
  const enabled = data?.heatmap_capture_enabled ?? true;
  // isError는 비활성 사유가 아니다 — PATCH는 partial(heatmap 필드만 전송)이라
  // GET 실패로 현재값을 몰라도 조작이 안전하고, 복구 조작을 열어둔다.
  const busy = isLoading || patch.isPending;

  return (
    <section className="space-y-2">
      <SettingsRow
        label="히트맵 종목 API 수집"
        description="히트맵에 담긴 종목의 10호가·체결·거래원을 KIS REST로 30초마다 수집·저장합니다. 끄면 히트맵 전용 종목의 수집만 멈춥니다(관심종목 수집에는 영향 없음)."
        testId="settings-heatmap-capture-row"
      >
        <ToggleSwitch
          label="히트맵 종목 API 수집"
          checked={enabled}
          disabled={busy}
          onClick={() => patch.mutate({ heatmap_capture_enabled: !enabled })}
        />
      </SettingsRow>
      {isError && (
        <p className="text-xs text-error">라이브 설정을 불러오지 못했습니다. 백엔드 연결을 확인하세요.</p>
      )}
    </section>
  );
}

function SymbolMasterSection() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: SYMBOLS_INFO_QUERY_KEY,
    queryFn: getSymbolMasterInfo,
    refetchOnWindowFocus: false,
  });
  const [updating, setUpdating] = useState(false);

  const handleUpdate = async () => {
    setUpdating(true);
    try {
      await refreshSymbols();
      await queryClient.invalidateQueries({ queryKey: SYMBOLS_INFO_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: SYMBOLS_QUERY_KEY });
    } finally {
      setUpdating(false);
    }
  };

  return (
    <section className="space-y-2">
      <DefinitionRow label="Items" value={data ? data.count.toLocaleString() : (isLoading ? '…' : '0')} />
      <DefinitionRow label="Last fetched" value={formatRelative(data?.fetched_at_ms)} />
      <DefinitionRow label="Status" value={data?.status ?? '…'} />
      {data?.reason && (
        <div className="text-xs text-error">{symbolMasterSettingsHints[data.reason]}</div>
      )}
      <ToolbarButton
        type="button"
        onClick={handleUpdate}
        disabled={updating || isLoading}
        className="mt-2"
      >
        {updating ? 'Updating… (~30-120s)' : 'Update Now'}
      </ToolbarButton>
    </section>
  );
}
