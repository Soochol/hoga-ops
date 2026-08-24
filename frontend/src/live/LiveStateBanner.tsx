import type { LiveBannerCause, LiveBannerPrimary } from './liveStatusProjection';
import { requestSettingsModal } from './settingsModalControls';

interface Props {
  primary: LiveBannerPrimary;
  stack: LiveBannerCause[];
  /** 사유별 꼬리말. 정적 문구로 표현할 수 없는 값(죽은 앱키 이름 등)만 붙인다. */
  details?: Partial<Record<LiveBannerCause, string>>;
}

const COPY: Record<LiveBannerCause, { title: string; severity: 'error' | 'warn' | 'info' }> = {
  watchlist_empty: { title: '관심종목을 먼저 추가해주세요', severity: 'info' },
  kis_token_expired: { title: 'KIS 토큰이 만료되었습니다', severity: 'warn' },
  // 문구에 **계정 번호를 쓰지 않는다** — account 5 는 `KIWOOM_APP_KEY_6` 이라
  // 번호를 그대로 보이면 사용자가 `KIWOOM_APP_KEY_5`(다른 키)를 찾는다. 고칠 대상의
  // 이름은 백엔드가 실어 보내고(`auth_failing_env_keys`) `detail` 로 붙는다.
  kiwoom_auth_failing: { title: '키움 앱키 인증 실패 — 과거 데이터 조회가 막힙니다', severity: 'error' },
  realtime_unavailable: { title: '실시간 미가동 — 호가·체결 스트림이 연결되지 않았습니다 (캔들·지수는 정상)', severity: 'warn' },
};

export function LiveStateBanner({ primary, stack, details }: Props) {
  // Priority-1 banners render in the header band; priority-2 stackable causes stack below.
  // Render an empty placeholder when there's nothing to show: LivePage's
  // CSS grid defines 5 rows and relies on positional auto-placement, so
  // returning null here would shift LiveWorkarea up into the toolbar's
  // 75px slot and squash the chart to 0 height. Keep the row occupied;
  // the empty div collapses to 0 height under the `auto` track.
  if (primary === null && stack.length === 0) return <div data-testid="live-state-banner-empty" />;

  return (
    <div data-testid="live-state-banner" className="flex flex-col">
      {/* `credentials_missing` 행은 도달 불가 판정으로 내렸다 — 자세한 근거는
          liveStatusProjection.ts 의 삭제된 분기 자리 주석 참조. */}
      {/* 복구 동선은 이제 **라우트 이동이 아니라 드로어 열기**다 — `/settings` 페이지가
          사라지면서(설정 표면 단일화) 링크가 갈 곳이 없어졌고, 어차피 이 배너를 보는
          채로 설정을 만지는 게 자연스럽다(화면을 떠나지 않는다). */}
      {primary === 'realtime_unavailable' && (
        <BannerRow cause="realtime_unavailable" onAction={requestSettingsModal} actionLabel="설정" />
      )}
      {/* watchlist_empty is rendered in the workarea emptystate, not here.
          We surface it as a null in the header banner area but the LiveEmptyState
          consumes the same `primary` flag — see LiveWorkarea. */}
      {stack.map((cause) => (
        <BannerRow key={cause} cause={cause} detail={details?.[cause]} />
      ))}
    </div>
  );
}

function BannerRow({
  cause,
  detail,
  onAction,
  actionLabel,
}: {
  cause: LiveBannerCause;
  detail?: string;
  onAction?: () => void;
  actionLabel?: string;
}) {
  const c = COPY[cause];
  const bg =
    c.severity === 'error' ? 'var(--tint-error)' :
    c.severity === 'warn' ? 'var(--tint-warn)' :
    'var(--bg-card)';
  const borderColor =
    c.severity === 'error' ? 'var(--error)' :
    c.severity === 'warn' ? 'var(--warn)' :
    'var(--border)';
  const fg =
    c.severity === 'error' ? 'var(--error)' :
    c.severity === 'warn' ? 'var(--warn)' :
    'var(--fg-dim)';

  return (
    <div
      role="status"
      className="flex items-center justify-between border-b px-3 py-2"
      style={{ background: bg, borderColor, color: fg, fontSize: 'var(--text-sm)' }}
    >
      <span>{detail ? `${c.title} (${detail})` : c.title}</span>
      {onAction && actionLabel && (
        <button
          type="button"
          onClick={onAction}
          className="px-2 py-1 rounded font-data"
          style={{
            background: 'var(--bg-input)',
            color: 'var(--fg)',
            fontSize: 'var(--text-xs)',
            border: '1px solid var(--border-strong)',
          }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
