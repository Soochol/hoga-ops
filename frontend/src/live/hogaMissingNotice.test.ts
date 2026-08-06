import { describe, expect, it } from 'vitest';
import { deriveHogaMissingNotice } from './hogaMissingNotice';

const absent = (date: string, reason = 'source_missing') => ({ date, reason });

describe('deriveHogaMissingNotice', () => {
  it('결손이 없으면 안내하지 않는다', () => {
    expect(deriveHogaMissingNotice({
      missingDates: [], venue: 'NXT', hasAnyHogaPoints: true,
    })).toBeNull();
    expect(deriveHogaMissingNotice({
      missingDates: undefined, venue: 'NXT', hasAnyHogaPoints: true,
    })).toBeNull();
  });

  it('NXT 전 구간 결손 — 시장 이름을 넣는다', () => {
    // 이 케이스가 이 기능의 존재 이유다: NXT 는 kiwoom_live 가 저장을 시작한 날부터만
    // 존재하므로 그 이전 조회는 전부 빈다. 이름이 없으면 사용자는 원인을 못 찾는다.
    expect(deriveHogaMissingNotice({
      missingDates: [absent('20260701'), absent('20260702')],
      venue: 'NXT',
      hasAnyHogaPoints: false,
    })).toBe('NXT 호가 기록 없음');
  });

  it('통합은 라벨이 한글이다', () => {
    expect(deriveHogaMissingNotice({
      missingDates: [absent('20260701')], venue: 'UN', hasAnyHogaPoints: false,
    })).toBe('통합 호가 기록 없음');
  });

  it('KRX 는 시장 이름을 빼고 말한다', () => {
    // "KRX 호가 기록 없음" 은 시장을 원인으로 오해하게 만든다 — KRX 에서 결손의
    // 원인은 시장이 아니라 그날 캡처가 없다는 것이다.
    expect(deriveHogaMissingNotice({
      missingDates: [absent('20260701', 'stock_date_missing')],
      venue: 'KRX',
      hasAnyHogaPoints: false,
    })).toBe('호가 기록 없음');
  });

  it('일부 구간만 결손이면 "포함" 으로 말한다', () => {
    // 보이는 데이터가 있는데 "없음" 이라고 하면 화면과 모순된다.
    expect(deriveHogaMissingNotice({
      missingDates: [absent('20260701')], venue: 'NXT', hasAnyHogaPoints: true,
    })).toBe('NXT 호가 기록 없는 구간 포함');
  });

  it('손상은 결손과 다르게 말한다 — 재캡처 여지가 있다', () => {
    expect(deriveHogaMissingNotice({
      missingDates: [{ date: '20260701', reason: 'meta_unreadable' }],
      venue: 'NXT',
      hasAnyHogaPoints: false,
    })).toBe('호가 기록 손상');
  });

  it('결손과 손상이 섞이면 결손을 우선한다', () => {
    // 손상은 재캡처로 고칠 수 있고 결손은 아니다 — 먼저 알아야 할 쪽이 결손이다.
    expect(deriveHogaMissingNotice({
      missingDates: [
        { date: '20260701', reason: 'meta_unreadable' },
        absent('20260702', 'venue_unsupported'),
      ],
      venue: 'NXT',
      hasAnyHogaPoints: false,
    })).toBe('NXT 호가 기록 없음');
  });

  it('미지의 사유는 손상 문구로 폴백한다 — 렌더가 깨지지 않는다', () => {
    // 백엔드가 새 MissingReason 을 추가해도 프론트가 빈 화면이 되지 않아야 한다.
    expect(deriveHogaMissingNotice({
      missingDates: [{ date: '20260701', reason: 'something_new' }],
      venue: 'KRX',
      hasAnyHogaPoints: false,
    })).toBe('호가 기록 손상');
  });
});
