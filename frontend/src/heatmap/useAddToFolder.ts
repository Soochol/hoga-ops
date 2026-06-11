import { useAddToHeatmap, useMoveHeatmapEntries } from './useHeatmap';
import type { ApiError } from '../api/client';

// 주의: apiCall(client.ts)은 안정 코드를 ApiError.code 에 둔다 — err.message 는
// 사람용 문구('Code ... is already in the Heatmap.')라 code 문자열을 안 담는다.
// 따라서 message.includes 가 아니라 .code 로 판정해야 한다(검증으로 확인된 버그).
function isAlreadyInHeatmap(e: unknown): boolean {
  return (e as ApiError | null)?.code === 'already_in_heatmap';
}

/** 폴더 지정 추가 = addToHeatmap(미분류 진입) → moveHeatmapEntries(폴더로).
 *  이미 있으면(409) add는 무시하고 move만. add가 다른 에러면 전파(move 안 함).
 *  부분 실패(add 성공·move 실패) 시 종목은 미분류 그룹에 남아 보드에서 바로 보이고
 *  행 메뉴로 이동/제거해 복구 가능 — 유실 없음(ADR-0068: 미분류는 히트맵에 표시된다). */
export function useAddToFolder() {
  const addM = useAddToHeatmap();
  const moveM = useMoveHeatmapEntries();
  const addToFolder = async (code: string, folderId: string) => {
    try {
      await addM.mutateAsync(code);
    } catch (e) {
      if (!isAlreadyInHeatmap(e)) throw e;
    }
    await moveM.mutateAsync({ codes: [code], folderId });
  };
  return {
    addToFolder,
    isPending: addM.isPending || moveM.isPending,
    error: addM.error ?? moveM.error,
  };
}
