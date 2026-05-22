import { useEffect, useState } from 'react';
import { loadConfig, type AppConfig } from '../config';

const VERSION = 'v0.1.0';

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
      <p className="text-xs text-fg-dimmer pt-4">
        편집 가능한 설정은 v1+1에서 `/api/config` 라우트와 함께 제공 예정.
      </p>
    </div>
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
