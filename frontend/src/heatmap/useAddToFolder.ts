import { useAddToHeatmapFolder } from './useHeatmap';

/** 폴더 지정 추가 = 단일 backend command.
 *  서버 lock 안에서 "이 그룹에 없으면 추가, 이미 있으면 이름만 갱신(멱등)"을 처리해
 *  예전 add→move 2-call choreography의 부분 실패 surface를 없앤다.
 *  다른 그룹에 이미 등록된 종목이어도 **이동하지 않는다** — 그 그룹 등록은 그대로 두고
 *  이 그룹에도 등록된다(한 종목 다중 그룹). 옮기려면 드래그/⋯ 메뉴의 '그룹으로 이동'. */
export function useAddToFolder() {
  const addM = useAddToHeatmapFolder();
  const addToFolder = async (code: string, folderId: string) => {
    await addM.mutateAsync({ code, folderId });
  };
  return {
    addToFolder,
    isPending: addM.isPending,
    error: addM.error,
  };
}
