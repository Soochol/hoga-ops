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
 *  매도|매수 서브탭으로 한 곳에서 둘을 설정한다. 각 side는 독립 on/off(표시 토글)와
 *  기존 Ask/BidPeakConfig(embedded)를 그대로 재사용한다. 색상은 매도/매수가 의도적으로
 *  달라 "복사"는 두지 않는다.
 *
 *  「표시 위치」 섹션 — 같은 벽을 그리는 두 표면을 한 결정으로 묶는다:
 *  - 「캔들 차트에 수평선」 = 기존 눈(`askPeakHidden`/`bidPeakHidden`)의 **반전 노출**.
 *    새 키가 아니다 — 레전드의 눈 아이콘과 같은 상태라 둘이 자동 동기화된다.
 *    방향별이다(매도만 캔들에서 빼는 것도 가능).
 *  - 「전용 pane 에 계단」 = `peakWallPaneEnabled`. pane 은 방향 공용(한 pane 에
 *    두 계단)이라 이 토글도 공용이고, 어느 탭에서 봐도 **같은 하나의 상태**다.
 *  둘 다 꺼도 지표는 계산을 유지한다(레전드 값 유지 — 눈 불변식 그대로). */
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
      <h3 className="text-fg text-base font-medium pb-1">
        당일 최대벽 <span aria-hidden="true" className="text-fg-dim text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        차트에 보이는 거래일마다, 그 날 10호가 중 한 단계에 가장 크게 걸렸던 물량의 가격에 그날 구간만큼
        수평선을 그립니다. 매도·매수를 각각 설정합니다. 분봉 차트에서만 표시됩니다
      </p>
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
      <div className="text-sm text-fg mb-1">표시 위치</div>
      <div className="mb-3 space-y-1">
        {/* 눈(hidden)의 반전 — 켬 = 캔들 pane 에 수평선·라벨·화살표를 그린다.
            마스터가 꺼져 있으면 어차피 아무것도 안 그려지므로 dim 처리한다
            (값은 보존 — 마스터를 켜면 setEnabled 가 hidden 도 리셋한다). */}
        <ToggleRow
          label="캔들 차트에 수평선"
          description={`${sideLabel} 최대벽을 캔들 위 수평선으로 그립니다. 레전드의 눈 아이콘과 같은 설정입니다.`}
          checked={!hidden}
          onToggle={() => setHidden(!hidden)}
          disabled={!enabled}
          testId={`settings-toggle-${side}PeakCandleLine`}
        />
        <ToggleRow
          label="전용 pane 에 계단"
          description="당일 최대벽 수량의 누적 최대 계단을 차트 아래 별도 pane 에 그립니다. 매도·매수 공용입니다."
          checked={paneEnabled}
          onToggle={() => setPaneEnabled(!paneEnabled)}
          testId="settings-toggle-peakWallPaneEnabled"
        />
      </div>
      {isAsk ? <AskPeakConfig embedded /> : <BidPeakConfig embedded />}
    </div>
  );
}
