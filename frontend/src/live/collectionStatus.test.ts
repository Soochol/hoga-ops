import { describe, it, expect } from 'vitest';
import {
  deriveCollectionStatus,
  deriveCollectionView,
  deriveDisplayStatus,
  deriveStorageLabel,
} from './collectionStatus';

describe('deriveCollectionStatus', () => {
  it('realtime: code가 live_set(WS)에 있으면', () => {
    expect(deriveCollectionStatus('005930', ['005930', '000660'], ['005930', '000660'], [])).toBe('realtime');
  });
  it('polling: live_set 밖이지만 지금 보는 종목(viewedCodes)이면', () => {
    expect(deriveCollectionStatus('035720', ['005930'], ['005930'], ['035720'])).toBe('polling');
  });
  it('realtime이 polling보다 우선: 관심종목을 보는 중이어도 realtime', () => {
    expect(deriveCollectionStatus('005930', ['005930'], ['005930'], ['005930'])).toBe('realtime');
  });
  it('uncollected: live_set 밖 + 안 보는 중 + watchlist에도 없음', () => {
    expect(deriveCollectionStatus('068270', ['005930'], ['005930'], [])).toBe('uncollected');
  });
  it('waiting_eod 폴백: watchlist엔 있으나 live_set 밖 + 안 보는 중 (관심종목 26 초과 케이스)', () => {
    expect(deriveCollectionStatus('068270', ['005930'], ['005930', '068270'], [])).toBe('waiting_eod');
  });
  it('uncollected: code가 null', () => {
    expect(deriveCollectionStatus(null, ['005930'], ['005930'], ['005930'])).toBe('uncollected');
  });
  it('realtime: 키움 WS 수집 종목(히트맵)도 realtime (ADR-0116 PR-6b)', () => {
    // live_set 밖이지만 kiwoomCodes에 있으면 realtime(●).
    expect(deriveCollectionStatus('005380', [], [], [], ['005380'])).toBe('realtime');
  });
  it('kiwoomCodes 미지정(구 응답)이면 기존 동작 유지', () => {
    expect(deriveCollectionStatus('005380', [], [], ['005380'])).toBe('polling');
  });
});

describe('deriveDisplayStatus', () => {
  it('realtime + 연결정상 → realtime (점만)', () => {
    expect(deriveDisplayStatus(true, 'realtime')).toBe('realtime');
  });
  it('realtime + WS끊김 → disconnected', () => {
    expect(deriveDisplayStatus(false, 'realtime')).toBe('disconnected');
  });
  it('polling은 연결과 무관 (REST 독립 전송로)', () => {
    expect(deriveDisplayStatus(false, 'polling')).toBe('polling');
    expect(deriveDisplayStatus(true, 'polling')).toBe('polling');
  });
  it('waiting_eod는 연결과 무관', () => {
    expect(deriveDisplayStatus(false, 'waiting_eod')).toBe('waiting_eod');
  });
  it('uncollected → uncollected', () => {
    expect(deriveDisplayStatus(true, 'uncollected')).toBe('uncollected');
  });
});

describe('deriveStorageLabel', () => {
  // KIS API 30초 저장(rest30)은 제거됨(2026-07-17) — 저장 라벨은 KIS WS/키움 WS/대기/제외뿐.
  it('labels KIS WS storage for live_set members', () => {
    expect(deriveStorageLabel({
      code: '005930',
      liveSet: ['005930'],
      captureCandidate: true,
    })).toBe('KIS WS 저장 중');
  });

  it('labels 키움 WS storage for kiwoom-captured codes outside the KIS live_set', () => {
    expect(deriveStorageLabel({
      code: '005380',
      liveSet: ['005930'],
      kiwoomCodes: ['005380'],
      captureCandidate: true,
    })).toBe('키움 WS 저장 중');
  });

  it('shows waiting for capture candidates not currently assigned', () => {
    expect(deriveStorageLabel({
      code: '035420',
      liveSet: [],
      captureCandidate: true,
    })).toBe('대기');
  });

  it('shows excluded when backend projection says the code is not a capture candidate', () => {
    expect(deriveStorageLabel({
      code: '051910',
      liveSet: [],
      captureCandidate: false,
    })).toBe('저장 제외');
  });
});

describe('deriveCollectionView', () => {
  it('returns dot status, aria label, and storage label together', () => {
    const view = deriveCollectionView({
      code: '000660',
      liveSet: ['005930'],
      watchlistCodes: ['005930', '000660'],
      viewedCodes: [],
      captureCandidate: true,
      liveConnection: true,
    });

    expect(view.collectionStatus).toBe('waiting_eod');
    expect(view.displayStatus).toBe('waiting_eod');
    expect(view.ariaLabel).toBe('관심종목 대기 중');
    expect(view.storageLabel).toBe('대기');
  });
});
