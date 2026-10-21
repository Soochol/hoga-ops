import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { loadConfig, type AppConfig } from '../../config';
import { apiCall } from '../../api/client';
import { DefinitionRow, SegmentedControl } from '../../ui/PageShell';
import { THEME_PREFERENCE_OPTIONS, useThemePrefsStore, type ThemePreference } from '../../state/themePrefs';

/**
 * 앱 스코프 설정 섹션들 — 「앱 정보」·「테마」.
 *
 * `pages/Settings.tsx` 가 자체 마스터-디테일 셸을 들고 있던 시절의 본체다. 설정 표면이
 * 하나로 합쳐지면서(우측 드로어) 셸은 `SettingsSections` 로 단일화됐고, 섹션 본체는
 * 다른 상세들(`DataSourceDetail` 등)과 같은 자리인 여기로 내려왔다. 페이지 프레임
 * (`/settings` 라우트)은 이제 그 통합 컴포넌트를 감싸기만 한다.
 */

const HEALTH_QUERY_KEY = ['health'] as const;

/** /health 응답 — 리포 루트 VERSION 파일이 버전의 단일 진실(#998)이라 프론트에
 *  버전을 다시 하드코딩하지 않는다(이전의 'v0.1.0' 상수는 실제 0.12.x 와 어긋난
 *  채 표시되고 있었다). commit 은 "지금 뜬 코드가 그 코드인가"에 답한다. */
type HealthInfo = { status: string; version: string; commit?: string };

export function GeneralSection() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState('');
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
    }).catch(() => {
      if (!cancelled) setConfigError('연결 설정을 읽지 못했습니다.');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <DefinitionRow label="API URL" value={config?.api_url ?? '…'} />
      {configError && <p role="status" className="text-xs text-error">{configError}</p>}
      <DefinitionRow label="Version" value={versionText} />
    </>
  );
}

const THEME_LABEL: Record<ThemePreference, string> = {
  obsidian: 'Obsidian',
  ledger: 'Ledger',
  'toss-light': 'Toss Light',
  'toss-dark': 'Toss Dark',
  'obsidian-pro': 'Obsidian Pro',
  'ledger-studio': 'Ledger Studio',
  'trading-desk': 'Trading Desk',
};

const THEME_HINT: Record<ThemePreference, string> = {
  obsidian: '차분한 다크 테마',
  ledger: '종이 느낌의 라이트 테마',
  'toss-light': '흰 배경과 파란 강조색',
  'toss-dark': '어두운 배경과 파란 강조색',
  'obsidian-pro': '흑연색 배경과 앰버 강조색 · 장중 모니터링',
  'ledger-studio': '아이보리 배경과 포레스트 그린 · 장후 복기와 리서치',
  'trading-desk': '올리브 블랙과 라임 강조색 · 트레이딩 데스크',
};

export function ThemeSection() {
  const themePreference = useThemePrefsStore((s) => s.themePreference);
  const setThemePreference = useThemePrefsStore((s) => s.setThemePreference);
  return (
    <section className="space-y-2">
      <SegmentedControl aria-label="테마 선택" className="max-w-full flex-wrap">
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
