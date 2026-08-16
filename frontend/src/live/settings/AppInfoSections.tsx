import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { loadConfig, type AppConfig } from '../../config';
import { apiCall } from '../../api/client';
import { getSymbolMasterInfo, refreshSymbols } from '../../api/symbols';
import { SYMBOLS_QUERY_KEY } from '../../capture/useSymbols';
import { symbolMasterSettingsHints } from '../../api/upstream-hints';
import { DefinitionRow, SegmentedControl, ToolbarButton } from '../../ui/PageShell';
import { THEME_PREFERENCE_OPTIONS, useThemePrefsStore, type ThemePreference } from '../../state/themePrefs';

/**
 * 앱 스코프 설정 섹션들 — 「앱 정보」·「테마」·「Symbol Master」·「로드맵」.
 *
 * `pages/Settings.tsx` 가 자체 마스터-디테일 셸을 들고 있던 시절의 본체다. 설정 표면이
 * 하나로 합쳐지면서(우측 드로어) 셸은 `SettingsSections` 로 단일화됐고, 섹션 본체는
 * 다른 상세들(`DataSourceDetail` 등)과 같은 자리인 여기로 내려왔다. 페이지 프레임
 * (`/settings` 라우트)은 이제 그 통합 컴포넌트를 감싸기만 한다.
 *
 * 옛 「데이터 수집」 섹션은 여기 없다 — 토글 1개짜리 섹션이라 캡처 쓰기 설정이 모여
 * 있는 `DataSourceDetail` 의 「캡처 저장」 그룹으로 흡수됐다.
 */

const SYMBOLS_INFO_QUERY_KEY = ['symbols', 'info'] as const;
const HEALTH_QUERY_KEY = ['health'] as const;

/** /health 응답 — 리포 루트 VERSION 파일이 버전의 단일 진실(#998)이라 프론트에
 *  버전을 다시 하드코딩하지 않는다(이전의 'v0.1.0' 상수는 실제 0.12.x 와 어긋난
 *  채 표시되고 있었다). commit 은 "지금 뜬 코드가 그 코드인가"에 답한다. */
type HealthInfo = { status: string; version: string; commit?: string };

function formatRelative(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'Never';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} hour ago`;
  return `${Math.floor(delta / 86_400_000)} days ago`;
}

export function GeneralSection() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const healthQuery = useQuery({
    queryKey: HEALTH_QUERY_KEY,
    queryFn: () => apiCall<HealthInfo>('/health'),
    staleTime: Infinity, // 버전은 프로세스 수명 동안 불변 — 재조회 무의미
  });
  const versionText = healthQuery.data
    ? `v${healthQuery.data.version}${healthQuery.data.commit ? ` (${healthQuery.data.commit})` : ''}`
    : '…';
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
    <>
      <DefinitionRow label="API URL" value={config?.api_url ?? '…'} />
      <DefinitionRow label="Version" value={versionText} />
    </>
  );
}

const THEME_LABEL: Record<ThemePreference, string> = {
  obsidian: 'Obsidian',
  ledger: 'Ledger',
  'toss-light': 'Toss Light',
  'toss-dark': 'Toss Dark',
  auto: '자동',
};

const THEME_HINT: Record<ThemePreference, string> = {
  obsidian: '어두운 트레이딩 터미널 테마',
  ledger: '밝은 종이·리서치 테마',
  'toss-light': '밝은 토스증권 벤치마크 테마 (화이트·토스블루)',
  'toss-dark': '어두운 토스증권 벤치마크 테마 (near-black·토스블루)',
  auto: '화면별 — 실시간·히트맵은 어둡게, 나머지는 밝게',
};

export function ThemeSection() {
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
      <p className="text-xs text-fg-dim">{THEME_HINT[themePreference]}</p>
    </section>
  );
}

export function SymbolMasterSection() {
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

export function RoadmapSection() {
  return (
    <p className="text-xs text-fg-dim">
      편집 가능한 설정은 v1+1에서 `/api/config` 라우트와 함께 제공 예정.
    </p>
  );
}
