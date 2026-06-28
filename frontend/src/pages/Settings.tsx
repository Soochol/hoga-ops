import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { loadConfig, type AppConfig } from '../config';
import { getSymbolMasterInfo, refreshSymbols } from '../api/symbols';
import { SYMBOLS_QUERY_KEY } from '../capture/useSymbols';
import { symbolMasterSettingsHints } from '../api/upstream-hints';
import { PageContainer } from '../layout/PageContainer';
import { DefinitionRow, PanelCard, ToolbarButton } from '../ui/PageShell';

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
    <PageContainer className="grid grid-cols-[minmax(0,42rem)] content-start">
      <PanelCard as="section" className="p-md flex flex-col gap-md text-sm">
        <DefinitionRow label="API URL" value={config?.api_url ?? '…'} />
        <DefinitionRow label="Version" value={VERSION} />
        <SymbolMasterSection />
        <p className="text-xs text-fg-dimmer pt-sm border-t border-border">
          편집 가능한 설정은 v1+1에서 `/api/config` 라우트와 함께 제공 예정.
        </p>
      </PanelCard>
    </PageContainer>
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
    <section className="space-y-2 pt-md border-t border-border">
      <h3 className="text-sm font-semibold">Symbol Master</h3>
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
