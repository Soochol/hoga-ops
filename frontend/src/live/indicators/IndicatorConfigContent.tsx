import MovingAverageConfig from './MovingAverageConfig';
import BollingerConfig from './BollingerConfig';
import EnvelopeConfig from './EnvelopeConfig';
import SupertrendConfig from './SupertrendConfig';
import DailyMovingAverageConfig from './DailyMovingAverageConfig';
import VolumeConfig from './VolumeConfig';
import TradeValueConfig from './TradeValueConfig';
import InvestorNetConfig from './InvestorNetConfig';
import PeakWallsConfig from './PeakWallsConfig';
import TradeVolumePocConfig from './TradeVolumePocConfig';
import DepthHeatmapConfig from './DepthHeatmapConfig';
import QuoteTotalsConfig from './QuoteTotalsConfig';
import RatioConfig from './RatioConfig';
import FillStrengthConfig from './FillStrengthConfig';
import DailyProgramTradeConfig from './DailyProgramTradeConfig';
import ProgramTradeConfig from './ProgramTradeConfig';
import BrokerLateEntryConfig from './BrokerLateEntryConfig';
import VolumeDistributionConfig from './VolumeDistributionConfig';
import IndicatorStylePreview from './IndicatorStylePreview';
import { useWindowIndicators } from '../workspace/windowView';
import type { CategoryId } from './IndicatorPanelHelpers';
import type { LiveInstrumentCapabilities } from '../liveInstrumentCapabilities';

export default function IndicatorConfigContent({ category, capabilities }: { category: CategoryId; capabilities: LiveInstrumentCapabilities }) {
  const settings = useWindowIndicators();
  return <>
    <IndicatorStylePreview category={category} settings={settings} />
    {category === 'supertrend' && <SupertrendConfig />}
    {category === 'bollinger' && <BollingerConfig />}
    {category === 'envelope' && <EnvelopeConfig />}
    {category === 'moving-average' && <MovingAverageConfig />}
    {category === 'daily-moving-average' && <DailyMovingAverageConfig />}
    {category === 'volume' && <VolumeConfig />}
    {category === 'trade-value' && <TradeValueConfig />}
    {(category === 'foreign-net' || category === 'institution-net') && <InvestorNetConfig which={category === 'foreign-net' ? 'foreign' : 'institution'} grossSupported={capabilities.investorNet === 'stock'} />}
    {category === 'broker-late-entry' && <BrokerLateEntryConfig />}
    {category === 'peak-walls' && <PeakWallsConfig />}
    {category === 'trade-volume-poc' && <TradeVolumePocConfig />}
    {category === 'depth-heatmap' && <DepthHeatmapConfig />}
    {category === 'quote-totals' && <QuoteTotalsConfig />}
    {category === 'ratio' && <RatioConfig />}
    {category === 'fill-strength' && <FillStrengthConfig />}
    {category === 'program-daily' && <DailyProgramTradeConfig />}
    {category === 'program-trade' && <ProgramTradeConfig />}
    {category === 'volume-distribution' && <VolumeDistributionConfig />}
  </>;
}
