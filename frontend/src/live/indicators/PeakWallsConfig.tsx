import { useState } from 'react';
import ToggleRow from '../settings/ToggleRow';
import AskPeakConfig from './AskPeakConfig';
import BidPeakConfig from './BidPeakConfig';
import { useWindowIndicator, useIndicatorActions } from '../workspace/windowView';

type Side = 'ask' | 'bid';

const SIDE_TABS: ReadonlyArray<{ value: Side; label: string }> = [
  { value: 'ask', label: '매도' },
  { value: 'bid', label: '매수' },
];

/** 당일 매도·매수 최대벽 병합 페이지(P1-8). 좌측 nav의 두 항목을 하나로 합치고,
 *  매도|매수 서브탭으로 한 곳에서 둘을 설정한다. 색상은 매도/매수가 의도적으로 달라
 *  "복사"는 두지 않는다.
 *
 *  ## 무엇이 탭 안이고 무엇이 밖인가 (2026-08-25 재구성의 요점)
 *
 *  이 페이지의 컨트롤은 **스코프가 두 종류**인데 종전엔 둘 다 탭 안에 있어서 구별이
 *  화면에 없었다. 이제 위치가 스코프를 말한다:
 *
 *  - **탭 안(방향별)** — 마스터 토글 · 「캔들 차트에 수평선」(눈 `*PeakHidden` 의
 *    반전 노출 — 새 키가 아니라 레전드 눈 아이콘과 같은 상태다) · 그리고
 *    `Ask/BidPeakConfig` 전체(계열 카드 3장 + 「계열 공용」 구획). 그 안에서 다시
 *    **계열별/계열 공용**이 갈리는데, 그 층의 배치 규칙은 `AskPeakConfig` 머리말에 있다.
 *  - **탭 밖(공용)** — 「최대벽 강도 pane」(`peakWallPaneEnabled`). 한 pane 에 양방향
 *    계단이 함께 살아 상태가 하나뿐이라, 매도 탭에서 켜면 매수도 켜진다. 그 사실을
 *    탭 경계 밖이라는 **위치**로 말한다.
 *
 *  마스터를 꺼도 지표는 레전드 값을 유지한다(눈 불변식 그대로). */
export default function PeakWallsConfig() {
  const [side, setSide] = useState<Side>('ask');
  const askEnabled = useWindowIndicator((s) => s.askPeakEnabled);
  const bidEnabled = useWindowIndicator((s) => s.bidPeakEnabled);
  const askHidden = useWindowIndicator((s) => s.askPeakHidden);
  const bidHidden = useWindowIndicator((s) => s.bidPeakHidden);
  const paneEnabled = useWindowIndicator((s) => s.peakWallPaneEnabled);
  const actions = useIndicatorActions();
  const setAskEnabled = actions.setAskPeakEnabled;
  const setBidEnabled = actions.setBidPeakEnabled;
  const setAskHidden = actions.setAskPeakHidden;
  const setBidHidden = actions.setBidPeakHidden;
  const setPaneEnabled = actions.setPeakWallPaneEnabled;

  const isAsk = side === 'ask';
  const enabled = isAsk ? askEnabled : bidEnabled;
  const hidden = isAsk ? askHidden : bidHidden;
  const setEnabled = isAsk ? setAskEnabled : setBidEnabled;
  const setHidden = isAsk ? setAskHidden : setBidHidden;
  const sideLabel = isAsk ? '매도' : '매수';

  return (
    <div>
      <div
        className="mb-3 inline-flex overflow-hidden rounded-md border border-border"
        role="tablist"
        aria-label="최대벽 방향"
      >
        {SIDE_TABS.map((tab) => {
          const selected = tab.value === side;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setSide(tab.value)}
              className={[
                'px-4 py-1.5 text-sm transition-colors',
                selected ? 'bg-accent text-accent-fg' : 'bg-bg-elevated text-fg-dim hover:text-fg',
              ].join(' ')}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div className="mb-3">
        <ToggleRow
          label={`${sideLabel} 최대벽 표시`}
          description={`${sideLabel} 방향 최대벽을 차트에 표시합니다.`}
          checked={enabled}
          onToggle={() => setEnabled(!enabled)}
          testId={`settings-toggle-${side}PeakEnabled`}
        />
      </div>
      {/* 눈(hidden)의 반전 — 켬 = 캔들 pane 에 수평선·라벨·화살표를 그린다. 방향별이라
          탭 안에 남는다(아래 pane 토글과 갈리는 지점). 마스터가 꺼져 있으면 어차피
          아무것도 안 그려지므로 dim (값은 보존 — 마스터를 켜면 setEnabled 가 리셋). */}
      <div className="mb-1">
        <ToggleRow
          label="캔들 차트에 수평선"
          description={`${sideLabel} 최대벽을 캔들 위 수평선으로 그립니다. 레전드의 눈 아이콘과 같은 설정입니다.`}
          checked={!hidden}
          onToggle={() => setHidden(!hidden)}
          disabled={!enabled}
          testId={`settings-toggle-${side}PeakCandleLine`}
        />
      </div>
      {isAsk ? <AskPeakConfig /> : <BidPeakConfig />}

      {/* ── 방향 공용 ────────────────────────────────────────────────────
          **탭 밖이다.** 이 토글은 매도·매수가 하나를 공유하는데(한 pane 에 두 방향의
          계단이 함께 산다) 종전엔 방향 탭 **안**에 있어서, 매도 탭에서 켜면 매수도
          켜지는 것이 화면상 설명되지 않았다. 위치를 옮겨 공용이라는 사실을 구조로
          말한다 — 탭 경계 밖에 있으면 탭에 속하지 않는다. */}
      <div className="mt-4 rounded-lg border border-border bg-bg-subtle p-3">
        <span className="mb-2 inline-block rounded-full border border-border-strong px-1.5 py-px text-2xs font-semibold uppercase tracking-wide text-fg-dim">
          매도 · 매수 공용
        </span>
        <ToggleRow
          label="최대벽 강도 pane"
          description="위에서 켠 계열의 계단을 차트 아래 별도 pane 에 그립니다. 한 pane 을 양방향이 공유합니다. 미도달 벽은 고가가 벽을 넘으면 계단이 내려갑니다."
          checked={paneEnabled}
          onToggle={() => setPaneEnabled(!paneEnabled)}
          testId="settings-toggle-peakWallPaneEnabled"
        />
      </div>
    </div>
  );
}
