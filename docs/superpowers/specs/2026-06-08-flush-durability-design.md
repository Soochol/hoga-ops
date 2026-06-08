# flush 내구성 — subtract-on-commit + per-code 격리

- **Date**: 2026-06-08
- **Status**: Implemented (2026-06-08)
- **Scope**: `backend` — `hoga/live/downsampler.py` + `hoga/live/stream.py`
- **Topic slug**: `flush-durability`
- **관련 리뷰**: 2026-06-07 멀티에이전트 리뷰 #11 (flush 내구성). 같은 P1 데이터손실 클래스의 #8(반장일)·#14(mixed-day)는 본 묶음에서 제외 — 아래 §5.

---

## 1. 문제 (코드 검증 2026-06-08)

`TickDownsampler.flush()`(downsampler.py:60-87)가 fill 스냅샷을 만든 **직후 같은 메서드 안에서** `st.buy_qty = 0 / st.sell_qty = 0`으로 리셋한다(line 84-85). 그 뒤 `stream.flush_once`(stream.py:99-123)가 코드별로 `await self._writer.append(...)`를 호출하는데, **append가 실패하면**(OSError — 디스크 풀·NFS 블립·권한) `run_flush_loop`(stream.py:139-142)이 로그만 남기고 materialize된 스냅샷을 폐기한다. 합계는 이미 0이 됐으므로 **그 10초 윈도의 전 종목 체결 합이 영구 소실** — fills.parquet이 그 구간 체결강도를 복구 불가하게 과소 보고한다.

## 2. 설계 — subtract-on-commit (advisor 검증)

### 2.1 왜 "zero-on-commit"이 아니라 "subtract-on-commit"인가

순진한 수정("flush는 리셋 안 함, append 성공 후 commit이 0으로 리셋")은 **happy-path 틱 손실을 새로 만든다**: flush가 buy=5를 읽고 → `await append` 도중 on_tick이 buy=6으로 증가 → append 성공 → commit이 0으로 리셋 → **6번째 틱 손실**. 매 성공 flush의 await 창마다 누수 — #11이 보호하려는 바로 그 차원의 상시 출혈.

올바른 방식: commit이 **flush가 본 양만큼만 뺀다**.
- flush 시점 buy=5 → fill 스냅샷에 buy=5 기록 → `await append` 중 buy=6 → append 성공 → `commit_code(buy=5)` → `st.buy_qty -= 5` → buy=1 (6번째 틱 보존).
- append 실패 → commit 호출 안 함 → buy=6 그대로 → **다음 윈도로 롤**(데이터 보존).

### 2.2 메서드 분리 (downsampler.py)

- `flush(now_ms, phase, fill_t_ms)`: 현재와 동일하게 코드별 [ob?, broker?, fill] 스냅샷 반환. **단 buy/sell 리셋을 제거**(line 84-85 삭제). `last_ob`/`last_broker` carry는 원래도 안 건드리므로 보존(quiet-stock carry 무영향).
- `commit_code(code, buy_qty, sell_qty)`: 신규. `st.buy_qty -= buy_qty; st.sell_qty -= sell_qty`. 음수 방지는 불필요(뺀 값이 항상 ≤ 현재값 — flush가 본 스냅샷이므로). 코드가 그새 evict됐으면(set_active_codes) no-op.

### 2.3 per-code 격리 (stream.py)

`flush_once`의 코드별 루프를 **per-code try/except**로:
```
flushed = self._ds.flush(now_ms, phase, fill_t_ms)   # 리셋 안 함
for code, snaps in flushed.items():
    try:
        await self._writer.append(date, code, snaps)
        fill = <snaps 중 FILL 스냅샷>
        self._ds.commit_code(code, fill.buy_qty, fill.sell_qty)   # 성공만 commit
    except OSError:
        _log.exception("live.stream.append_failed code=%s", code)
        # commit 안 함 → 이 코드 합 보존 → 다음 윈도 롤
await self._writer.fsync_all()
self.last_flush_ms = now_ms
```
한 코드의 디스크 오류가 **다른 코드의 윈도를 버리지 않는다**(현재는 첫 실패가 flush_once 전체를 중단시켜 나머지 코드도 미기록). 부분 윈도 손실 수용: 실패 코드는 다음 윈도에 합산돼 라벨만 다음 윈도 시작으로 — 데이터는 보존.

### 2.4 last_flush_ms 의미

`last_flush_ms`는 flush 성공 시각(fill 라벨용, 리뷰 #5)이므로 flush_once 끝에서 갱신 유지. 일부 코드 append가 실패해도 윈도 경계 자체는 진행(다음 윈도 라벨 = 이번 now_ms). 실패 코드의 롤된 합은 다음 윈도 시작 라벨로 기록 — §2.1 트레이드오프대로.

## 3. 데이터 흐름

```
flush(materialize, no reset) → snaps[code]
  per code:
    await append(code) ──success──▶ commit_code(code, buy, sell)  → st.buy -= buy
                       └─OSError──▶ (no commit)                   → st.buy 보존 → 다음 윈도
  await fsync_all
```

## 4. 테스트 전략 (TDD)

1. **await-창 틱 보존(핵심, advisor)**: stubbed **느린** append(await 중 제어 양보) 도중 `on_tick`으로 buy 증가시키고, commit 후 `st.buy_qty`가 0이 아니라 (증가분)인지 단언. **순차 호출 테스트는 buggy/correct 양쪽 다 통과하므로 안 됨** — append await 중 ingest가 끼어드는 인터리브를 강제.
2. **append 실패 시 합 보존**: append가 OSError → commit 안 됨 → 다음 flush가 그 합을 포함. 손실 0.
3. **per-code 격리**: 코드 A append 실패 + 코드 B 성공 → B는 commit·기록, A는 보존. A 실패가 B를 안 버림.
4. **happy path 회귀 없음**: 정상 flush→append→commit 후 buy/sell=0(추가 틱 없으면), 기존 fill 스냅샷 값·라벨 불변.
5. 기존 downsampler/stream 테스트(carry/리셋/일경계/active-set) 무수정 그린.

## 5. 비범위 (advisor 결정 2026-06-08)

- **#8 반장일 12:30 게이트**: KIS chk-holiday가 조기마감 시각을 안 줌(binary opnd_yn). 수정엔 **수동 반장일 캘린더**(KRX 반장일 = 연 몇 일, 사전 공지 — medium·self-contained)가 필요. 별도 작업으로 TODOS에 재프레임. carry-timeout 우회(전 코드 N분 무틱 시 carry 중단)는 별도 설계로 보류.
- **#14 mixed-day fills**: poller가 이 브랜치에서 삭제돼 post-merge엔 kis_live trades.parquet을 쓰는 경로가 없음. mixed-day는 이 브랜치 **장중 배포일에만** 발생 → "세션 밖 배포" 지침으로 회피. 영구 read-path 병합 대신 **deploy 체크리스트 한 줄** + (발생 시) 일회성 trades→fills backfill. 코드 변경 없음.
