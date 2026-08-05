import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VenueStateCell } from './DiskStateBadge';

/** 보관함 날짜 행의 venue 배지 (ADR-0140 §7).
 *
 *  셀렉터는 문구가 아니라 `data-venue-state` **원값**을 쓴다 — 라벨은 바뀌지만
 *  상태값은 계약이다(#1083 규율). */
describe('VenueStateCell', () => {
  it('renders nothing when the row has no venue axis', () => {
    // hogaplay 전용 캡처·마이그레이션 전 평면 레이아웃 — 화면이 그대로여야 한다.
    const { container } = render(<VenueStateCell venues={[]} />);
    expect(container).toBeEmptyDOMElement();
    expect(render(<VenueStateCell />).container).toBeEmptyDOMElement();
  });

  it('gives a not-listed venue no slot at all', () => {
    // ⚠ 이게 이 컴포넌트의 요점이다. 미상장 NXT 를 빈 배지로 그리면 결손처럼
    // 읽히므로, 자리 자체를 안 만들어 '정상적으로 없음'을 모양으로 말한다.
    render(<VenueStateCell venues={[{ venue: 'KRX', disk_state: 'complete', file_size_bytes: 1 }]} />);
    expect(screen.getByTestId('venue-state-KRX')).toBeInTheDocument();
    expect(screen.queryByTestId('venue-state-NXT')).toBeNull();
    expect(screen.queryByTestId('venue-state-UN')).toBeNull();
  });

  it('keeps an empty slot for a venue that is expected but absent', () => {
    render(<VenueStateCell venues={[
      { venue: 'KRX', disk_state: 'complete', file_size_bytes: 1 },
      { venue: 'NXT', disk_state: null, file_size_bytes: 0 },
    ]} />);
    // 자리는 있고(=상장됨) 내용이 비었다(=있어야 하는데 없음).
    expect(screen.getByTestId('venue-state-NXT')).toHaveAttribute('data-venue-state', 'absent');
    expect(screen.getByTestId('venue-state-KRX')).toHaveAttribute('data-venue-state', 'complete');
  });

  it('shows each venue state independently', () => {
    render(<VenueStateCell venues={[
      { venue: 'KRX', disk_state: 'complete', file_size_bytes: 1 },
      { venue: 'NXT', disk_state: 'source_partial', file_size_bytes: 1 },
      { venue: 'UN', disk_state: 'client_incomplete', file_size_bytes: 1 },
    ]} />);
    expect(screen.getByTestId('venue-state-NXT')).toHaveAttribute('data-venue-state', 'source_partial');
    expect(screen.getByTestId('venue-state-UN')).toHaveAttribute('data-venue-state', 'client_incomplete');
  });

  it('preserves the server-given slot order', () => {
    render(<VenueStateCell venues={[
      { venue: 'UN', disk_state: null, file_size_bytes: 0 },
      { venue: 'KRX', disk_state: 'complete', file_size_bytes: 1 },
    ]} />);
    const cells = screen.getByTestId('venue-state-cell').querySelectorAll('[data-testid^="venue-state-"]');
    expect([...cells].map((c) => c.getAttribute('data-testid'))).toEqual([
      'venue-state-UN', 'venue-state-KRX',
    ]);
  });
});
