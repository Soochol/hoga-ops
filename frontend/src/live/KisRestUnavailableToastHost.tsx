import { useEffect } from 'react';
import { useLiveSettings, usePatchLiveSettings } from '../api/liveSettings';
import { ToggleSwitch } from './settings/SettingsRow';
import {
  markLegacyKisRestBypassMigrated,
  readLegacyKisRestBypass,
  useKisRestModeStore,
} from '../state/kisRestMode';

export default function KisRestUnavailableToastHost() {
  const { data: settings } = useLiveSettings();
  const patch = usePatchLiveSettings();
  const lastToastAtMs = useKisRestModeStore((s) => s.lastToastAtMs);
  const kisRestBypassEnabled = settings?.kis_rest_bypass_enabled ?? false;

  useEffect(() => {
    if (!settings || settings.kis_rest_bypass_enabled) return;
    const legacy = readLegacyKisRestBypass();
    if (legacy?.kisRestBypassEnabled) {
      patch.mutate(
        { kis_rest_bypass_enabled: true },
        { onSuccess: () => markLegacyKisRestBypassMigrated() },
      );
    }
  }, [settings, patch]);

  if (lastToastAtMs == null) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-[calc(var(--rail-w)+12px)] top-[calc(var(--h-top-nav)+12px)] z-[91] w-[20rem]"
    >
      <div className="pointer-events-auto rounded border border-warn bg-bg-card px-3 py-3 text-left shadow-lg">
        <div className="text-sm font-medium text-fg">KIS 연결 불가</div>
        <div className="mt-1 text-xs text-fg-dim">
          외부 KIS API에 연결할 수 없습니다. 저장 데이터로 표시할 수 있습니다.
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="text-xs text-fg-dim">{kisRestBypassEnabled ? 'KIS REST 우회 중' : 'KIS API 재시도'}</div>
          <ToggleSwitch
            label="KIS API 우회"
            checked={kisRestBypassEnabled}
            onClick={() => patch.mutate({ kis_rest_bypass_enabled: !kisRestBypassEnabled })}
          />
        </div>
      </div>
    </div>
  );
}
