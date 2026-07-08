import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { loadConfig, type AppConfig } from '../config';
import { getSymbolMasterInfo, refreshSymbols } from '../api/symbols';
import { SYMBOLS_QUERY_KEY } from '../capture/useSymbols';
import { symbolMasterSettingsHints } from '../api/upstream-hints';
import { PageContainer } from '../layout/PageContainer';
import { DataSection } from '../ui/DataSurface';
import { DefinitionRow, PanelCard, SegmentedControl, ToolbarButton } from '../ui/PageShell';
import { THEME_PREFERENCE_OPTIONS, useThemePrefsStore, type ThemePreference } from '../state/themePrefs';

const VERSION = 'v0.1.0';
const SYMBOLS_INFO_QUERY_KEY = ['symbols', 'info'] as const;

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
    <PageContainer className="grid grid-cols-[minmax(0,42rem)] content-start">
      <SettingsPanel />
    </PageContainer>
  );
}

export function SettingsPanel() {
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
    <PanelCard as="section" data-testid="settings-page-primary" className="flex flex-col overflow-hidden text-sm">
      <DataSection title="앱 정보" contentClassName="space-y-3 p-md">
        <DefinitionRow label="API URL" value={config?.api_url ?? '…'} />
        <DefinitionRow label="Version" value={VERSION} />
      </DataSection>
      <DataSection title="테마" contentClassName="space-y-3 p-md">
        <ThemeSection />
      </DataSection>
      <DataSection title="Symbol Master" contentClassName="space-y-3 p-md">
        <SymbolMasterSection />
      </DataSection>
      <DataSection title="로드맵" contentClassName="p-md">
        <p className="text-xs text-fg-dimmer">
          편집 가능한 설정은 v1+1에서 `/api/config` 라우트와 함께 제공 예정.
        </p>
      </DataSection>
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
