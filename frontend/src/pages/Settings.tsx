import { PageContainer } from '../layout/PageContainer';
import SettingsSections from '../live/SettingsSections';

/**
 * `/settings` 라우트의 페이지 프레임.
 *
 * 설정 본체는 이제 `SettingsSections` 하나뿐이다 — 이 파일이 들고 있던 마스터-디테일
 * 셸(nav 176px)과 섹션 본체(테마·Symbol Master·앱 정보·로드맵)는 각각 그 컴포넌트와
 * `live/settings/AppInfoSections` 로 옮겨졌고, 「데이터 수집」의 토글 하나는
 * `DataSourceDetail` 의 「캡처 저장」 그룹으로 흡수됐다. 여기 남은 것은 모달 밖에서만
 * 필요한 카드 프레임뿐이다.
 *
 * ⚠ **라우트를 지우지 말 것.** `LiveStateBanner` 가 실시간 불가 상황의 복구 동선으로
 * `/settings` 를 링크한다(`actionTo`). `nav/items.ts` 의 SYSTEM_NAV_ITEMS 도 이 경로를
 * 갖지만, TopNav 는 그 항목만 링크 대신 드로어 트리거로 바꿔 렌더한다.
 */
export default function Settings() {
  return (
    <PageContainer className="grid grid-cols-[minmax(0,52rem)] content-start">
      <div className="h-[min(40rem,72vh)] overflow-hidden rounded-lg border border-border shadow-panel">
        <SettingsSections />
      </div>
    </PageContainer>
  );
}
