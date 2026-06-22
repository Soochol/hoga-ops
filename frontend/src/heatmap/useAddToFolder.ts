import { useAddToHeatmapFolder } from './useHeatmap';

/** 폴더 지정 추가 = 단일 backend command.
 *  서버 lock 안에서 "없으면 추가 + 해당 폴더 배치, 있으면 해당 폴더로 이동"을 처리해
 *  예전 add→move 2-call choreography의 부분 실패 surface를 없앤다. */
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
