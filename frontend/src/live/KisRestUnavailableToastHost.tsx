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
  const toastDismissed = useKisRestModeStore((s) => s.toastDismissed);
  const dismissToast = useKisRestModeStore((s) => s.dismissToast);
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

  // 우회가 켜지면 토스트의 목적(우회 유도)이 달성되므로 자동으로 닫는다.
  // 쿨다운 중엔 재실패로 다시 뜨지 않고, 우회를 끄면 다음 실패 시 재알림된다.
  useEffect(() => {
    if (kisRestBypassEnabled && lastToastAtMs != null && !toastDismissed) {
      dismissToast();
    }
  }, [kisRestBypassEnabled, lastToastAtMs, toastDismissed, dismissToast]);

  if (lastToastAtMs == null || toastDismissed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-[calc(var(--rail-w)+12px)] top-[calc(var(--h-top-nav)+12px)] z-[91] w-[20rem]"
    >
      <div className="pointer-events-auto rounded border border-warn bg-bg-card px-3 py-3 text-left shadow-lg">
        <div className="flex items-start justify-between gap-2">
          <div className="text-sm font-medium text-fg">KIS 연결 불가</div>
          <button
            type="button"
            aria-label="닫기"
            onClick={dismissToast}
            className="-mr-1 -mt-0.5 shrink-0 text-base leading-none text-fg-dim hover:text-fg"
          >
            ✕
          </button>
        </div>
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
