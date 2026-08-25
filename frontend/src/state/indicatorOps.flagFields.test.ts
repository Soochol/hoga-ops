import { describe, it, expect } from 'vitest';
import {
  FLAG_INDICATOR_FIELDS,
  FLAG_INDICATOR_TYPES,
  flagRemovalPatches,
} from './indicatorOps';
import { FACTORY_INDICATOR_SETTINGS, INDICATOR_SETTING_KEYS } from './indicatorSettingsV2';

/**
 * `FLAG_INDICATOR_FIELDS` 의 드리프트 가드.
 *
 * 그 표는 손으로 적는다(접두사 자동 매칭은 오탐·누락이 둘 다 조용하다). 손 목록의
 * 위험은 **새 필드가 늘었을 때 조용히 빠지는 것**이고, 실제로 그런 일이 있었다 —
 * #1582 가 `askPeakAllWall*` 3필드를 얹었다. 누락되면 그 지표를 "삭제" 해도 사용자가
 * 손댄 값이 버킷에 남아, 다시 켤 때 지웠다고 생각한 설정이 되살아난다.
 *
 * 그래서 여기서 **양방향**으로 못 박는다: 목록의 모든 필드가 실재하고, flag 접두를
 * 가진 모든 설정 키가 정확히 한 목록에 속한다.
 *
 * ⚠ 접두사는 **이 테스트 안에서만** 쓴다 — 프로덕션 코드가 접두로 필드를 고르면
 * 그 순간 손 목록의 의미가 사라진다. 여기서는 "빠진 게 있나" 를 묻는 용도이고,
 * 오탐이 나면 `INTENTIONALLY_UNGROUPED` 에 사유와 함께 넣는다.
 */
const FLAG_FIELD_PREFIXES: Record<string, string> = {
  askPeak: 'ask-peak',
  bidPeak: 'bid-peak',
  tradeVolumePoc: 'trade-volume-poc',
  depthHeatmap: 'depth-heatmap',
  depthDelta: 'depth-delta',
  brokerLateEntry: 'broker-late-entry',
};

/** 접두는 맞지만 그 지표의 소유가 **아닌** 키 — 사유를 함께 적는다. */
const INTENTIONALLY_UNGROUPED: readonly string[] = [
  // (현재 없음. 추가할 때는 왜 그 지표 삭제가 이 필드를 건드리면 안 되는지 적을 것.)
];

describe('FLAG_INDICATOR_FIELDS — 손 목록의 드리프트 가드', () => {
  it('목록의 모든 필드가 실재하는 설정 키다', () => {
    const known = new Set<string>(INDICATOR_SETTING_KEYS as readonly string[]);
    for (const type of FLAG_INDICATOR_TYPES) {
      for (const field of FLAG_INDICATOR_FIELDS[type]) {
        expect(known.has(field), `${type}: 없는 키 ${field}`).toBe(true);
      }
    }
  });

  it('flag 접두를 가진 설정 키가 정확히 한 목록에 속한다 (누락·중복 없음)', () => {
    const owner = new Map<string, string>();
    for (const type of FLAG_INDICATOR_TYPES) {
      for (const field of FLAG_INDICATOR_FIELDS[type]) {
        expect(owner.has(field), `${field} 가 두 목록에 있다`).toBe(false);
        owner.set(field, type);
      }
    }
    const missing: string[] = [];
    for (const key of INDICATOR_SETTING_KEYS as readonly string[]) {
      if (INTENTIONALLY_UNGROUPED.includes(key)) continue;
      const prefix = Object.keys(FLAG_FIELD_PREFIXES).find((p) => key.startsWith(p));
      if (prefix && !owner.has(key)) missing.push(`${key} → ${FLAG_FIELD_PREFIXES[prefix]}`);
    }
    expect(missing, '새 필드가 삭제 목록에서 빠졌다').toEqual([]);
  });

  it('삭제 patch 는 공장값으로, undo patch 는 현재값으로 채운다', () => {
    const cur = {
      ...FACTORY_INDICATOR_SETTINGS,
      askPeakEnabled: true,
      askPeakColor: '#123456',
      askPeakLineWidth: 4 as const,
    };
    const { label, apply, undo } = flagRemovalPatches(cur, 'ask-peak', FACTORY_INDICATOR_SETTINGS);

    expect(label).toBe('당일 매도 최대벽 삭제됨');
    expect(apply.askPeakEnabled).toBe(FACTORY_INDICATOR_SETTINGS.askPeakEnabled);
    expect(apply.askPeakColor).toBe(FACTORY_INDICATOR_SETTINGS.askPeakColor);
    expect(undo.askPeakColor).toBe('#123456');
    expect(undo.askPeakLineWidth).toBe(4);
    // 다른 지표의 필드는 건드리지 않는다.
    expect('bidPeakColor' in apply).toBe(false);
    // 소유 필드는 하나도 빠뜨리지 않는다(색만 지우고 두께가 남는 반쪽 삭제 방지).
    expect(Object.keys(apply).sort()).toEqual([...FLAG_INDICATOR_FIELDS['ask-peak']].sort());
  });
});
