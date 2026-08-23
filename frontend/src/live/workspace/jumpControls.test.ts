import { describe, expect, it } from 'vitest';
import { jumpReceiverIds, type JumpReceiverCandidate } from './jumpControls';

const chart = (
  id: string, group: number | null, timeframe: 'D' | '1m' | '5m',
): JumpReceiverCandidate => ({ id, kind: 'chart', group, chart: { timeframe } });

const WINDOWS: readonly JumpReceiverCandidate[] = [
  chart('daily', 1, 'D'),
  chart('m1', 1, '1m'),
  chart('m5', 1, '5m'),
  chart('other-group', 2, '1m'),
  { id: 'book', kind: 'book', group: 1 },
];

/**
 * 「분봉으로」를 누르면 결과가 **다른 창**에서 일어난다 — 그 창이 가려져 있으면
 * 사용자 눈에는 아무 일도 안 일어난다(실측 2026-08-23: 창 추가 기본 배치가 겹친다).
 * 그래서 수신 창을 올리는데, 그 대상 판정이 이 함수다.
 */
describe('jumpReceiverIds', () => {
  it('같은 창번호의 **분봉 차트 창**만 고른다', () => {
    expect(jumpReceiverIds(WINDOWS, ['daily', 'm1', 'm5'], 'daily', 1).sort())
      .toEqual(['m1', 'm5']);
  });

  it('자기 자신은 세지 않는다 — 봉이 바뀌어도 조용히 어긋나지 않게', () => {
    // 발행 창이 분봉이 되는 조합은 없지만, 조건을 창 종류에 기대면 그때 어긋난다.
    expect(jumpReceiverIds(WINDOWS, ['m1'], 'm1', 1)).toEqual(['m5']);
  });

  it('다른 창번호·차트가 아닌 창은 제외한다', () => {
    expect(jumpReceiverIds(WINDOWS, [], 'daily', 2)).toEqual(['other-group']);
    expect(jumpReceiverIds([{ id: 'book', kind: 'book', group: 1 }], [], 'daily', 1))
      .toEqual([]);
  });

  // 차례로 올리면 뒤엣것이 위로 간다 — zOrder 순으로 내보내야 상대 순서가 보존된다.
  it('zOrder 순으로 낸다 — 여럿을 올려도 상대 순서가 뒤집히지 않는다', () => {
    expect(jumpReceiverIds(WINDOWS, ['m5', 'daily', 'm1'], 'daily', 1))
      .toEqual(['m5', 'm1']);
  });

  it('보낼 곳이 없으면 빈 배열', () => {
    expect(jumpReceiverIds([chart('daily', 1, 'D')], ['daily'], 'daily', 1)).toEqual([]);
  });
});
