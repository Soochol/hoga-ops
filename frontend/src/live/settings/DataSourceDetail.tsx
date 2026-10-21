import { useState, type ReactNode } from 'react';
import {
  LIVE_VENUE_HELP,
  LIVE_VENUE_LABELS,
  LIVE_VENUE_OPTIONS,
  useLiveVenueStore,
  type LiveVenueOption,
} from '../../state/liveVenue';
import { useLiveSettings, usePatchLiveSettings, LIVE_SETTINGS_KEY, type LiveSettings, type LiveSettingsPatch } from '../../api/liveSettings';
import { useQueryClient } from '@tanstack/react-query';
import { useRecordSettingsUndo } from './settingsUndoContext';
import { SettingsRow, ToggleSwitch } from './SettingsRow';

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
      <div className="mb-2 text-xs text-fg-dim">{description}</div>
      {children}
    </section>
  );
}

/** 데이터소스 패널의 상위 구분.
 * RoleSourceGroup 제목(text-sm/medium/fg)보다 조용한 캡션 톤(dimmer/semibold)이라
 * 하위 그룹이 시각적으로 더 도드라진다. */
function MacroGroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-xs font-semibold text-fg-dim">{children}</div>
  );
}

/** 「이 컨트롤이 어디에 적용되는가」를 적는 동반 문구.
 *
 * 옛 `variant` 분기가 컨트롤을 통째로 숨기던 자리다. 숨기면 같은 값에 대해 화면마다
 * 다른 이야기가 나오므로, 컨트롤은 그대로 두고 범위만 말한다. 아래 hogaplay 힌트와
 * 같은 톤이라 "지금 적용되지 않는다" 계열 문구가 한 벌로 읽힌다. */
function ScopeNote({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div className="mt-1 text-xs text-fg-dim" data-testid={testId}>
      {children}
    </div>
  );
}

/** 데이터 소스 설정 상세 — 캔들·거래소·호가체결의 표시 기준.
 *
 * **컨텍스트 인자가 없다**(옛 `variant: 'live' | 'study'` 삭제). 값이 전부 전역
 * (LiveSettings API + 전역 store)인데 화면마다 컨트롤을 숨기고 있어서, 같은 탭에서도
 * 어느 문으로 들어오느냐에 따라 다른 이야기가 나왔다 — `pages/Settings` 가
 * `variant="live"` 를 하드코딩한 탓에 `/study` 에서 TopNav ⚙ 는 REST 우회 토글을,
 * 툴바 ⚙ 는 "디스크 온리" 안내문을 보여줬다.
 *
 * 그래서 **숨기지 않고 적용 범위를 적는다** — 이 파일이 hogaplay 토글에서 이미 쓰던
 * 방식이다(아래 「비활성화하지 않는다」 주석). 복기뷰 안내는 사라지지 않고 컨트롤
 * 아래 상시 동반 문구(`ScopeNote`)가 된다.
 *
 * ⚠ ADR-0144(복기뷰 KRX 고정)는 **유효하다**. 그 격리는 이 화면이 아니라
 * `studyVenuePolicy.ts` 의 `STUDY_VENUE` 상수와 그 테스트가 건다 — 여기서 거래소를
 * 골라도 복기뷰는 KRX 그대로다. 대체된 것은 "복기뷰 설정 화면에 라디오를 두지
 * 않는다" 는 표면 규칙 하나뿐이고, 그 근거였던 "아무 일도 안 하는 컨트롤" 은 앱 전역
 * 설정에서는 성립하지 않는다 — 이 라디오는 `/live`·`/heatmap`·`/screener`·관심종목에
 * 실제로 작동한다. */
export function DataSourceDetail() {
  const { data, isError } = useLiveSettings();
  const patch = usePatchLiveSettings();
  const queryClient = useQueryClient();
  const recordUndo = useRecordSettingsUndo();
  const [saveError, setSaveError] = useState<string | null>(null);
  function change(key: keyof LiveSettingsPatch, value: boolean) {
    const previous = queryClient.getQueryData<LiveSettings>(LIVE_SETTINGS_KEY)?.[key];
    setSaveError(null);
    void patch.mutateAsync({ [key]: value }).then(settings => {
      if (previous == null || previous === settings[key]) return;
      recordUndo({
        isCurrent: () => queryClient.getQueryData<LiveSettings>(LIVE_SETTINGS_KEY)?.[key] === settings[key],
        undo: () => patch.mutateAsync({ [key]: previous }),
      });
    }).catch(error => setSaveError(error instanceof Error ? error.message : '설정을 저장하지 못했습니다'));
  }
  const restBypassEnabled = data?.rest_bypass_enabled ?? false;
  const krxPreferHogaplay = data?.krx_prefer_hogaplay ?? false;
  const venue = useLiveVenueStore((s) => s.venue);

  return (
    <>
      {saveError && <p role="alert" className="text-xs text-error">{saveError}</p>}
      {/* GET 실패는 이 패널의 **모든** 토글에 걸리는 사실이라 상단에 한 번만 알린다.
          PATCH 는 partial 이라 현재값을 몰라도 조작 자체는 안전하므로 토글을 잠그지
          않는다 — 아래 hogaplay 힌트와 같은 규율("회색은 고장으로 읽힌다"). */}
      {isError && (
        <p className="text-xs text-error">라이브 설정을 불러오지 못했습니다. 백엔드 연결을 확인하세요</p>
      )}
      {/* 표시 소스(읽기): 캔들·거래소·호가체결의 표시 기준. */}
      <MacroGroupLabel>표시 소스</MacroGroupLabel>
      <div>
        {/* 캔들 소스는 'REST 우회' 토글이 단독 결정(4옵션 캔들 라디오 폐기). */}
        <RoleSourceGroup
          title="캔들 데이터 기준"
          description="기본은 시세 서버입니다. 켜면 저장된 분봉·스크리너 일봉을 사용하며, 저장되지 않은 날짜는 비워둡니다. 오늘 실시간 시세는 계속 표시합니다."
        >
          <SettingsRow label="저장 데이터로 캔들 보기" testId="kis-rest-bypass-row">
            <ToggleSwitch
              label="저장 데이터로 캔들 보기"
              checked={restBypassEnabled}
              disabled={patch.isPending}
              onClick={() => change('rest_bypass_enabled', !restBypassEnabled)}
            />
          </SettingsRow>
          <ScopeNote testId="study-candle-source-note">
            복기뷰는 항상 저장된 분봉·스크리너 일봉을 사용합니다.
          </ScopeNote>
        </RoleSourceGroup>
        {/* 거래소 라디오는 `/live` 전용 컨트롤이 **아니다** — `/heatmap`·`/screener`·
            관심종목이 전부 같은 스토어를 읽는다. ADR-0144 가 복기뷰 설정 화면에서
            이걸 뺐던 근거("복기가 값을 무시하니 아무 일도 안 하는 컨트롤")는 앱 전역
            설정에서는 성립하지 않으므로, 숨기는 대신 범위를 적는다(헤더 주석). */}
        <RoleSourceGroup title="거래소" description={LIVE_VENUE_HELP}>
          {/* pb-2: 박스형 거래소 pill이 다음 그룹 구분선에 붙지 않도록 하단 여백. */}
          <div className="flex flex-wrap gap-2 pb-2">
            {LIVE_VENUE_OPTIONS.map((opt) => (
              <LiveVenueRadio key={opt} value={opt} />
            ))}
          </div>
          {/* 「복기뷰는 예외로 항상 KRX」 자체는 `LIVE_VENUE_HELP` 가 이미 말한다 —
              여기서 반복하지 않고 **이유**만 잇는다(실물 확인에서 잡은 중복). 이유가
              없으면 고정이 임의 제약으로 읽힌다. */}
          <ScopeNote testId="study-venue-fixed-note">
            hogaplay 캡처가 KRX 전용이므로 복기뷰는 KRX로 고정됩니다.
          </ScopeNote>
        </RoleSourceGroup>
        {/* 「호가·체결 데이터 기준」 라디오 3종은 폐지됐다(2026-08-07 오전) — 셋 중 둘이
            venue 비교를 깨뜨렸다. 같은 날 오후에 **옵트인 토글 하나로** 돌아왔다:
            폐지 근거였던 "hogaplay 는 죽어가는 폴백"을 ADR-0142 가 뒤집었기 때문이다
            (271종목/일 복원). 라디오가 아니라 토글인 이유 = 기본은 여전히 비교
            가능성이고, 해상도는 사용자가 명시적으로 고르는 것이다. */}
        <RoleSourceGroup
          title="호가·체결 데이터 기준"
          description="KRX 호가·체결에 더 촘촘한 hogaplay 저장 데이터를 우선 사용합니다. NXT·통합과 데이터 기준이 달라 지표를 직접 비교하기 어렵습니다."
        >
          <SettingsRow label="KRX에서 hogaplay 우선" testId="krx-prefer-hogaplay-row">
            <ToggleSwitch
              label="KRX에서 hogaplay 우선"
              checked={krxPreferHogaplay}
              disabled={patch.isPending}
              onClick={() => change('krx_prefer_hogaplay', !krxPreferHogaplay)}
            />
          </SettingsRow>
          {/* 비활성화하지 **않는다** — 설정은 지속되는 값이고 거래소는 자주 바뀌므로,
              NXT 를 볼 때마다 회색이면 고장으로 읽힌다. 대신 지금 적용되지 않는다는
              사실만 알린다.

              옛 `variant === 'live'` 게이트는 사라졌다. 게이트가 있던 이유는 스토어
              venue 가 실시간 화면의 선택이라 복기뷰(항상 KRX)에서는 이 안내가 거짓말이
              된다는 것이었다 — 그래서 게이트 대신 **어느 화면 이야기인지 문장에
              적는다**. 이제 어느 라우트에서 열어도 참이다. */}
          {krxPreferHogaplay && venue !== 'KRX' && (
            <div className="mt-1 text-xs text-fg-dim" data-testid="krx-prefer-hogaplay-inactive">
              현재 실시간 거래소({LIVE_VENUE_LABELS[venue]})에는 적용되지 않습니다. KRX 전용이며, 복기뷰에는 항상 적용됩니다.
            </div>
          )}
        </RoleSourceGroup>
      </div>
    </>
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
        className="focus-visible:outline-none"
        value={value}
        checked={checked}
        onChange={() => setVenue(value)}
        data-testid={`live-venue-${value}`}
      />
      <span>{LIVE_VENUE_LABELS[value]}</span>
    </label>
  );
}
