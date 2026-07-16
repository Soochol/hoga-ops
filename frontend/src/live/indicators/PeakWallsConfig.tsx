import { useState } from 'react';
import { useLivePageStore } from '../../state/livePage';
import ToggleRow from '../settings/ToggleRow';
import AskPeakConfig from './AskPeakConfig';
import BidPeakConfig from './BidPeakConfig';

type Side = 'ask' | 'bid';

const SIDE_TABS: ReadonlyArray<{ value: Side; label: string }> = [
  { value: 'ask', label: '매도' },
  { value: 'bid', label: '매수' },
];

/** 당일 매도·매수 최대벽 병합 페이지(P1-8). 좌측 nav의 두 항목을 하나로 합치고,
 *  매도|매수 서브탭으로 한 곳에서 둘을 설정한다. 각 side는 독립 on/off(표시 토글)와
 *  기존 Ask/BidPeakConfig(embedded)를 그대로 재사용한다. 색상은 매도/매수가 의도적으로
 *  달라 "복사"는 두지 않는다. */
export default function PeakWallsConfig() {
  const [side, setSide] = useState<Side>('ask');
  const askEnabled = useLivePageStore((s) => s.askPeakEnabled);
  const bidEnabled = useLivePageStore((s) => s.bidPeakEnabled);
  const setAskEnabled = useLivePageStore((s) => s.setAskPeakEnabled);
  const setBidEnabled = useLivePageStore((s) => s.setBidPeakEnabled);

  const isAsk = side === 'ask';
  const enabled = isAsk ? askEnabled : bidEnabled;
  const setEnabled = isAsk ? setAskEnabled : setBidEnabled;
  const sideLabel = isAsk ? '매도' : '매수';

  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">
        당일 최대벽 <span aria-hidden="true" className="text-fg-dimmer text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        차트에 보이는 거래일마다, 그 날 10호가 중 한 단계에 가장 크게 걸렸던 물량의 가격에 그날 구간만큼
        수평선을 그립니다. 매도·매수를 각각 설정합니다. 분봉 차트에서만 표시됩니다.
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
      {isAsk ? <AskPeakConfig embedded /> : <BidPeakConfig embedded />}
    </div>
  );
}
