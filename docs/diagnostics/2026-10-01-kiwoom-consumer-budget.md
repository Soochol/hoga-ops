# 키움 consumer 양보 예산 개선 검증

이 변경은 PR #1913 이후 남은 큐 초과를 대상으로 한다. 기존 운영 구간에서 8회
초과/1,030건 폐기가 확인됐고, 그 구간의 자연 gen2는 관측되지 않았다. 운영에서
수초간 대기가 발생한 원인을 GC 하나로 확정할 수 없으므로, 재현 가능한 스케줄링
결함을 수정하면서 다음 큐 장애 때 비교할 CPU·입력률·처리율·GC 증거를 추가한다.

## 오프라인 재현

기준은 main `7cd75212f`의 KiwoomWsClient, 후보는 이 PR의 코드다. 다음 명령은
공급사 연결이나 자격증명 없이 합성 프레임을 사용한다.

```sh
git show 7cd75212f:hoga/live/kiwoom_ws_client.py > /tmp/kiwoom-baseline.py
.venv/bin/python -m tools.bench_kiwoom_consumer_budget --baseline-client /tmp/kiwoom-baseline.py
```

한 소켓에 이미 버퍼링된 REAL 240프레임을 입력하고 실제 파서와 LiveBuffer를
사용한다. 경쟁 태스크 8개는 매 회전마다 각각 2ms CPU를 소비한다. 4행/16행 프레임을
각 3회 비교했다. 동기적으로 완료되는 콜백에서는 기준 6회 모두 큐 초과, 후보 6회
모두 전체 처리였다. 이는 거래소부터의 종단 지연이나 장중 최고 부하 결과가 아니다.
상세 수치와 완료 여부는 [합성 부하 관측 JSON](2026-10-01-kiwoom-consumer-budget.json)에 보존했다.

**과부하 조건은 남는다.** 매 틱마다 `sleep(0)` 하는 콜백과 240프레임 선입력에서는
후보도 큐 초과가 발생한다. 3초 내 완료하지 못한 기준 표본도 있어 단순히
`overflow=false`를 성공으로 세면 안 된다. 도구는 complete/overflow/incomplete를
구분한다. 후보 reader의 처리 속도가 올라 큐 상한에 먼저 도달할 수도 있으므로
오류 발생까지의 시간만으로 처리 성능이나 안정성을 비교하지 않는다.

## 실제 저장·집계 경로

`test_kiwoom_pipeline_budget.py`는 6개 오프라인 소켓에 319종목을 분할하고 각각
96프레임×4행, 전체 2,304틱을 입력한다. KRX/NXT/UN의 체결과 호가를 섞고 실제
LiveStream, 표시 버퍼, downsampler, 최대벽 상태, 분봉 합성기, SecondTradeStore와
LiveWriter를 사용한다. 콜백은 8틱마다 실행을 양보하고, 소비 중 초단위 집계와
기존 JSONL 저장을 병행한다.

검증은 계정별 틱 순서, 319종목 커버리지, PING echo와 REG ACK 완료, 큐 초과/폐기 0,
계정별 96프레임 완료, 파일에서 읽은 체결 수량 합(계정당 384), 최대벽 상태와 기존
JSONL 생성이다. 콜백/제어 격리와 취소 해제는 별도 단위 테스트로 검증한다. 이 테스트의
유한 입력과 저장 무손실은 임의의 입력률에서 무손실을 보장하는 증거가 아니다.

전체 `not wallclock` 검증에서 가격 스케일 계약 1건과 당일 캔들 backfill의
`trade_value_won=None` 기대값 3건이 실패했다. 기준 `7cd75212f`를 별도 임시 사본으로
검증해 같은 4건 실패를 재현했다(해당 파일 4 failed/28 passed). 이 PR 범위에서
다른 기능의 계약이나 기대값을 변경하지 않는다.
최종 검증은 Ruff 통과, 직접 관련 테스트 64 passed, 전체 `not wallclock`은
5,315 passed/4 failed/2 skipped/13 deselected다. 전체 실패 4건은 위 기준 사본에서
동일하게 재현한 기존 실패다.

## 적용 후 판단

장중 동일 commit/PID/live 시작 시각별로 큐 초과·폐기 증가, 재연결과 등록 상태를
비교해야 한다. 새 프로세스의 0 카운터를 개선으로 해석하지 않는다. 큐 초과 로그의
`window_ms`, 수신/완료 프레임률, in-flight 경과, 프로세스/루프 스레드 CPU, GC 세대별
정지 시각을 함께 대조한다. 스레드 CPU는 계정별 CPU가 아니고, 낮은 CPU에서도 OS
절전이나 스케줄러 대기 등 여러 원인이 가능하다.

자연 gen2, 이력 포화 이후 상태와 장중 부하를 다시 관측하기 전에는 기존 5.6초 GC
정지나 운영 큐 손실이 해결됐다고 결론내리지 않는다.
