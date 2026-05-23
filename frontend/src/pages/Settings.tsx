import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { loadConfig, type AppConfig } from '../config';
import { getSymbolMasterInfo, refreshSymbols } from '../api/symbols';
import { SYMBOLS_QUERY_KEY } from '../capture/useSymbols';
import { symbolMasterSettingsHints } from '../api/upstream-hints';
import { loadForceRetryDefault, saveForceRetryDefault } from '../capture/forceRetryDefault';

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
    <div className="p-8 max-w-2xl space-y-4 text-sm">
      <h2 className="text-md font-semibold">Settings</h2>
      <Row label="API URL" value={config?.api_url ?? '…'} />
      <Row label="Version" value={VERSION} />
      <SymbolMasterSection />
      <CaptureDefaultsSection />
      <p className="text-xs text-fg-dimmer pt-4">
        편집 가능한 설정은 v1+1에서 `/api/config` 라우트와 함께 제공 예정.
      </p>
    </div>
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
    <section className="space-y-2 pt-4 border-t border-border">
      <h3 className="text-sm font-semibold">Symbol Master</h3>
      <Row label="Items" value={data ? data.count.toLocaleString() : (isLoading ? '…' : '0')} />
      <Row label="Last fetched" value={formatRelative(data?.fetched_at_ms)} />
      <Row label="Status" value={data?.status ?? '…'} />
      {data?.reason && (
        <div className="text-xs text-error">{symbolMasterSettingsHints[data.reason]}</div>
      )}
      <button
        type="button"
        onClick={handleUpdate}
        disabled={updating || isLoading}
        className="mt-2 bg-bg-input border border-border rounded-md px-sm py-xs text-fg hover:text-fg cursor-pointer font-[inherit] text-sm disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {updating ? 'Updating… (~30-120s)' : 'Update Now'}
      </button>
    </section>
  );
}

function CaptureDefaultsSection() {
  const [forceRetryDefault, setForceRetryDefault] = useState<boolean>(
    () => loadForceRetryDefault(),
  );
  const onToggle = () => {
    const next = !forceRetryDefault;
    setForceRetryDefault(next);
    saveForceRetryDefault(next);
  };
  return (
    <section className="space-y-2 pt-4 border-t border-border">
      <h3 className="text-sm font-semibold">Capture defaults</h3>
      <label className="flex gap-2 items-center text-sm text-fg">
        <input
          type="checkbox"
          checked={forceRetryDefault}
          onChange={onToggle}
          data-testid="settings-force-retry-default"
        />
        <span>⚠ Force re-capture source-partial dates</span>
      </label>
      <p className="text-xs text-fg-dimmer">
        새 캡처를 시작할 때 이 옵션이 기본으로 켜집니다. 캡처 폼에서 매번 토글할 수 있습니다.
      </p>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 items-center">
      <span className="text-xs uppercase tracking-wider text-fg-dimmer">{label}</span>
      <span className="font-mono text-xs">{value}</span>
    </div>
  );
}
