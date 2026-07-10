import { useEffect, useRef } from 'react';
import { useLiveSettings, usePatchLiveSettings } from '../api/liveSettings';
import { ToggleSwitch } from './settings/SettingsRow';
import { ToastCard } from '../ui/toast/ToastCard';
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

  // 레거시 로컬 우회 → 백엔드 마이그레이션은 마운트당 1회만 시도한다. 낙관적 업데이트가
  // settings 캐시를 잠깐 뒤집었다 롤백하면 effect가 재발화하는데, 이 가드가 없으면
  // 실패 시 PATCH가 여러 번 나가 오실레이션한다(테스트 flaky). 실패해도 로컬은 보존되어
  // 다음 세션(remount)에 재시도한다.
  const migrationAttemptedRef = useRef(false);
  useEffect(() => {
    if (!settings || settings.kis_rest_bypass_enabled || migrationAttemptedRef.current) return;
    const legacy = readLegacyKisRestBypass();
    if (legacy?.kisRestBypassEnabled) {
      migrationAttemptedRef.current = true;
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

  // 가시성만 계산해 ToastCard 에 내린다 — dismiss(× 또는 우회 ON) 시 카드가
  // exit 애니메이션을 재생하고 스스로 언마운트한다. 스택/위치는 ToastViewport 소유.
  const visible = lastToastAtMs != null && !toastDismissed;

  return (
    <ToastCard visible={visible} variant="warn" role="status">
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
    </ToastCard>
  );
}
