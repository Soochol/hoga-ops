import { describe, it, expect } from 'vitest';
import { computeCaptureLag, captureLagTitle } from './captureLag';

describe('computeCaptureLag', () => {
  it('마커 최댓값을 기준으로 뒤처진 종목만 잡는다', () => {
    const { latest, lagging } = computeCaptureLag(
      { '005930': '20260806', '000660': '20260806', '035720': '20260804' },
      ['005930', '000660', '035720'],
    );
    expect(latest).toBe('20260806');
    expect([...lagging]).toEqual(['035720']);
  });

  it('마커가 아예 없는 코드도 결손으로 센다', () => {
    const { lagging } = computeCaptureLag({ '005930': '20260806' }, ['005930', '000660']);
    expect([...lagging]).toEqual(['000660']);
  });

  it('전 종목이 같은 날이면 결손 0 — 장중에 271개 경고가 뜨지 않는다', () => {
    // 오늘 런이 아직 안 돌아 전부 어제 날짜인 상태. 달력 기준이면 전부 미수집이지만
    // 마커 최댓값 기준에서는 아무도 뒤처지지 않았다.
    const { lagging } = computeCaptureLag(
      { '005930': '20260805', '000660': '20260805' },
      ['005930', '000660'],
    );
    expect(lagging.size).toBe(0);
  });

  it('마커가 하나도 없으면 기준이 없어 결손도 없다', () => {
    const { latest, lagging } = computeCaptureLag({}, ['005930']);
    expect(latest).toBeNull();
    expect(lagging.size).toBe(0);
  });

  it('markers 가 undefined 여도 (로딩 중) 터지지 않는다', () => {
    expect(computeCaptureLag(undefined, ['005930']).lagging.size).toBe(0);
  });
});

describe('captureLagTitle', () => {
  it('마지막 수집일을 MM/DD 로 말한다', () => {
    expect(captureLagTitle({ '005930': '20260806' }, '005930')).toBe('마지막 수집 08/06');
  });
  it('이력이 없으면 그렇게 말한다', () => {
    expect(captureLagTitle({}, '005930')).toBe('수집 이력 없음');
  });
});
