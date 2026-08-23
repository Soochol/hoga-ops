/**
 * 워크스페이스 스토리지 키 — **아무것도 import 하지 않는 leaf**.
 *
 * `workspace.ts`/`studyWorkspace.ts` 가 소유하던 상수를 떼어냈다(두 파일은 여기서
 * 다시 export 하므로 기존 소비자는 무변경). 지표 전역화 마이그레이션
 * (`indicatorsWindowMigration.ts`)이 두 워크스페이스 스냅샷을 읽어야 하는데, 그
 * 모듈은 `indicatorSettingsV2` 가 부르고 `workspace.ts` 는 다시
 * `indicatorSettingsV2` 를 부른다 — 키를 원래 자리에서 import 하면 순환이다.
 */
export const WORKSPACE_STORAGE_KEY = 'live.workspace.v1';
