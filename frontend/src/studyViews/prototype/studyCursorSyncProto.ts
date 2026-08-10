/**
 * PROTOTYPE — 던져버릴 코드다. 승자를 고른 뒤 실코드로 옮기고 이 디렉터리는
 * throwaway 브랜치로 보낸다. 테스트·에러 처리 없음이 의도다.
 *
 * 계획: `/study` 라우트에 `?syncproto=A|B|C` 로 3변형 — 분봉 창의 마우스 위치를
 * 일봉(D) 창에 동기 표시. 답할 질문은 **"일봉 쪽에서 그 위치가 어떻게 보여야
 * 하는가"** 이지 "동기화가 가능한가" 가 아니다(가능한 건 이미 확인).
 *
 * ── 왜 스토어를 새로 만드는가 ─────────────────────────────────────────────
 * 기존 `useLiveCursorStore` 는 채널이 둘인데 **둘 다 그대로는 못 쓴다**:
 *   - `cursorMs`        : 즉시 발행이지만 **origin 이 없다** → 일봉 창이 자기
 *                         호버까지 되받아 자기 크로스헤어와 이중으로 그린다.
 *   - `sidebarCursorMs` : origin 은 있지만 throttle + 버킷 정렬이라 **시각
 *                         동기화엔 늦다**(데이터 조회용 채널이다).
 * 그래서 `{tsMs, origin}` 을 즉시 싣는 프로토타입 전용 버스를 따로 둔다.
 * 실코드로 갈 때는 `cursorMs` 에 origin 을 붙이는 편이 맞을 가능성이 높지만,
 * 그건 이 프로토타입이 답할 질문이 아니다.
 */
import { create } from 'zustand';
import type { LiveTimeframe } from '../../state/livePage';

export const PROTO_PARAM = 'syncproto';

export type ProtoVariant = 'A' | 'B' | 'C' | 'D' | 'E';

export const PROTO_VARIANTS: readonly ProtoVariant[] = ['A', 'B', 'C', 'D', 'E'] as const;

// 변형 축 = **무엇에 매이는가**. 1차 실측에서 캔들 폭(0.85~8.3px)에 매인 표현들이
// 서로 구분되지 않아 다시 세웠다 — 자세한 건 오버레이 파일 상단 주석.
export const PROTO_VARIANT_NAMES: Record<ProtoVariant, string> = {
  A: '헤어라인 + 시각 칩',
  B: '캔들 브래킷(최소 폭 보장)',
  C: '하단 일중 스트립',
  // D 는 아무것도 그리지 않는다 — lwc 가 두 차트 크로스헤어 동기화용으로 제공하는
  // `setCrosshairPosition` 을 부를 뿐이다. A~C 가 손으로 그린 것을 라이브러리에
  // 맡기는 판. **변형 키 D 는 타임프레임 D(일봉)와 무관하다.**
  D: 'lwc 네이티브 크로스헤어',
  // E 는 D 에 **시각 칩 하나만** 얹는다. lwc 가 시간축에 찍는 배지는 일봉 축이라
  // 날짜뿐이고, 분봉 커서의 시:분은 그 축에 표현될 자리가 없기 때문이다.
  E: '네이티브 크로스헤어 + 시각 칩',
};

export function parseProtoVariant(raw: string | null | undefined): ProtoVariant | null {
  const key = (raw ?? '').toUpperCase();
  return (PROTO_VARIANTS as readonly string[]).includes(key) ? (key as ProtoVariant) : null;
}

/** 발행 차트 창의 신원 — 소비 측 세 필터(자기 창 제외·분봉만·같은 종목)의 근거. */
export type ProtoCursor = {
  /** 커서가 가리키는 **실제** Unix-ms. 날짜가 아니라 ms 여야 변형 C 가 가능하다. */
  tsMs: number;
  windowId: string | null;
  code: string | null;
  timeframe: LiveTimeframe;
};

type ProtoStore = {
  cursor: ProtoCursor | null;
  /** 활성 변형. null = 프로토타입 꺼짐(평소 `/study` 와 완전히 동일하게 동작). */
  variant: ProtoVariant | null;
  setVariant: (variant: ProtoVariant | null) => void;
  publish: (cursor: ProtoCursor) => void;
  /** 발행자만 자기 것을 지운다 — 옆 창의 mouse-leave 가 내 표시를 끄면 안 된다. */
  clearFrom: (windowId: string | null) => void;
};

export const useStudyCursorSyncProtoStore = create<ProtoStore>((set, get) => ({
  cursor: null,
  variant: readProtoVariant(),
  setVariant: (variant) => {
    if (get().variant === variant) return;
    set({ variant });
  },
  publish: (cursor) => {
    const cur = get().cursor;
    if (
      cur
      && cur.tsMs === cursor.tsMs
      && cur.windowId === cursor.windowId
      && cur.code === cursor.code
      && cur.timeframe === cursor.timeframe
    ) return;
    set({ cursor });
  },
  clearFrom: (windowId) => {
    const cur = get().cursor;
    if (!cur) return;
    if (cur.windowId !== windowId) return;
    set({ cursor: null });
  },
}));

// PROTOTYPE 디버그 훅 — `/browse` 로 발행/필터 어느 쪽이 막혔는지 보려면 스토어를
// 밖에서 읽을 수 있어야 한다. DEV 에서만.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__protoCursor = useStudyCursorSyncProtoStore;
}

/**
 * 활성 변형 — URL 이 진실이다. 오버레이는 `LiveChartRoot` 깊숙이 마운트되는데
 * 거기까지 prop 으로 내리면 프로토타입 배선이 실코드에 번진다. 던져버릴 코드가
 * 실코드 시그니처를 오염시키지 않게 URL 을 직접 읽는다.
 */
export function readProtoVariant(): ProtoVariant | null {
  if (typeof window === 'undefined') return null;
  return parseProtoVariant(new URLSearchParams(window.location.search).get(PROTO_PARAM));
}
