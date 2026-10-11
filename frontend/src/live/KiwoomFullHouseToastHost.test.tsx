import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushEvent } from '../api/types';
import KiwoomFullHouseToastHost from './KiwoomFullHouseToastHost';
import { useKiwoomFullHouseStore } from '../state/kiwoomFullHouse';

const subs: Array<(event: PushEvent) => void> = [];

vi.mock('../api/ws', () => ({
  subscribeEvents: (cb: (event: PushEvent) => void) => {
    subs.push(cb);
    return () => {
      const index = subs.indexOf(cb);
      if (index >= 0) subs.splice(index, 1);
    };
  },
}));

function emit(event: PushEvent): void {
  act(() => {
    subs.forEach((cb) => cb(event));
  });
}

describe('KiwoomFullHouseToastHost', () => {
  beforeEach(() => {
    subs.length = 0;
    useKiwoomFullHouseStore.getState().clear();
  });

  it('만석 이벤트가 오기 전에는 아무것도 렌더하지 않는다', () => {
    render(<KiwoomFullHouseToastHost />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('만석 이벤트를 토스트로 알린다 — 이 배선이 없으면 만석이 무증상이다', () => {
    render(<KiwoomFullHouseToastHost />);

    emit({ type: 'kiwoom_full_house', code: '005930' });

    const toast = screen.getByRole('status');
    expect(toast).toHaveTextContent('실시간 구독 슬롯 부족');
    expect(toast).toHaveTextContent('005930');
    // 복구 조건을 알려 줘야 사용자가 할 일을 판단할 수 있다.
    expect(toast).toHaveTextContent('브라우저 탭');
    expect(toast).toHaveTextContent('자동으로 연결');
  });

  it('닫으면 사라지고, 같은 종목의 반복 보고로는 다시 열리지 않는다', () => {
    render(<KiwoomFullHouseToastHost />);
    emit({ type: 'kiwoom_full_house', code: '005930' });

    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(screen.queryByRole('status')).toBeNull();

    // 재연결 재구독 등으로 같은 종목이 다시 보고돼도 새 사실이 아니다.
    emit({ type: 'kiwoom_full_house', code: '005930' });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('새 종목이 보고되면 닫혔던 토스트를 다시 연다', () => {
    render(<KiwoomFullHouseToastHost />);
    emit({ type: 'kiwoom_full_house', code: '005930' });
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));

    emit({ type: 'kiwoom_full_house', code: '000660' });

    expect(screen.getByRole('status')).toHaveTextContent('000660');
  });

  it('종목이 3개를 넘으면 나머지를 "외 N개"로 접는다', () => {
    render(<KiwoomFullHouseToastHost />);
    for (const code of ['005930', '000660', '035420', '051910', '207940']) {
      emit({ type: 'kiwoom_full_house', code });
    }

    const toast = screen.getByRole('status');
    expect(toast).toHaveTextContent('005930, 000660, 035420');
    expect(toast).toHaveTextContent('외 2개');
  });

  it('재연결 시 stale 보류 목록을 버린다 — 이미 풀린 종목이 남으면 오정보다', () => {
    render(<KiwoomFullHouseToastHost />);
    emit({ type: 'kiwoom_full_house', code: '005930' });
    expect(screen.getByRole('status')).toBeInTheDocument();

    emit({ type: 'disconnected' });

    expect(screen.queryByRole('status')).toBeNull();
    expect(useKiwoomFullHouseStore.getState().pendingCodes).toEqual([]);
  });

  it('앱 참조 한도는 키움 슬롯 부족과 다른 알림·복구 안내를 표시한다', () => {
    render(<KiwoomFullHouseToastHost />);
    emit({ type: 'live_subscription_limit', code: '005930' });
    const toast = screen.getByRole('status', { name: '앱 화면 구독 한도 초과' });
    expect(toast).toHaveTextContent('새로고침');
    expect(screen.queryByText('키움 실시간 구독 슬롯 부족')).toBeNull();
    expect(useKiwoomFullHouseStore.getState().pendingCodes).toEqual([]);
  });

  it('서로 다른 경고는 독립적으로 닫고 재연결 시 모두 지운다', () => {
    render(<KiwoomFullHouseToastHost />);
    emit({ type: 'live_subscription_limit', code: '005930' });
    emit({ type: 'kiwoom_full_house', code: '000660' });
    expect(screen.getAllByRole('status')).toHaveLength(2);
    const appToast = screen.getByRole('status', { name: '앱 화면 구독 한도 초과' });
    fireEvent.click(appToast.querySelector('button')!);
    expect(screen.getByRole('status')).toHaveTextContent('키움 실시간 구독 슬롯 부족');
    emit({ type: 'live_subscription_limit', code: '005930' });
    expect(screen.getAllByRole('status')).toHaveLength(1);
    emit({ type: 'live_subscription_limit', code: '035420' });
    expect(screen.getAllByRole('status')).toHaveLength(2);
    emit({ type: 'disconnected' });
    expect(screen.queryByRole('status')).toBeNull();
    expect(useKiwoomFullHouseStore.getState().referenceLimitCodes).toEqual([]);
  });
});
