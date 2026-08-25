import { describe, it, expect } from 'vitest';
import { applyPresetEnableByTimeframe } from './indicatorPresetOps';
import { FACTORY_INDICATOR_SETTINGS } from './indicatorSettingsV2';

/**
 * 프리셋의 MA 마스터 2키는 **서버에 저장된 payload 의 키**라 이름이 남지만, 설정
 * 스키마에는 더 이상 없다(슬롯의 `enabled` 로 접혔다). 그래서 적용은 번역이어야
 * 하고, 번역을 빼먹으면 프리셋의 "MA 끔" 이 **세션 안에서 조용히 무시된다** —
 * 다음 로드의 collapse 가 뒤늦게 처리하므로 증상이 한참 뒤에 온다.
 */
describe('applyPresetEnableByTimeframe — MA 마스터 번역', () => {
  const slot = (over: Record<string, unknown> = {}) => ({
    id: 'ma-1', enabled: true, period: 5, color: '#EC4899', lineWidth: 1 as const,
    source: 'close' as const, ...over,
  });

  it('프리셋의 movingAverageEnabled:false 를 슬롯 all-disabled 로 옮긴다', () => {
    const out = applyPresetEnableByTimeframe(
      { minute: { movingAverages: [slot()] } },
      { minute: { movingAverageEnabled: false } },
    );
    expect(out.minute!.movingAverages!.every((m) => m.enabled)).toBe(false);
    // 마스터 키가 버킷으로 새면 sanitize 가 버려 번역이 무의미해진다.
    expect('movingAverageEnabled' in out.minute!).toBe(false);
  });

  it('기간·색 같은 파라미터는 보존한다 — 덮는 것은 켜짐뿐이다', () => {
    const out = applyPresetEnableByTimeframe(
      { minute: { movingAverages: [slot({ period: 33, color: '#123456' })] } },
      { minute: { movingAverageEnabled: false } },
    );
    expect(out.minute!.movingAverages![0]).toMatchObject({ period: 33, color: '#123456' });
  });

  it('슬롯 오버라이드가 없으면 공장 슬롯을 기준으로 만든다', () => {
    const out = applyPresetEnableByTimeframe({}, { minute: { movingAverageEnabled: false } });
    expect(out.minute!.movingAverages).toHaveLength(
      FACTORY_INDICATOR_SETTINGS.movingAverages.length,
    );
    expect(out.minute!.movingAverages!.every((m) => m.enabled)).toBe(false);
  });

  it('일봉 마스터도 같은 규칙으로 번역된다', () => {
    const out = applyPresetEnableByTimeframe({}, { minute: { dailyMovingAverageEnabled: true } });
    expect(out.minute!.dailyMovingAverages!.every((m) => m.enabled)).toBe(true);
  });

  it('프리셋에 MA 키가 없으면 슬롯을 건드리지 않는다', () => {
    const slots = [slot({ enabled: false })];
    const out = applyPresetEnableByTimeframe(
      { minute: { movingAverages: slots } },
      { minute: { askPeakEnabled: true } },
    );
    expect(out.minute!.movingAverages).toBe(slots);
    expect(out.minute!.askPeakEnabled).toBe(true);
  });
});
