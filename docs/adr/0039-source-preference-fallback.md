# 0039 — Source Preference는 preference + fallback이지 strict filter가 아니다

**Status:** accepted (2026-05-27)

**Related:**
- ADR-0013 — RangeBundle as single read-path
- ADR-0037 — Source별 서브폴더 layout
- `docs/superpowers/specs/2026-05-27-live-capture-design.md`

## Decision

Replay Viewer의 새 ChartViewPrefs 항목 **Source Preference**의 의미론은 **"선호도 + 폴백"** 이지 **"필터"** 가 아니다.

```
sourcePreference: "hogaplay" | "kis_live"

  per Stock-Date in range:
    sources_available = list_existing_sources(code, date)
    if not sources_available:
      → exclude this Stock-Date from RangeBundle (DataWarning issued)
    elif sourcePreference in sources_available:
      → render that source
    else:
      → fallback: render the other available source
```

즉 차트가 비어 보이는 경우는 **두 source 모두 없을 때만**. 사용자가 토글을 잘못 만지더라도 데이터가 사라지지 않는다.

`/live` 페이지도 본 토글을 따른다. 다만 "오늘 자"는 시간에 따라 데이터 가용성이 변하므로 **`list_existing_sources(code, date)`** 결과에 추가 항목이 들어간다:

```
"오늘 자" sources_available 판정 (`/live`에 한정):
  - promoted Parquet에 kis_live/ 가 있다 → 'kis_live' 가용 (18:00 promote 후)
  - promoted Parquet에 hogaplay/ 가 있다 → 'hogaplay' 가용 (사용자가 캡쳐 실행 후)
  - 위 둘 다 없고 라이브 SSE buffer에 데이터가 있다 → 'kis_live' 가용 (latency 0 source)
```

`/replay` 페이지의 sources_available은 위 셋째 줄이 없는 부분집합 — promoted Parquet만 본다. 동일 토글, 동일 fallback 의미론, source 가용성 판정에 SSE buffer를 더하느냐 마느냐의 차이뿐.

함의:
- 장 중 09:00~16:00: 토글이 `hogaplay`이고 오늘 자 hogaplay 캡쳐가 없으면 → fallback to `kis_live` (라이브 SSE buffer). 사용자는 KIS 실시간 데이터를 본다.
- 18:00 promote 후: 토글이 `kis_live`이면 promoted kis_live Parquet 사용. 토글이 `hogaplay`이고 사용자가 hogaplay 캡쳐를 실행했으면 그 데이터 사용. 둘 다 없는 시나리오는 없음 (kis_live는 자동 promote됨).
- 토글이 가리키는 source의 데이터가 부분적이어도(예: 09:00~12:00만 hogaplay) 그 source의 데이터만 표시. 가용한 시간대 밖은 빈 차트 — ADR-0039의 "source 선택은 stock-date 단위, 시간대 내 source mixing 없음" 정신 유지.

## Why

세 가지 대안을 검토했다.

**A. Strict filter** — 선택한 source가 없으면 그 Stock-Date를 RangeBundle에서 제외
거부 사유:
- 사용자가 "hogaplay 우선"으로 설정한 상태에서 일부 Stock-Date만 hogaplay이 없는 경우 (예: KIS만 운용한 시범기간), 차트에 빈 구간이 생긴다. UX 함정 — 사용자는 "데이터가 없다"고 오해.
- 두 source가 보완 관계(시간차로 한 source가 늦게 들어옴)인 본 시스템의 운영 모델과 맞지 않음.

**B. 셋째 옵션 "auto" (가용한 것 중 해상도가 높은 것 자동 선택)**
거부 사유:
- "auto"의 정확한 의미를 사용자에게 설명하기 어려움 — "해상도가 높은" 기준이 hardcoded(=hogaplay 항상 우선) 외엔 ill-defined.
- 어차피 hogaplay이 항상 우선이라면 명시적 "hogaplay" 선택과 동일 — 옵션이 늘어나기만 함.

**C. Preference + fallback** ← 채택
근거:
- 토글 의미가 명확: "둘 다 있으면 어느 걸 보고 싶으세요?" — 사용자 mental model 단순.
- 데이터가 사라지는 경우 = 진짜로 없는 경우 → 디버깅 단순.
- frontend에 segments[i].source 뱃지를 같이 표시하면 사용자가 fallback이 발동했음을 인지 가능.

## Why expose this at all (왜 자동으로 정하지 않는가)

두 source의 해상도가 다르므로(hogaplay = tick-level, kis_live = 10s snapshot) 같은 Stock-Date라도 다른 차트가 나온다. "어떤 source를 봤는지"가 분석 결과에 영향을 미친다 — 시스템이 자동으로 결정하면 사용자가 한 종목의 두 측정을 비교할 방법이 없다. 그래서 사용자 명시적 선택을 위한 토글이 필요.

기본값은 `"hogaplay"` — 더 fine-grained 데이터를 default로 노출.

## Invariant introduced

> `/api/range`의 source_pref 쿼리 파라미터는 응답 shape을 바꾸지 않는다. 차이는 segments[i].source 값과 그 segment의 series 데이터뿐 — RangeBundle wire 타입 자체는 source_pref에 무관.

> RangeBundle.excluded_dates에 포함되는 Stock-Date는 "어떤 source도 존재하지 않음"으로만 발생 — source_pref가 fallback에 실패한 결과는 excluded_dates가 아니라 정상 segment로 fallback source의 데이터.

위반 시: source_pref가 사실상 filter로 동작하면 UX 함정 시나리오 발생.

## Frontend 표시 의무

- 차트 segment마다 작은 source 뱃지 ("hogaplay" / "kis_live") 표시. tick-level이 아닌 segment에서 사용자가 해상도를 오해하지 않게.
- Settings popover에서 토글을 바꾸면 React Query refetch — sourcePreference가 query key에 포함되어야 함.
- 두 source 모두 없는 Stock-Date(excluded_dates)는 기존 DataWarning UX와 동일하게 표시.

## Future signal to revisit

- 세 번째 source(예: KIS WebSocket)가 추가되면 두 값 enum이 부족. ordered list 의미론(`["hogaplay", "kis_live", "kis_ws"]` 우선순위)으로 진화 필요.
- 사용자가 source별로 차트를 *나란히* 보고 싶다는 요구가 정당화될 때 — 그 경우는 단일 사용자 토글이 아니라 multi-pane 차트 비교 모드가 필요.
