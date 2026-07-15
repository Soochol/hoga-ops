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
import { DefinitionRow, SegmentedControl, ToolbarButton } from '../ui/PageShell';
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
  // /settings 라우트(SymbolSearch 링크 1곳에서 도달)의 페이지 프레임. 모달 밖에서는
  // 다이얼로그 크롬이 없으므로 여기서 카드 프레임을 씌워 full-bleed 패널을 담는다.
  return (
    <PageContainer className="grid grid-cols-[minmax(0,52rem)] content-start">
      <div className="h-[min(40rem,72vh)] overflow-hidden rounded-lg border border-border shadow-panel">
        <SettingsPanel />
      </div>
    </PageContainer>
  );
}

export function SettingsPanel({ onClose }: { onClose?: () => void }) {
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

  // 카드 크롬 없이 다이얼로그를 edge-to-edge로 채운다. nav↔콘텐츠 분리는 보더가 아니라
  // bg-subtle↔bg-card 톤 스텝이 담당(2026-07-15 borderless 규칙). rounded-[6px]는
  // ModalShell 다이얼로그 반경에 맞춰 코너를 클립한다(ModalShell 전역 overflow는
  // MAStylePicker 드롭다운을 잘라먹으므로 국소 처리).
  return (
    <section
      data-testid="settings-page-primary"
      className="grid h-full min-h-[20rem] grid-cols-[176px_minmax(0,1fr)] overflow-hidden rounded-[6px] bg-bg-card text-sm"
    >
      <nav className="space-y-0.5 overflow-y-auto bg-bg-subtle p-2" aria-label="설정 카테고리">
        {SECTIONS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            data-testid={`settings-nav-${id}`}
            aria-current={selected === id ? 'true' : undefined}
            onClick={() => setSelected(id)}
            className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-sm transition-colors ${
              selected === id
                ? 'bg-tint-selection font-medium text-fg'
                : 'text-fg-dim hover:bg-bg-input-hover hover:text-fg'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="flex min-h-0 flex-col" data-settings-detail={selected}>
        <header className="flex items-center justify-between px-5 pb-3 pt-4">
          <h2 className="text-lg font-semibold text-fg">{SECTION_LABEL[selected]}</h2>
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
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-5">
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
        </div>
      </div>
    </section>
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
  // 기본 False: 스캔은 탐색적 반복 실행이라 묵시적 큐 증가를 막는다(명시적 버튼이 1차 UX).
  const autoCollect = data?.screener_depth_autocollect ?? false;
  // isError는 비활성 사유가 아니다 — PATCH는 partial(heatmap 필드만 전송)이라
  // GET 실패로 현재값을 몰라도 조작이 안전하고, 복구 조작을 열어둔다.
  const busy = isLoading || patch.isPending;

  return (
    <section className="space-y-2">
      <SettingsRow
        label="히트맵 종목 API 수집"
        description="히트맵에 담긴 종목의 10호가를 KIS REST로 주기적으로 수집·저장합니다(총잔량 등). 체결·거래원은 관심종목(WS) 전용입니다. 끄면 히트맵 전용 종목의 수집만 멈춥니다(관심종목 수집에는 영향 없음)."
        testId="settings-heatmap-capture-row"
      >
        <ToggleSwitch
          label="히트맵 종목 API 수집"
          checked={enabled}
          disabled={busy}
          onClick={() => patch.mutate({ heatmap_capture_enabled: !enabled })}
        />
      </SettingsRow>
      <SettingsRow
        label="스크리너 총잔량 결측 자동 수집"
        description="스크리너 총잔량 신고 조건에서 hogaplay 과거 데이터가 없는 종목을 발견하면 지난 N일치를 자동으로 수집 큐에 적재합니다. 끄면(기본) 결과 배너의 [수집 요청] 버튼으로만 수집합니다."
        testId="settings-depth-autocollect-row"
      >
        <ToggleSwitch
          label="스크리너 총잔량 결측 자동 수집"
          checked={autoCollect}
          disabled={busy}
          onClick={() => patch.mutate({ screener_depth_autocollect: !autoCollect })}
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
