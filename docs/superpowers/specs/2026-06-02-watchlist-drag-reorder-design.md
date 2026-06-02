# 관심종목 드래그 재정렬 — Design

**Date**: 2026-06-02 (via `/superpowers:brainstorming`)
**Status**: Draft
**Scope**: backend — `hoga/api/watchlist.py`(`reorder_entries` 신규), `hoga/api/models.py`(`WatchlistReorderRequest` 신규), `hoga/api/watchlist_routes.py`(`PUT /order` 신규); frontend — `api/watchlist.ts`(`reorderWatchlist` 신규), `watchlist/useWatchlist.ts`(`useReorderWatchlist` 신규), `rightrail/QuoteRow.tsx`(선택적 drag props), `watchlist/SortableQuoteRow.tsx`(신규), `watchlist/reorderCodes.ts`(신규·순수함수), `watchlist/WatchlistDrawer.tsx`(dnd-kit 배선); 관련 테스트

## Problem

사용자 표현:

> "우측 패널에서 관심종목 패널에 관심종목을 마우스 드래그로 이동할 수 있는 기능 만들어줘"

현재 우측 레일의 관심종목 패널(`WatchlistDrawer`)은 등록 순서대로만 종목을 보여준다. 사용자가 자주 보는 종목을 위로 올리거나 그룹지어 정렬할 방법이 없다. 순서는 이미 `watchlist.json`의 리스트 순서로 서버에 영속되지만, 그 순서를 바꾸는 UI도 API도 없다.

## Invariants

- **관심종목 순서 = 전역 서버 상태**: `watchlist.json`의 리스트 순서가 곧 표시 순서이고, 드로어(`WatchlistDrawer`)·전체페이지 테이블(`WatchlistPanel`)·`catchup_all`의 순회까지 같은 순서를 공유한다. 근거: [watchlist.py:35-39](../../../hoga/api/watchlist.py#L35-L39) ("Order preserved = display order"), [watchlist_routes.py:93](../../../hoga/api/watchlist_routes.py#L93) (`for entry in load_watchlist(...)`).
- **watchlist 뮤테이션 직렬화**: load → mutate → save가 모듈 스코프 `_lock`(asyncio.Lock) 안에서만 일어나, API POST/DELETE와 `_finalize_item` 훅이 반-적용 상태로 교차하지 않는다. 근거: [watchlist.py:26-28](../../../hoga/api/watchlist.py#L26-L28).
- **watchlist 디스크 쓰기 원자성**: 저장은 항상 `atomic_write_json`을 통한다(부분 쓰기로 인한 손상 방지). 근거: [watchlist.py:65-71](../../../hoga/api/watchlist.py#L65-L71).
- **`QuoteRow` 공유 부품**: 관심종목 드로어와 스크리너 드로어가 같은 `QuoteRow` 행 컴포넌트를 공유한다(시각/키보드 계약 동일). 근거: [QuoteRow.tsx](../../../frontend/src/rightrail/QuoteRow.tsx), 사용처 `WatchlistDrawer.tsx`·`ScreenerDrawer.tsx`.
- **차트 종목 단일 진실 공급원**: 행 클릭은 `useJumpToLive()`(→ `setActiveCode`)로만 라우팅된다. 근거: [WatchlistDrawer.tsx:17](../../../frontend/src/watchlist/WatchlistDrawer.tsx#L17), [QuoteRow.tsx:21-26](../../../frontend/src/rightrail/QuoteRow.tsx#L21-L26).
- **react-query 캐시 공유**: 관심종목 데이터는 `['watchlist']` 키로 드로어·전체페이지·라이브 시세 코드 목록이 공유한다. 근거: [useWatchlist.ts:13](../../../frontend/src/watchlist/useWatchlist.ts#L13), [WatchlistDrawer.tsx:19-23](../../../frontend/src/watchlist/WatchlistDrawer.tsx#L19-L23).

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| 순서 = 전역 서버 상태 | preserves | 재정렬은 리스트 순서만 바꾸고 서버에 영속. 드로어 재정렬이 전체페이지 테이블·`catchup_all` 순회 순서를 함께 바꾸는 것은 **의도된 동작**(무해). |
| 뮤테이션 직렬화 | preserves | `reorder_entries`도 동일한 `_lock` 안에서 load→mutate→save. |
| 디스크 쓰기 원자성 | preserves | 동일 `save_watchlist`(→`atomic_write_json`) 경유. 순서 불변이면 디스크 미기록. |
| `QuoteRow` 공유 부품 | preserves(강화) | 드래그 props를 **전부 선택적**으로 추가. 스크리너는 미전달 → 현행 동작 그대로. 타입이 비-드래그 사용처를 강제로 무영향 보장. |
| 차트 단일 공급원 | preserves | 행 클릭은 그대로 `onClick`→jump. 8px 활성화 거리가 클릭/드래그를 분리. |
| 캐시 공유 | preserves | 동일 `['watchlist']` 키에 optimistic setQueryData + `onSettled` invalidate. |

*"intentionally breaks" 없음.* 모든 변경이 기존 속성을 보존한다.

## Goals

- `WatchlistDrawer`의 행을 **마우스 드래그로 재정렬**한다(행 전체 드래그, 8px 활성화 거리).
- 드롭 즉시 화면에 새 순서 반영(**optimistic**), 실패 시 원위치 롤백.
- 새 순서를 `PUT /api/watchlist/order`로 **서버 영속** → 새로고침·전체페이지에서도 유지.
- 기존 행 동작(클릭=차트 점프, Enter/Space=점프, hover 휴지통=해제) **전부 유지**.
- 동시 add/remove와 경합해도 깨지지 않게 서버가 관용 처리.

## Non-Goals (YAGNI)

- 전체페이지 `WatchlistPanel` 테이블의 드래그 UI — 새 순서를 read-only로 반영만.
- **키보드 재정렬** — dnd-kit `KeyboardSensor`의 Space(집기)가 행의 Space(차트 점프)와 충돌하므로 명시적 제외.
- 패널 간 드래그(스크리너 → 관심종목 등).
- 전용 그립 핸들 컬럼 — 행 전체 드래그 + 8px 활성화로 클릭 충돌을 해소하므로 불필요(밀집 레이아웃 유지).
- `WatchlistEntry`에 명시적 `position` 필드 추가 — 순서는 리스트 위치로 충분.

## Design

### 1. 백엔드 — `reorder_entries`

`hoga/api/watchlist.py`에 신규 함수. stale 코드 목록(동시 add/remove)에 관용적:

```python
async def reorder_entries(
    data_dir: Path, *, codes: list[str],
) -> list[WatchlistEntry]:
    """Rewrite watchlist order to match `codes`.

    Tolerant of a stale list: codes not currently present are ignored;
    entries not mentioned in `codes` are appended in their existing
    relative order. Shares `_lock` with add/remove/bump so a concurrent
    mutation can't interleave a half-applied state.
    """
    async with _lock:
        entries = load_watchlist(data_dir)
        by_code = {e.code: e for e in entries}
        seen: set[str] = set()
        ordered: list[WatchlistEntry] = []
        for c in codes:                      # 받은 순서대로, 아는 코드만, 중복 제거
            e = by_code.get(c)
            if e is not None and c not in seen:
                ordered.append(e)
                seen.add(c)
        for e in entries:                    # 언급 안 된 항목은 기존 상대순서로 뒤에
            if e.code not in seen:
                ordered.append(e)
        if [e.code for e in ordered] != [e.code for e in entries]:
            save_watchlist(data_dir, entries=ordered)   # 순서 동일 시 디스크 미기록
        return ordered
```

- `last_success_date`·`registered_at_kst_date`는 **건드리지 않음** — 객체를 그대로 재배치(`model_copy` 불필요).
- `refresh_live_poller` **호출 안 함**: 폴링 대상 코드 *집합*이 불변이라 재싱크 불필요(add/remove와 달리 멤버십이 변하지 않음).

### 2. 백엔드 — 모델 & 라우트

`hoga/api/models.py` — 기존 `WatchlistEntry.code`의 6자리 패턴을 원소에 재사용:

```python
class WatchlistReorderRequest(BaseModel):
    codes: list[Annotated[str, Field(pattern=r"^\d{6}$")]] = Field(
        description="Desired display order; 6-digit KRX codes.",
    )
```

`hoga/api/watchlist_routes.py` — `PUT /order`:

```python
@router.put("/order", response_model=WatchlistResponse)
async def reorder_watchlist(req: WatchlistReorderRequest) -> WatchlistResponse:
    entries = await reorder_entries(data_dir, codes=req.codes)
    return WatchlistResponse(
        entries=entries,
        next_run_at_ms=_next_run_at_ms(now_kst()),
    )
```

- `/order`는 리터럴 세그먼트라 `DELETE /{code}`(`^\d{6}$` path param)와 라우트 충돌 없음.
- `WatchlistResponse`를 반환해 프론트 optimistic 캐시와 형태 일치 → `onSettled` invalidate 후 매끄럽게 수렴.

### 3. 프론트엔드 — API & optimistic 훅

`frontend/src/api/watchlist.ts`:

```ts
export function reorderWatchlist(codes: string[]): Promise<WatchlistResponse> {
  return apiCall<WatchlistResponse>('/api/watchlist/order', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codes }),
  });
}
```

`frontend/src/watchlist/useWatchlist.ts` — optimistic 필수(라운드트립 대기 없이 즉시 안착):

```ts
export function useReorderWatchlist() {
  const qc = useQueryClient();
  return useMutation<WatchlistResponse, Error, string[], { prev?: WatchlistResponse }>({
    mutationKey: ['watchlist', 'reorder'],   // useIsMutating(['watchlist']) 게이팅에 포함
    mutationFn: (codes) => reorderWatchlist(codes),
    onMutate: async (codes) => {
      await qc.cancelQueries({ queryKey: KEY });
      const prev = qc.getQueryData<WatchlistResponse>(KEY);
      if (prev) {
        const byCode = new Map(prev.entries.map((e) => [e.code, e]));
        const reordered = codes
          .map((c) => byCode.get(c))
          .filter((e): e is WatchlistEntry => e !== undefined);
        const rest = prev.entries.filter((e) => !codes.includes(e.code)); // 동시 add 보존
        qc.setQueryData<WatchlistResponse>(KEY, { ...prev, entries: [...reordered, ...rest] });
      }
      return { prev };
    },
    onError: (_e, _codes, ctx) => { if (ctx?.prev) qc.setQueryData(KEY, ctx.prev); },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
```

### 4. 프론트엔드 — `reorderCodes` 순수 함수

`frontend/src/watchlist/reorderCodes.ts` — onDragEnd 로직을 테스트 가능한 순수 함수로 추출:

```ts
import { arrayMove } from '@dnd-kit/sortable';

/** 같은 슬롯/over 없음이면 null(=뮤테이션 스킵). 아니면 arrayMove 결과 코드 배열. */
export function reorderCodes(
  codes: string[], activeId: string, overId: string | null | undefined,
): string[] | null {
  if (overId == null || activeId === overId) return null;
  const from = codes.indexOf(activeId);
  const to = codes.indexOf(overId);
  if (from < 0 || to < 0) return null;
  return arrayMove(codes, from, to);
}
```

### 5. 프론트엔드 — `QuoteRow` 계약 변경

`frontend/src/rightrail/QuoteRow.tsx` — **전부 선택적** props 추가(미전달 시 현행 동작 그대로):

```ts
sortableRef?: (node: HTMLElement | null) => void;   // useSortable setNodeRef
sortableStyle?: React.CSSProperties;                 // transform / transition
dragListeners?: SyntheticListenerMap;                // 행 전체 드래그 → <li> 에 spread
dragAttributes?: DraggableAttributes;
dragging?: boolean;                                  // 드래그 중 시각 처리
```

`<li>`에 `ref={sortableRef}`, `style={{ ...기존, ...sortableStyle, ...(dragging ? { opacity: 0.6, cursor: 'grabbing' } : {}) }}`, `{...dragAttributes} {...dragListeners}`를 spread.

**충돌 해소**: `PointerSensor`의 `activationConstraint: { distance: 8 }`가 8px 미만 움직임을 클릭으로 흘려보낸다 → 기존 `onClick`(차트 점프)·Enter/Space 그대로 동작. 휴지통 버튼은 이미 `onMouseDown={e => e.preventDefault()}` + `onClick` `stopPropagation`이라([WatchlistDrawer.tsx:88-89](../../../frontend/src/watchlist/WatchlistDrawer.tsx#L88-L89)) 드래그 시작/행 클릭을 가로채지 않는다.

### 6. 프론트엔드 — `SortableQuoteRow` 래퍼

`frontend/src/watchlist/SortableQuoteRow.tsx` — `useSortable`를 캡슐화하고 `QuoteRow`에 drag props만 주입(스크리너는 bare `QuoteRow` 유지):

```tsx
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { QuoteRow } from '../rightrail/QuoteRow';

export function SortableQuoteRow({ code, ...rowProps }: { code: string } & QuoteRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging }
    = useSortable({ id: code });
  return (
    <QuoteRow
      {...rowProps}
      sortableRef={setNodeRef}
      sortableStyle={{ transform: CSS.Transform.toString(transform), transition }}
      dragListeners={listeners}
      dragAttributes={attributes}
      dragging={isDragging}
    />
  );
}
```

### 7. 프론트엔드 — `WatchlistDrawer` 배선

`<ul>`을 DnD 컨텍스트로 감싼다:

```tsx
const reorderM = useReorderWatchlist();
const sensors = useSensors(
  useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
);
const codes = useMemo(() => data?.entries.map((e) => e.code) ?? [], [data]);

<DndContext
  sensors={sensors}
  collisionDetection={closestCenter}
  onDragEnd={(e) => {
    const next = reorderCodes(codes, String(e.active.id), e.over ? String(e.over.id) : null);
    if (next) reorderM.mutate(next);
  }}
>
  <SortableContext items={codes} strategy={verticalListSortingStrategy}>
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {data?.entries.map((entry) => (
        <SortableQuoteRow key={entry.code} code={entry.code} /* ...기존 QuoteRow props */ />
      ))}
    </ul>
  </SortableContext>
</DndContext>
```

`SortableContext`의 `items`는 안정적인 `code` 문자열 배열(=`useSortable({ id: code })`와 일치). 시각 처리는 DESIGN.md 토큰만 사용(드래그 중 살짝 opacity/elevation, `cursor: grab`).

## Edge cases

| 상황 | 동작 |
|------|------|
| 항목 0~1개 | 정렬 대상 없음 → DnD no-op |
| 같은 슬롯 드롭(`active===over` 또는 `over` null) | `reorderCodes`가 `null` → mutation 미발생 |
| 드래그 중 종목 삭제 | optimistic은 보이는 항목만 재배치, 서버 `reorder_entries`가 사라진 코드 drop |
| 드래그 중 종목 추가 | 새 항목은 `onMutate`의 `rest`로 보존, 서버는 미언급 항목 append, `onSettled` invalidate가 정합 |
| 서버 실패 | `onError` 롤백 → 원위치 복귀 |
| 라이브 시세 오버레이 | code 기준 매핑이라 순서 변경과 무관 |

## Testing

- **백엔드** (`uv run --extra dev pytest`):
  - `reorder_entries` 단위 — ① 정상 재정렬 ② stale 코드 무시 ③ 미언급 항목 뒤에 append ④ 순서 불변 시 디스크 미기록 ⑤ atomic write 검증.
  - `PUT /api/watchlist/order` 라우트 — 200 + 새 순서 응답, `DELETE /{code}`와 라우트 충돌 없음, 6자리 위반 422.
- **프론트엔드** (`npx vitest run`):
  - `reorderCodes` 순수 함수 — arrayMove 정확성, 동일 슬롯 → `null`, 미존재 코드 → `null`.
  - `useReorderWatchlist` — optimistic setQueryData 적용 + `onError` 롤백.
  - `WatchlistDrawer` — `onDragEnd` 핸들러가 새 순서로 `mutate` 호출(dnd-kit 자체 드래그 시뮬은 fragile → 핸들러 로직 위주).
- **게이트**: `npx tsc -b` + 변경 파일 scoped eslint(0 에러). 레포 전체 `npm run lint`는 기존 부채로 실패하므로 게이트로 쓰지 않음.

## Open questions

없음.
