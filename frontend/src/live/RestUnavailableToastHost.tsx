import { useEffect, useRef } from 'react';
import { useLiveSettings, usePatchLiveSettings } from '../api/liveSettings';
import { ToggleSwitch } from './settings/SettingsRow';
import { ToastCard } from '../ui/toast/ToastCard';
import { WARNING_CAUSE } from '../api/warningCopy';
import {
  markLegacyRestBypassMigrated,
  readLegacyRestBypass,
  useRestBypassModeStore,
} from '../state/restBypassMode';

/** 성격별 문구. **"연결 불가" 를 혼잡에 쓰지 않는다** — 서버가 멀쩡한데 죽었다고
 * 알리면 사용자가 할 수 있는 판단(기다릴까 우회할까)이 뒤집힌다(ADR-0137). */
const COPY = {
  transport: {
    title: WARNING_CAUSE.transport,
    body: '시세 서버에 연결할 수 없습니다. 저장 데이터로 표시할 수 있습니다',
    status: '재시도 중',
  },
  congestion: {
    // ⚠ `rate_limit` 원인 명사구는 아직 표면마다 다르다 — 스크리너는
    // '호출 한도 초과'(원인)이고 여기는 '시세 서버 혼잡'(상태)이다. 어느 쪽이
    // 옳은지가 정보량 판단이라 통일 대상으로 남겨 두었다(ADR-0143 §5).
    title: '시세 서버 혼잡',
    body: '요청이 몰려 일부 구간을 받지 못했습니다. 잠시 후 자동으로 다시 받습니다',
    status: '대기 중',
  },
} as const;

export default function RestUnavailableToastHost() {
  const { data: settings } = useLiveSettings();
  const patch = usePatchLiveSettings();
  const lastToastAtMs = useRestBypassModeStore((s) => s.lastToastAtMs);
  const lastKind = useRestBypassModeStore((s) => s.lastKind);
  const toastDismissed = useRestBypassModeStore((s) => s.toastDismissed);
  const dismissToast = useRestBypassModeStore((s) => s.dismissToast);
  const restBypassEnabled = settings?.rest_bypass_enabled ?? false;

  // 레거시 로컬 우회 → 백엔드 마이그레이션은 마운트당 1회만 시도한다. 낙관적 업데이트가
  // settings 캐시를 잠깐 뒤집었다 롤백하면 effect가 재발화하는데, 이 가드가 없으면
  // 실패 시 PATCH가 여러 번 나가 오실레이션한다(테스트 flaky). 실패해도 로컬은 보존되어
  // 다음 세션(remount)에 재시도한다.
  const migrationAttemptedRef = useRef(false);
  useEffect(() => {
    if (!settings || settings.rest_bypass_enabled || migrationAttemptedRef.current) return;
    const legacy = readLegacyRestBypass();
    if (legacy?.restBypassEnabled) {
      migrationAttemptedRef.current = true;
      patch.mutate(
        { rest_bypass_enabled: true },
        { onSuccess: () => markLegacyRestBypassMigrated() },
      );
    }
  }, [settings, patch]);

  // 우회가 켜지면 토스트의 목적(우회 유도)이 달성되므로 자동으로 닫는다.
  // 쿨다운 중엔 재실패로 다시 뜨지 않고, 우회를 끄면 다음 실패 시 재알림된다.
  useEffect(() => {
    if (restBypassEnabled && lastToastAtMs != null && !toastDismissed) {
      dismissToast();
    }
  }, [restBypassEnabled, lastToastAtMs, toastDismissed, dismissToast]);

  // 가시성만 계산해 ToastCard 에 내린다 — dismiss(× 또는 우회 ON) 시 카드가
  // exit 애니메이션을 재생하고 스스로 언마운트한다. 스택/위치는 ToastViewport 소유.
  const visible = lastToastAtMs != null && !toastDismissed;
  // 성격이 없으면(구버전 상태 등) 보수적으로 연결 실패 문구 — 혼잡을 연결 불가로
  // 읽는 쪽이 그 반대보다 덜 위험하다(사용자가 우회를 켜면 그만이다).
  const copy = COPY[lastKind ?? 'transport'];

  return (
    <ToastCard visible={visible} variant="warn" role="status">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium text-fg">{copy.title}</div>
        <button
          type="button"
          aria-label="닫기"
          onClick={dismissToast}
          className="-mr-1 -mt-0.5 shrink-0 text-base leading-none text-fg-dim hover:text-fg"
        >
          ✕
        </button>
      </div>
      <div className="mt-1 text-xs text-fg-dim">{copy.body}</div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="text-xs text-fg-dim">
          {restBypassEnabled ? 'REST 우회 중' : copy.status}
        </div>
        <ToggleSwitch
          label="REST 우회"
          checked={restBypassEnabled}
          onClick={() => patch.mutate({ rest_bypass_enabled: !restBypassEnabled })}
        />
      </div>
    </ToastCard>
  );
}
