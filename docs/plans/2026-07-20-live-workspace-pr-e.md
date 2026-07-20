# /live 멀티창 PR-E 플랜 — 프리셋 v3 + 성능 마감

ADR-0119 마지막 PR. #713 해소 코멘트가 프리셋 v3 방침을 확정("워크스페이스 전체
스냅샷, 그룹별 종목 포함, v2 자동 이관"). 스냅존·Tidy 는 PR-A 에서 이미 착지 →
남은 성능 항목은 비포커스 창 스로틀·단축키.

전제: #721(D1+D2) 위 스택. 실행 순서 E1 → E2. 각 증분 독립 커밋.

---

## 현황 (2026-07-20 실측)

- **프리셋 = v2**(`schema_version:2`): payload = 포커스 차트 창 지표 1벌 +
  우측 패널 배치(ADR-0114 레거시를 멀티창에 얹은 것). 플립 후에도 "화면 구성"만
  담고 **창 목록·위치·그룹→종목은 안 담는다**.
- **저장된 프리셋 = 0개**(`saves.json` = `{"schema_version":2,"presets":[]}`) →
  **v3 이관 부담 실질 0**(버전 범프 시 폐기해도 손실 없음, 기존 백엔드 패턴 그대로).
- 백엔드: `_CURRENT_VERSION=2`, `load_presets` 가 구버전 파일을 빈 목록으로 폐기
  (변환 안 함). payload = pydantic `LiveLayoutPresetPayload`.
- 캡처/적용: `layoutPresetSnapshot.ts` — `capturePresetPayload()`·
  `applyPresetPayload()`·`defaultPresetPayload()`. `LayoutPresetMenu` 가 호출.
- 단축키: `useLiveKeyboard` — Shift+1~4(포커스 창 timeframe)·j/k(관심종목)·w(패널).
- 비포커스 스로틀: **없음**. 각 차트 창이 `useLiveSeries`(SSE 150ms flush)로
  틱마다 재렌더 — #709 가 "SSE 150ms flush×창 수 재렌더 → 비활성 스로틀이 완화책"
  으로 지목.

---

## E1. 프리셋 v3 — 워크스페이스 전체 스냅샷

### 스키마 (#713 §5)

payload v3 = 워크스페이스 스냅샷:
```
{
  windows: [{ id, kind, group, rect{x,y,w,h}, chart?{timeframe, indicators, lastMinuteTimeframe} }],
  zOrder: string[],
  groupSymbols: { [group]: {code, name, kind?} },
}
```
= 워크스페이스 스토어 `Persisted` 와 **동형**(뷰포트·chartRuntime 제외 — 비저장
관례 §6). 프리셋은 이 스냅샷을 통째로 저장/복원한다.

### 백엔드 (`hoga/api/live_layout_presets.py` · `models.py`)

- `LiveLayoutPresetPayload` pydantic 모델 → v3 형태(windows·zOrder·groupSymbols).
  창 kind·group·rect 는 관대 검증(프론트 `readWindow` 미러, 손상 엔트리 드롭).
- `_CURRENT_VERSION` 2 → 3. 빈 v2 파일은 기존 폐기 경로로 자연 소멸(손실 0).
- 라우트(`live_layout_preset_routes.py`)는 payload 타입만 바뀌고 CRUD 무변경.

### 프론트

- `api/liveLayoutPresets.ts`: `LiveLayoutPresetPayload` → 워크스페이스 스냅샷 타입,
  `schema_version: 3`.
- `state/workspace.ts`: **`applyWorkspaceSnapshot(snapshot)`** 신설 — windows·
  zOrder·groupSymbols 통째 교체 + chartRuntime 전체 리셋(fresh-view) + persist.
  창 id 는 스냅샷 값 유지(안정)하되 충돌 없게 그대로 채택. `snapshotWorkspace()`
  getter(현 Persisted 3필드 추출) 도 추가.
- `presets/layoutPresetSnapshot.ts`:
  - `capturePresetPayload()` → `snapshotWorkspace()`.
  - `applyPresetPayload()` → `applyWorkspaceSnapshot()`. **레거시 liveLayout
    (우측 패널) 적용 경로 제거** — 데이터 창이 워크스페이스로 이주(C)했으므로
    right_card_* 는 죽은 개념. (liveLayout 스토어 자체는 다른 소비자 확인 후 정리
    여부 결정 — 이 PR 범위는 프리셋 경로만.)
  - `defaultPresetPayload()` → 공장 워크스페이스(`defaultWindows()` 재사용).
- `presets/LayoutPresetMenu.tsx`: 캡처/적용 시맨틱 문구만 갱신("현재 워크스페이스
  저장"·"이 레이아웃 적용"). 프리셋 = 종목 포함 전체 스냅샷이므로 적용 시 창·종목·
  배치가 통째 바뀐다(TradingView 레이아웃 관례, #713 §5).
- `presetFlags.ts`·`by_timeframe_enable` 계열은 v3 에선 창별 indicators 에 흡수 —
  프리셋 payload 에서 제거(창 스냅샷이 지표를 이미 담음).

### 검증

- 백엔드: pydantic 왕복(v3 payload 저장→로드 동형)·구 v2 파일 폐기 테스트.
- 프론트: `snapshotWorkspace`↔`applyWorkspaceSnapshot` 왕복 동형·손상 엔트리 드롭·
  chartRuntime 리셋. 캡처→저장→적용 통합(창 2개+그룹2 종목 스냅샷 복원).
- 도그푸딩: 창 3개+그룹별 종목 배치 → 프리셋 저장 → 레이아웃 흐뜨림 → 프리셋 적용
  → 창·종목·배치 복원. 새로고침 후 프리셋 목록 유지.

---

## E2. 성능 마감 — 비포커스 창 스로틀 + 단축키

### E2a. 비포커스 차트 창 SSE 재렌더 스로틀

문제(#709): N개 차트 창이 각자 `useLiveSeries` 로 SSE 150ms flush 마다 재렌더 →
창 수에 비례한 재렌더 비용. 포커스(+대상) 창만 150ms, 비포커스는 느리게.

**접근(저위험 우선)**: `useLiveSeries` 의 flush 주기를 인자화 —
`useLiveSeries(code, { flushMs })`. ChartWindow 가 포커스 여부로 flushMs 선택
(포커스 150ms, 비포커스 600ms 등). **버퍼는 모든 푸시를 계속 누적**(드롭 0) —
재-READ 주기만 늘려 재렌더를 줄인다(기존 트레일링 스로틀의 window 만 확대, 로직
동일). 포커스 전환 시 즉시 1회 flush 로 최신 반영.

- 리스크: 비포커스 창의 현재가 라인·호가 지연이 ≤600ms 로 늘어남(수용 가능,
  비포커스라 시선 밖). 크로스헤어 미러(D2)는 cursorMs(무스로틀)라 무관.
- 대안(더 보수적): 스로틀은 두되 flushMs 차등은 **차트 창에만**(데이터 창은
  자기 창이 latest 표시라 유지). 필요 시 E2a 를 아예 보류하고 단축키만.

### E2b. 창 관리 단축키

`useLiveKeyboard` 확장(입력 필드에선 억제, 기존 규율):
- `n` — 활성 그룹에 차트 창 추가(툴바 +차트 미러).
- `Ctrl/Cmd 없는` `[` `]` 또는 `Tab`/`Shift+Tab` — 포커스 창 z-순환(다음/이전).
- `Delete`/`Backspace` — 포커스 창 닫기(드로잉 삭제와 충돌 주의 → 드로잉 없을 때만,
  또는 별도 키). **충돌 검토 필수**: DrawingOverlay 가 이미 Delete/Ctrl+Z 리스너
  (창별, useIsFocusedWindow 게이트)를 가짐 → 창 닫기는 다른 키(`x` 또는 Shift+w).
- `t` — Tidy(정리) 트리거.

스펙이 "단축키"만 명시(#715 잔여 세부)라 **최소 안전 집합**만: `n`(추가)·`t`(정리)·
포커스 순환. 파괴적(창 닫기)은 드로잉 리스너 충돌 탓에 보수적으로(별도 키 or 제외).

### 검증

- E2a: `useLiveSeries` flushMs 인자 단위 테스트(누적 불변·재-read 주기)·포커스
  전환 즉시 flush. 도그푸딩(차트 4창, 비포커스 재렌더 빈도 저하·데이터 손실 0).
- E2b: 단축키 유닛(입력 억제·각 키 동작)·드로잉 리스너 무충돌 확인.

---

## 공통 마감

- ADR-0119 PR-E 행 갱신(착지 범위·ADR 상태 draft→accepted 검토).
- 전체 vitest·tsc·build·eslint 순증 0(파일별 HEAD 대조).
- 도그푸딩: 워크트리 vite+`/api` 프록시(config.json 임시, 커밋 전 원복, 포트 실확인).
- `/study` 무회귀.

## 리스크·결정 포인트

1. **E1 백엔드 스키마 2→3**: 서버 영속 데이터 형식 변경. 저장 프리셋 0개라 손실
   위험은 없으나 **되돌리기 비용 있는 커밋**(서버 재배포 필요). ← 실행 전 확인 권장.
2. **E2a 비포커스 스로틀**: SSE 핫패스 인접. flushMs 차등은 저위험(누적 불변)이나,
   보수적으로 **보류하고 단축키만** 하는 선택지도 명시(E2a optional).
3. **liveLayout(우측 패널) 스토어 잔재**: 프리셋 경로에서 빠지면 다른 소비자
   유무 확인 후 별도 정리(이 PR 범위 밖, 데드코드 스윕은 후속).

## 권장 스코프

- **E1 전량**(스펙 확정·이관 부담 0) + **E2b 단축키**(저위험 additive).
- **E2a 는 optional** — E1+E2b 착지 후 실사용 관찰로 필요성 판단(성급한 핫패스
  변경 회피). ADR "성능 마감"의 스냅존·Tidy 는 이미 완료라 E2a 없이도 PR-E 의
  성능 항목 대부분 충족.
