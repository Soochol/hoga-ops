import { useOptionSentiment } from '../api/optionSentiment';
import { PageContainer } from '../layout/PageContainer';
import {
  GexChart,
  GexSummary,
  IvSkewChart,
  OiContributors,
  OiDistributionChart,
  PutCallPanel,
} from '../sentiment/SentimentPanels';
import { PageState, PanelCard } from '../ui/PageShell';

/**
 * KOSPI200 옵션 심리 패널 (ADR-0135).
 *
 * 워크스페이스 창이 아니라 독립 라우트인 이유: 이 화면은 개별 종목이 아니라 시장
 * 전체 지표라 /live 의 링크그룹(종목 스코프) 개념과 맞지 않는다.
 *
 * **해석 오도 방지가 이 화면의 설계 요구사항이다.** 각 지표에 무엇을 말하지
 * *못하는지*를 함께 적는다 — P/C 는 헤지와 투기를 구분 못 하고, GEX 는 방향이
 * 아니라 변동성 체제이며 부호는 검증 불가한 가정에 의존하고, IV 절대값은
 * 자기 히스토리 없이는 정보량이 적다.
 */

function fmtTime(ms: number | null): string {
  if (ms === null) return '—';
  const d = new Date(ms);
  return d.toLocaleTimeString('ko-KR', { hour12: false });
}

const UNAVAILABLE_COPY: Record<string, { title: string; body: string }> = {
  kis_credentials_missing: {
    title: 'KIS 자격증명이 설정되지 않았습니다',
    body: '.env 에 KIS_APP_KEY / KIS_APP_SECRET 를 설정하면 수집이 시작됩니다.',
  },
  warming: {
    title: '체인을 수집하는 중입니다',
    body: '근월물 780종목을 처음 훑는 데 1분쯤 걸립니다. 잠시 후 자동으로 채워집니다.',
  },
  option_master_unavailable: {
    title: '옵션 종목 마스터를 받지 못했습니다',
    body: '잠시 후 다시 시도합니다.',
  },
  collector_failed: {
    title: '수집이 중단됐습니다',
    body: '새로고침하면 다시 시도합니다. 반복되면 서버 로그를 확인하세요.',
  },
};

/** 지표 카드 — 제목 + 한계 설명 + 본문. 한계 설명은 장식이 아니라 필수다. */
function Section({
  title,
  caveat,
  asOf,
  children,
}: {
  title: string;
  caveat: string;
  asOf: string;
  children: React.ReactNode;
}) {
  return (
    <PanelCard borderless className="p-md flex flex-col gap-sm">
      <div className="flex items-baseline justify-between gap-md">
        <h2 className="text-sm text-fg">{title}</h2>
        <span className="text-xs text-fg-dimmer tabular-nums">{asOf}</span>
      </div>
      <p className="text-xs text-fg-dim">{caveat}</p>
      {children}
    </PanelCard>
  );
}

export default function Sentiment() {
  const { data, isLoading, error } = useOptionSentiment();

  if (isLoading && !data) {
    return (
      <PageContainer>
        <PanelCard borderless className="p-md">
          <PageState>불러오는 중</PageState>
        </PanelCard>
      </PageContainer>
    );
  }

  if (error) {
    return (
      <PageContainer>
        <PanelCard borderless className="p-md">
          <PageState tone="error">
            심리 지표를 불러오지 못했습니다
            <div className="mt-xs text-xs">{String(error)}</div>
          </PageState>
        </PanelCard>
      </PageContainer>
    );
  }

  if (!data || data.unavailable) {
    const copy = UNAVAILABLE_COPY[data?.unavailable ?? ''] ?? {
      title: '표시할 데이터가 없습니다',
      body: '',
    };
    return (
      <PageContainer>
        <PanelCard borderless className="p-md">
          <PageState>
            {copy.title}
            {copy.body && <div className="mt-xs text-xs text-fg-dimmer">{copy.body}</div>}
          </PageState>
        </PanelCard>
      </PageContainer>
    );
  }

  const fullAt = fmtTime(data.full_as_of_ms);
  const atmAt = fmtTime(data.atm_as_of_ms);

  return (
    <PageContainer className="overflow-auto">
      <div className="flex flex-col gap-md">
        <PanelCard borderless className="p-md">
          <div className="flex flex-wrap items-baseline gap-lg">
            <div>
              <div className="text-xs text-fg-dim">KOSPI200</div>
              <div className="text-2xl tabular-nums text-fg">
                {data.underlying?.toFixed(2) ?? '—'}
              </div>
            </div>
            <div>
              <div className="text-xs text-fg-dim">근월물</div>
              <div className="text-lg tabular-nums text-fg">{data.expiry ?? '—'}</div>
            </div>
            <div>
              <div className="text-xs text-fg-dim">ATM IV</div>
              <div className="text-lg tabular-nums text-fg">
                {data.iv_skew?.atm_iv?.toFixed(2) ?? '—'}%
              </div>
            </div>
            <div>
              <div className="text-xs text-fg-dim">25델타 리스크리버설</div>
              <div className="text-lg tabular-nums text-fg">
                {data.iv_skew?.risk_reversal_25d?.toFixed(2) ?? '—'}
              </div>
            </div>
            <div className="ml-auto text-xs text-fg-dimmer">
              전수 {fullAt} · ATM {atmAt}
            </div>
          </div>
        </PanelCard>

        {data.put_call && (
          <Section
            title="Put/Call 비율"
            caveat="풋 매수가 하락 베팅인지 보유 포지션 헤지인지 구분하지 못합니다. 거래량은 당일 흐름, 미결제는 누적 포지션을 뜻합니다."
            asOf={`전수 ${fullAt}`}
          >
            <PutCallPanel pc={data.put_call} />
          </Section>
        )}

        {data.oi_distribution && (
          <Section
            title="행사가별 미결제약정 · Max Pain"
            caveat="위 빨강이 콜, 아래 파랑이 풋입니다. Max Pain 은 만기 시 옵션 매도자 손실이 최소가 되는 지점일 뿐 가격 예측이 아닙니다."
            asOf={`전수 ${fullAt}`}
          >
            <OiDistributionChart dist={data.oi_distribution} underlying={data.underlying} />
            <div className="mt-sm">
              <div className="mb-xs text-xs text-fg-dim">
                미결제 상위 행사가 — Max Pain 과 감마 플립이 무엇에 끌려간 값인지 보여줍니다.
                KOSPI200 은 델타가 0에 가까운 극외가에 미결제가 몰리는 특성이 있습니다.
              </div>
              <OiContributors dist={data.oi_distribution} underlying={data.underlying} />
            </div>
          </Section>
        )}

        {data.gamma_exposure && (
          <Section
            title="감마 익스포저 (GEX)"
            caveat="방향 지표가 아니라 변동성 체제 지표입니다. 양수는 움직임 억제, 음수는 증폭으로 읽습니다. 부호는 '딜러가 콜을 팔고 풋을 산다'는 관례적 가정에서 나오며 검증할 수 없습니다."
            asOf={`전수 ${fullAt}`}
          >
            <GexSummary gex={data.gamma_exposure} />
            <GexChart gex={data.gamma_exposure} underlying={data.underlying} />
          </Section>
        )}

        {data.iv_skew && (
          <Section
            title="내재변동성 스마일"
            caveat="IV 절대값은 그 자체로 정보량이 적습니다 — 주식 옵션은 구조적으로 항상 풋이 비쌉니다. 자기 히스토리 대비로 읽어야 의미가 생깁니다. ATM IV 와 리스크리버설만 30초 주기로 갱신됩니다."
            asOf={`곡선 ${fullAt} · ATM ${atmAt}`}
          >
            <IvSkewChart skew={data.iv_skew} underlying={data.underlying} />
          </Section>
        )}

        <p className="text-xs text-fg-dimmer">
          시장 상태를 관측하기 위한 지표입니다. 투자 판단 도구가 아닙니다.
        </p>
      </div>
    </PageContainer>
  );
}
