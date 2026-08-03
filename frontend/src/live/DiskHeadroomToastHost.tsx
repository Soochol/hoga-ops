import { useState } from 'react';
import { ToastCard } from '../ui/toast/ToastCard';
import { useLiveStatus } from '../api/liveStatus';

/** 이 아래로는 경고가 아니라 위험이다 — 만수까지의 시간이 하루 단위로 줄어든다. */
const CRITICAL_FREE_PCT = 5;

/**
 * 디스크 여유 경고.
 *
 * 왜 필요한가: raw 는 거래일당 ~33GB 씩 자라는데(2026-08-03 실측), 그 잠식의
 * 능동 신호가 하루 한 번 17:00 스케줄러 로그 한 줄뿐이었다. 가득 차는 순간
 * 캡처 TSV·meta·라이브 JSONL append 가 전부 ENOSPC 로 죽지만 `/health` 는 200 이고
 * (얕은 쪽은 물론이고 deep 도 디스크로는 503 을 내지 않는다 — 재시작이 디스크를
 * 비우지 못하므로 워치독을 부르는 건 틀린 조치다), 결국 사용자들의 "오늘 데이터가
 * 왜 없어요" 로 처음 알게 된다. 503 을 안 내는 것과 **신호가 없는 것은 다르다**.
 *
 * 임계는 백엔드가 정한다(`low` = 10% 미만). 프론트는 그 안에서 위험 단계만 더
 * 가른다 — 숫자를 두 벌로 두면 갈린다.
 *
 * SupervisedTaskFailureToastHost 와 같은 형태다: 폴링(5초)에서 파생되므로 회복되면
 * 저절로 사라지고, 닫기만 로컬 상태로 든다. 단 닫기 키를 단계로 잡아 **경고에서
 * 위험으로 악화되면 다시 뜬다** — 한 번 닫았다고 영영 조용해지면 안 된다.
 */
export default function DiskHeadroomToastHost() {
  const { data: status } = useLiveStatus();
  const disk = status?.disk;
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  const critical = disk != null && disk.free_pct < CRITICAL_FREE_PCT;
  const key = critical ? 'critical' : 'low';
  const visible = disk != null && disk.low && dismissedKey !== key;

  return (
    <ToastCard visible={visible} variant={critical ? 'error' : 'warn'} role="status">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium text-fg">
          {critical ? '디스크가 거의 찼습니다' : '디스크 여유가 부족합니다'}
        </div>
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
        남은 공간 {disk?.free_pct}% ({disk?.free_gib}GiB). 가득 차면 캡처와 실시간
        기록이 조용히 실패합니다 — `hoga prune` 으로 회수량을 확인하세요.
      </div>
    </ToastCard>
  );
}
