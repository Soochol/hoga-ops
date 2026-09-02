import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createPatternSave,
  deletePatternSave,
  listPatternSaves,
  type PatternSave,
  type PatternSaveWriteRequest,
} from '../api/screener';

export const PATTERN_SAVES_QUERY = ['pattern-saves'] as const;

/** 저장 목록. 다른 탭의 변경은 `pattern_saves_changed` 브로드캐스트가 무효화한다
 *  (스크리너 저장과 같은 결 — 채널만 다르다). */
export function usePatternSaves() {
  return useQuery({
    queryKey: PATTERN_SAVES_QUERY,
    queryFn: () => listPatternSaves(),
    staleTime: 30_000,
  });
}

export function useCreatePatternSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PatternSaveWriteRequest) => createPatternSave(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: PATTERN_SAVES_QUERY }),
  });
}

export function useDeletePatternSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deletePatternSave(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: PATTERN_SAVES_QUERY }),
  });
}

/**
 * 검색어 매칭 — **이름·종목명·코드를 함께** 훑는다.
 *
 * 이름만 보면 안 되는 이유가 실측에 있다: 저장이 쌓이면 사용자가 이름을 성의 있게
 * 짓지 않는다(저장뷰 125개에 `abcd`·`5/20` 이 섞여 있었다). 그때 남는 단서가 종목이다.
 */
export function matchesPatternSave(save: PatternSave, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [save.name, save.stock_name, save.code].some((v) =>
    String(v ?? '').toLowerCase().includes(q),
  );
}

/** 종목별 묶음 — 저장 순서(최신 우선)를 그룹 안에서 보존한다. */
export function groupPatternSaves(saves: readonly PatternSave[]): [string, PatternSave[]][] {
  const groups = new Map<string, PatternSave[]>();
  for (const s of saves) {
    const key = s.stock_name || s.code;
    const bucket = groups.get(key);
    if (bucket) bucket.push(s);
    else groups.set(key, [s]);
  }
  return [...groups.entries()];
}

/**
 * 저장 이름의 기본값 — **기준의 종류가 그대로 이름이 된다.**
 *
 * 저장을 거의 원클릭으로 만들고, 목록에서 두 종류가 이름만으로 구별되게 한다.
 * (그래도 고쳐 쓰는 사람이 있으므로 종류는 `window.kind` 로 따로 보존된다.)
 */
export function suggestPatternSaveName(args: {
  stockName: string;
  window: { kind: 'recent' | 'fixed'; bars?: number | null; from_date?: string | null; to_date?: string | null };
  withVolume: boolean;
}): string {
  const dot = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  const what =
    args.window.kind === 'fixed' && args.window.from_date && args.window.to_date
      ? `${dot(args.window.from_date)} ~ ${dot(args.window.to_date).slice(5)}`
      : `최근 ${args.window.bars ?? 7}봉`;
  return `${args.stockName} · ${what}${args.withVolume ? ' · 거래량' : ''}`;
}
