import { type ReactNode } from 'react';
import { SOURCE_OPTIONS } from '../../state/sourcePreference';
import {
  LIVE_VENUE_LABELS,
  LIVE_VENUE_OPTIONS,
  useLiveVenueStore,
  type LiveVenueOption,
} from '../../state/liveVenue';
import { useLiveSettings, usePatchLiveSettings, type LiveStoragePolicy } from '../../api/liveSettings';
import { useLiveStatus } from '../../api/liveStatus';
import { SettingsRow, ToggleSwitch } from './SettingsRow';
import SourcePreferenceRadio from './SourcePreferenceRadio';

const STORAGE_POLICY_LABEL: Record<LiveStoragePolicy, string> = {
  ws_only: 'WS만 저장',
  ws_plus_rest: 'WS 우선 + 나머지 REST 저장',
  rest_only: 'REST만 저장',
};

const STORAGE_POLICY_OPTIONS: LiveStoragePolicy[] = ['ws_only', 'ws_plus_rest', 'rest_only'];

function RoleSourceGroup({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="mb-1 text-sm font-medium text-fg">{title}</div>
      <div className="mb-2 text-xs text-fg-dimmer">{description}</div>
      {children}
    </section>
  );
}

/** 데이터소스 패널의 상위 구분 — '표시 소스'(읽기)와 '캡처 저장'(쓰기)를 나눈다.
 * RoleSourceGroup 제목(text-sm/medium/fg)보다 조용한 캡션 톤(dimmer/semibold)이라
 * 하위 그룹이 시각적으로 더 도드라진다. */
function MacroGroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-xs font-semibold tracking-wide text-fg-dimmer">{children}</div>
  );
}

/** 데이터 소스 설정 상세 — 표시 소스(읽기)와 캡처 저장(쓰기)를 나눠 배치.
 * 전역 설정(LiveSettings API + 전역 store)이라 메인 Settings의 「데이터 소스」
 * 섹션(variant='live')과 복기뷰 설정 모달(variant='study')이 공유한다. */
export function DataSourceDetail({ variant }: { variant: 'live' | 'study' }) {
  const { data } = useLiveSettings();
  const patch = usePatchLiveSettings();
  const kisRestBypassEnabled = data?.kis_rest_bypass_enabled ?? false;
  const storagePolicy = data?.storage_policy ?? 'ws_plus_rest';
  const restAllowed = data != null && storagePolicy !== 'ws_only';
  const programTradeEnabled = data?.program_trade_storage_enabled ?? false;
  const kiwoomEnabled = data?.kiwoom_enabled ?? false;

  return (
    <>
      {/* 표시 소스(읽기): 차트에 무엇이 그려지는가 — 캔들·거래소·호가체결·스크리너. */}
      <MacroGroupLabel>표시 소스</MacroGroupLabel>
      <div>
        {/* 캔들 소스는 'KIS API 우회' 토글이 단독 결정(4옵션 캔들 라디오 폐기).
            live는 우회 토글, study(복기뷰)는 디스크 온리 안내문을 이 그룹에 담아
            호가·체결 그룹과 대칭을 맞춘다. */}
        <RoleSourceGroup
          title="캔들 데이터 기준"
          description={
            variant === 'study'
              ? '복기뷰 전용 안내입니다.'
              : "기본은 KIS(분봉 REST+WS · 일/주/월봉 KIS 일봉)입니다. 'KIS API 우회'를 켜면 분봉은 캡처(hogaplay), 일·주·월봉은 스크리너 일봉으로 표시합니다 — 저장된 날짜만 나오고 없는 날짜는 비워지며, 오늘 실시간(WS)은 계속 표시됩니다."
          }
        >
          {variant === 'study' ? (
            <div className="text-sm text-fg-dim" data-testid="study-candle-source-note">
              복기뷰 캔들은 저장 데이터(캡처 분봉 + 스크리너 일봉)만 사용합니다.
            </div>
          ) : (
            <SettingsRow label="KIS API 우회" testId="kis-rest-bypass-row">
              <ToggleSwitch
                label="KIS API 우회"
                checked={kisRestBypassEnabled}
                onClick={() => patch.mutate({ kis_rest_bypass_enabled: !kisRestBypassEnabled })}
              />
            </SettingsRow>
          )}
        </RoleSourceGroup>
        {/* 복기뷰는 hogaplay 정규장 캡처(KRX)만 쓰므로 거래소 선택이 무의미 — 숨긴다
            (useStudyReferenceBundle도 'KRX' 하드코딩). */}
        {variant !== 'study' && (
          <RoleSourceGroup
            title="KIS 캔들 거래소"
            description="KIS 캔들·세션·실시간 스트림을 가져올 거래소입니다. 우회 ON 시 캔들엔 무효(저장 데이터는 KRX 정규장)."
          >
            {/* pb-2: 박스형 거래소 pill이 다음 그룹 구분선에 붙지 않도록 하단 여백. */}
            <div className="flex flex-wrap gap-2 pb-2">
              {LIVE_VENUE_OPTIONS.map((opt) => (
                <LiveVenueRadio key={opt} value={opt} />
              ))}
            </div>
          </RoleSourceGroup>
        )}
        <RoleSourceGroup
          title="호가·체결 데이터 기준"
          description="호가창, 체결, 거래원, 호가비, 체결강도 같은 보조 데이터에 적용됩니다. 캔들과 독립된 소스입니다."
        >
          {/* pb-2: 라디오가 다음 그룹 구분선에 붙지 않도록 하단 여백(거래소 그룹과 동일). */}
          <div className="flex flex-col gap-2 pb-2">
            {SOURCE_OPTIONS.map((opt) => (
              <SourcePreferenceRadio key={opt} value={opt} />
            ))}
          </div>
        </RoleSourceGroup>
        <RoleSourceGroup
          title="스크리너 일봉 데이터"
          description="스크리너 갱신으로 저장되는 KIS 일봉 parquet입니다. 조건검색과 섹터 랭킹의 기준 데이터로 사용됩니다."
        >
          <div className="text-sm text-fg-dim">
            갱신은 스크리너 화면의 데이터 갱신 버튼에서 실행합니다.
          </div>
        </RoleSourceGroup>
      </div>

      {/* 캡처 저장(쓰기): 라이브 수신 데이터를 디스크에 어떻게 저장하는가. 표시와 무관. */}
      <MacroGroupLabel>캡처 저장</MacroGroupLabel>
      <div>
        <RoleSourceGroup
          title="데이터 저장 방식"
          description="라이브 캡처 시 WS·REST 중 무엇을 디스크에 저장할지 정합니다. (차트 표시와 무관)"
        >
          {/* pb-2: 라디오가 다음 그룹 구분선에 붙지 않도록 하단 여백(거래소·호가체결 그룹과 동일). */}
          <div className="flex flex-col gap-2 pb-2">
            {STORAGE_POLICY_OPTIONS.map((opt) => (
              <StoragePolicyRadio key={opt} value={opt} />
            ))}
          </div>
        </RoleSourceGroup>
        <RoleSourceGroup
          title="프로그램 순매수 저장"
          description="캡처 활성 관심그룹 종목의 프로그램 순매수 시계열을 저장합니다."
        >
          <SettingsRow label="프로그램 순매수 저장" testId="program-trade-storage-row" disabled={!restAllowed}>
            <ToggleSwitch
              label="프로그램 순매수 저장"
              checked={programTradeEnabled && restAllowed}
              disabled={!restAllowed}
              onClick={() => patch.mutate({
                storage_policy: storagePolicy,
                program_trade_storage_enabled: !(programTradeEnabled && restAllowed),
              })}
            />
          </SettingsRow>
        </RoleSourceGroup>
        <RoleSourceGroup
          title="키움 WS 병행 수집"
          description="히트맵 종목을 KIS REST 대신 키움 WebSocket으로 실시간 수집합니다(앱키당 200종목). 끄면(기본) 기존 KIS REST 경로를 씁니다. .env에 KIWOOM_APP_KEY 필요."
        >
          <SettingsRow label="키움 WS 병행 수집" testId="kiwoom-enabled-row">
            <ToggleSwitch
              label="키움 WS 병행 수집"
              checked={kiwoomEnabled}
              onClick={() => patch.mutate({ kiwoom_enabled: !kiwoomEnabled })}
            />
          </SettingsRow>
          {kiwoomEnabled && <KiwoomStatusLine />}
        </RoleSourceGroup>
      </div>

      <div className="text-xs text-fg-dimmer">
        차트 상단 칩은 실제 렌더링에 사용된 source를 표시합니다.
      </div>
    </>
  );
}

/** 키움 세션 상태 한 줄 — 토글 ON일 때만. LiveStatus.kiwoom(관측)에서 조립.
 * 미배선(null)이면 '상태 확인 중', 킥 감지 시 경고 톤. */
function KiwoomStatusLine() {
  const { data } = useLiveStatus();
  const k = data?.kiwoom;
  if (k == null) {
    return (
      <div className="mt-1 text-xs text-fg-dimmer" data-testid="kiwoom-status-line">
        상태 확인 중…
      </div>
    );
  }
  const kicked = k.accounts.some((a) => a.kicked_by_peer);
  return (
    <div className="mt-1 text-xs text-fg-dim" data-testid="kiwoom-status-line">
      연결 {k.connected_accounts}/{k.accounts_configured}계정 · 수집 {k.subscribed_count}종목
      {kicked && (
        <span className="ml-1 text-warn" data-testid="kiwoom-kicked-warning">
          · 다른 프로세스가 앱키 점유 중
        </span>
      )}
    </div>
  );
}

function StoragePolicyRadio({ value }: { value: LiveStoragePolicy }) {
  const { data } = useLiveSettings();
  const patch = usePatchLiveSettings();
  const checked = (data?.storage_policy ?? 'ws_plus_rest') === value;
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', cursor: 'pointer' }}>
      <input
        type="radio"
        name="live-storage-policy"
        value={value}
        checked={checked}
        onChange={() => patch.mutate({
          storage_policy: value,
          program_trade_storage_enabled: value === 'ws_only'
            ? false
            : (data?.program_trade_storage_enabled ?? false),
        })}
      />
      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--fg)' }}>
        {STORAGE_POLICY_LABEL[value]}
      </span>
    </label>
  );
}

function LiveVenueRadio({ value }: { value: LiveVenueOption }) {
  const venue = useLiveVenueStore((s) => s.venue);
  const setVenue = useLiveVenueStore((s) => s.setVenue);
  const checked = venue === value;
  return (
    <label
      className="inline-flex items-center gap-2 rounded border px-3 py-1.5 text-sm cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-offset-2"
      style={{
        borderColor: checked ? 'var(--accent)' : 'var(--border)',
        background: checked ? 'var(--bg-input)' : 'transparent',
        color: checked ? 'var(--fg)' : 'var(--fg-dim)',
        outlineColor: 'var(--accent)',
      }}
    >
      <input
        type="radio"
        name="live-kis-venue"
        value={value}
        checked={checked}
        onChange={() => setVenue(value)}
        data-testid={`live-venue-${value}`}
      />
      <span>{LIVE_VENUE_LABELS[value]}</span>
    </label>
  );
}
