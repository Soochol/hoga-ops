import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { useOptimisticDuplicateGate } from './useOptimisticDuplicateGate';

/**
 * 이 훅의 계약은 **두 줄**이고, 둘 다 타이밍이라 화면 단언으로만 잡힌다:
 *
 *  1. 제출이 도는 동안 `duplicate` 는 거짓이다 — 낙관 캐시가 내 행을 이미 넣어 놨으므로
 *     그러지 않으면 폼이 자기 자신을 고발한다.
 *  2. `submitting` 은 `fn` 이 **끝난 뒤에** 내려간다 — 호출부의 선택 초기화가 `fn` 안에
 *     있으면 두 갱신이 한 배치로 커밋돼 중간 상태가 화면에 안 나타난다.
 *
 * 하네스는 **낙관 캐시를 흉내 낸다**: 제출을 시작하는 순간 `added` 에 코드가 들어가
 * `isDuplicate` 가 참으로 뒤집힌다. 실제 mutation 의 `onMutate` 가 하는 일과 같다.
 */

function Harness({ onRun }: { onRun: (release: () => void) => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const { duplicate, submitting, run } =
    useOptimisticDuplicateGate(picked, (code) => added.includes(code));
  return (
    <div>
      <button onClick={() => setPicked('005930')}>pick</button>
      {/* 한 핸들러 안에서 두 번 — 리렌더가 끼지 않으므로 state 로 판정하면 둘 다 통과한다.
          버튼 `disabled` 도 여기선 도움이 안 된다(이미 핸들러 안이다). */}
      <button onClick={() => {
        if (picked === null) return;
        const fn = async () => {
          setAdded((a) => [...a, picked]);
          await new Promise<void>((res) => onRun(() => res()));
          setPicked(null);
        };
        void run(fn); void run(fn);
      }}>두 번 추가</button>
      <button
        disabled={picked === null || duplicate || submitting}
        onClick={() => {
          if (picked === null) return;
          void run(async () => {
            setAdded((a) => [...a, picked]);           // 낙관 반영 = 판정이 뒤집히는 순간
            await new Promise<void>((res) => onRun(() => res()));
            setPicked(null);                            // ⚠ 반드시 fn **안**
          });
        }}
      >추가</button>
      <span data-testid="verdict">{duplicate ? '중복' : '아님'}</span>
      <span data-testid="picked">{picked ?? '없음'}</span>
    </div>
  );
}

describe('useOptimisticDuplicateGate', () => {
  beforeEach(() => cleanup());

  it('제출이 도는 동안 중복 판정이 얼어 있다 — 자기 자신을 고발하지 않는다', async () => {
    let release: () => void = () => {};
    render(<Harness onRun={(r) => { release = r; }} />);
    fireEvent.click(screen.getByText('pick'));
    expect(screen.getByTestId('verdict').textContent).toBe('아님');

    fireEvent.click(screen.getByText('추가'));
    // 낙관 반영으로 `added` 에 이미 들어갔지만 판정은 얼려 있어야 한다.
    await waitFor(() => expect(screen.getByText('추가')).toBeDisabled());
    expect(screen.getByTestId('verdict').textContent).toBe('아님');

    await act(async () => { release(); });
    // 끝나면 선택이 비므로 판정 대상 자체가 없다 — 배너가 스쳐 뜨지 않는다.
    expect(screen.getByTestId('picked').textContent).toBe('없음');
    expect(screen.getByTestId('verdict').textContent).toBe('아님');
  });

  it('제출이 끝난 뒤 다시 고르면 그때는 중복이라고 말한다', async () => {
    // 위 완화가 "중복 검사를 없앴다" 로 미끄러지지 않았는지 — 반대 방향의 가드다.
    let release: () => void = () => {};
    render(<Harness onRun={(r) => { release = r; }} />);
    fireEvent.click(screen.getByText('pick'));
    fireEvent.click(screen.getByText('추가'));
    await act(async () => { release(); });

    fireEvent.click(screen.getByText('pick'));
    expect(screen.getByTestId('verdict').textContent).toBe('중복');
    expect(screen.getByText('추가')).toBeDisabled();
  });

  it('같은 렌더에서 두 번 들어와도 한 번만 실행한다', async () => {
    // 재진입 판정을 state 로 하면 둘 다 `false` 를 보고 통과한다 — ref 여야 한다.
    const started = vi.fn();
    let release: () => void = () => {};
    render(<Harness onRun={(r) => { started(); release = r; }} />);
    fireEvent.click(screen.getByText('pick'));
    // ⚠ 버튼을 연타하면 **리렌더가 끼어** state 판정으로도 막힌다(게다가 disabled 가
    // 먼저 걸린다) — 그 경로로 재면 ref 를 state 로 바꿔도 초록이라 아무것도 증명하지
    // 못한다(실측). 한 핸들러 안에서 두 번 부르는 것만이 이 가드에 닿는다.
    fireEvent.click(screen.getByText('두 번 추가'));
    expect(started).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
  });
});
