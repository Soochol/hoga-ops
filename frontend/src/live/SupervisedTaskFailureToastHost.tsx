import { useState } from 'react';
import { ToastCard } from '../ui/toast/ToastCard';
import { deadSupervisedTasks, useLiveStatus } from '../api/liveStatus';

/** 토스트에 나열할 태스크 이름 수 — 넘치면 "외 N개"로 접는다. */
const VISIBLE_NAMES = 2;

/**
 * 조용히 죽은 배경 태스크 알림.
 *
 * ADR-0088 은 자동 재시작 감독자 대신 **관측 노출**을 택했다("보이는 죽음은 감지
 * 가능한 죽음"). 그런데 그 노출이 API 에서 멈춰 있었다 — `supervised_tasks` 를 읽는
 * 프론트 소비처가 하나도 없어서, 일일 스케줄러·today-promoter·키움 워치독·캡처
 * 워커가 죽어도 `curl` 을 치는 사람만 알 수 있었다. 이 호스트가 그 마지막 1마일이다.
 *
 * 프로세스 재시작 외에 복구 수단이 없으므로 문구는 그 조치를 지시한다.
 * `state === 'dead'` 만 경보한다 — 미기동(env 로 끈 기능)을 경보하면 배너가 상시
 * 켜진다(자세한 근거는 liveStatus.ts::SupervisedTask).
 *
 * 상태를 zustand 로 빼지 않은 이유: 사망은 status 폴링(5초)에서 파생되는 값이고,
 * 되살아나면 자동으로 사라져야 한다. 별도 스토어를 두면 그 소멸을 손으로 관리해야 한다.
 * 닫기만 로컬 상태로 들고, 다른 태스크가 새로 죽으면 다시 띄운다.
 */
export default function SupervisedTaskFailureToastHost() {
  const { data: status } = useLiveStatus();
  const dead = deadSupervisedTasks(status);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  // 죽은 태스크 집합이 바뀌면(새로 죽음) 닫았던 토스트를 다시 띄운다.
  const key = dead.join(',');
  const visible = dead.length > 0 && dismissedKey !== key;

  const shown = dead.slice(0, VISIBLE_NAMES).join(', ');
  const overflow = dead.length - VISIBLE_NAMES;

  return (
    <ToastCard visible={visible} variant="error" role="status">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium text-fg">백그라운드 작업이 중단됐습니다</div>
        <button
          type="button"
          aria-label="닫기"
          onClick={() => setDismissedKey(key)}
          className="-mr-1 -mt-0.5 shrink-0 text-base leading-none text-fg-dim hover:text-fg"
        >
          ✕
        </button>
      </div>
      <div className="mt-1 text-xs text-fg-dim">
        {shown}
        {overflow > 0 ? ` 외 ${overflow}개` : ''}
        가 정지했습니다. 자동 복구되지 않으므로 서버를 재시작해야 합니다.
      </div>
    </ToastCard>
  );
}
