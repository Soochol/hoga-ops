import { useState } from 'react';

import { useOptionSentiment } from '../api/optionSentiment';
import { PAGE_MAX_W, PageContainer } from '../layout/PageContainer';
import { useNowMs } from '../util/useNowMs';
// 카드 크롬은 `/market` 이 SSOT 다(marketCardBits 상단 주석 — "한 곳에서만 정한다").
// `src/ui/` 로 승격하지 않고 그대로 읽어 쓴다: 승격은 MarketCard 리네임으로
// MarketPage·BreadthCard 를 쓸어 병행 세션 충돌면만 키우고, 화면에 주는 이득은 0이다.
import { CARD_HEADER_RULE, MarketCard } from '../market/marketCardBits';
import {
  PutCallPanel,
  PutCallSeriesChart,
} from '../sentiment/SentimentPanels';
import { fmtCompact } from '../sentiment/sentimentFormat';
import { atmDomain, fullDomain, type StrikeDomain } from '../sentiment/strikeScale';
import { PageState } from '../ui/PageShell';
import { StrikeWorkspace } from '../sentiment/StrikeWorkspace';
import '../sentiment/sentiment.css';

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
 *
 * **구조 중심 배치(2026-10-19 사용자 승인)**: 기초자산·관측 시각 → 네 요약 →
 * 같은 폭·도메인의 OI/GEX/IV 스택. 우측은 축 정렬 의무가 없는 P/C와 전 행사가 기여 표다.
 * 수집·계산은 그대로 두고 선택 행사가만 공유한다.
 */

function fmtTime(ms: number | null): string {
  if (ms === null) return '—';
  const d = new Date(ms);
  return d.toLocaleTimeString('ko-KR', { hour12: false });
}

/**
 * 계층 관측 시각 — "N분 전" 상대 표기 + stale 경고.
 *
 * 절대 시각("14시 23분 9초")은 지금과의 거리를 암산시키는 소음이라 상대로 줄이고,
 * 정확한 시각은 title(호버)로 남긴다. **staleMs 를 넘게 낡으면 --warn 색** —
 * 수집 루프가 죽으면 화면은 조용히 낡은 값을 계속 보여주는 구조라, 낡음 자체가
 * 유일한 경고 채널이다.
 *
 * **나이는 폴링이 아니라 자체 시계로 잰다**(`useNowMs`). 예전엔 렌더 중 `Date.now()`
 * 를 읽고 "30초 폴링이 재렌더를 만드니 타이머는 불필요" 라고 적어 뒀는데, 그러면
 * 이 경고가 잡아야 할 바로 그 상황에서 죽는다 — 폴링이 멈추면 재렌더도 멈추고,
 * "2분 전" 이 화면에 얼어붙은 채 영원히 지연 경고로 넘어가지 않는다. 시계를 갱신
 * 원인에서 떼어 내야 낡음이 실제로 자란다(덤으로 `react-hooks/purity` 도 풀린다).
 */
function AsOf({ label, ms, staleMs }: { label: string; ms: number | null; staleMs: number }) {
  // 훅은 조기 return 앞에 — 아래 `ms === null` 가드보다 뒤로 가면 훅 순서가 깨진다.
  // 주기는 표기 단위(분)보다 촘촘하면 되므로 30초면 충분하다.
  const nowMs = useNowMs(30_000);
  if (ms === null) return <span>{label} —</span>;
  const age = Math.max(0, nowMs - ms);
  const text =
    age < 45_000 ? '방금' : age < 5_400_000 ? `${Math.round(age / 60_000)}분 전` : `${Math.round(age / 3_600_000)}시간 전`;
  const stale = age > staleMs;
  return (
    <span data-tooltip={fmtTime(ms)} style={stale ? { color: 'var(--warn)' } : undefined}>
      {label} {text}
      {stale && ' · 지연'}
    </span>
  );
}

/** 갱신 주기의 2배 + 여유 — 이보다 낡으면 수집이 멈춘 것으로 본다. */
const FULL_STALE_MS = 12 * 60_000; // 전수 주기 5분
const ATM_STALE_MS = 2 * 60_000; // ATM 주기 30초

/**
 * 휴면·대기 사유별 안내. `body` 가 함수인 이유는 대기 문구가 **체인 종목 수에
 * 따라 달라져야** 하기 때문이다 — 근월물 종목 수는 만기마다 다르고(실측
 * 202608=780 · 202609=1012 · 202610=682) 상수로 박으면 롤오버 때 조용히 틀린다.
 * 소요 시간도 종목 수에 비례하므로 단정하지 않고 범위로 적는다(유량 경합도 흡수).
 */
const UNAVAILABLE_COPY: Record<
  string,
  { title: string; body: (chainSize: number | null) => string }
> = {
  credentials_missing: {
    title: 'KIS 자격증명이 설정되지 않았습니다',
    body: () => '.env 에 KIS_APP_KEY / KIS_APP_SECRET 를 설정하면 수집이 시작됩니다',
  },
  warming: {
    title: '체인을 수집하는 중입니다',
    body: (n) =>
      n === null
        ? '근월물 체인을 처음 훑는 중입니다. 보통 1~2분 걸리며 자동으로 채워집니다.'
        : `근월물 ${n.toLocaleString()}종목을 처음 훑는 중입니다. 보통 1~2분 걸리며 자동으로 채워집니다.`,
  },
  option_master_unavailable: {
    title: '옵션 종목 마스터를 받지 못했습니다',
    body: () => '잠시 후 다시 시도합니다.',
  },
  collector_failed: {
    title: '수집이 중단됐습니다',
    body: () => '새로고침하면 다시 시도합니다. 반복되면 서버 로그를 확인하세요',
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
  asOf?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <MarketCard className="flex flex-col gap-sm p-md">
      <div
        className={`flex flex-wrap items-baseline justify-between gap-x-sm gap-y-2xs ${CARD_HEADER_RULE}`}
      >
        <h2 className="text-sm text-fg">{title}</h2>
        {asOf && <span className="font-data text-2xs text-fg-dim tabular-nums">{asOf}</span>}
      </div>
      {children}
      {/* 한계 설명은 설계 요구사항이라 없애면 안 되지만(테스트 고정), 데이터보다
          앞세우면 카드 전부에서 반복 노이즈가 된다 — 하단 각주로 내린다. 크기는
          `xs` 를 유지한다: `2xs` 는 DESIGN.md 상 "dense chrome micro-labels" 용이고
          이건 필수 본문 문장이다. 밀도는 레이아웃으로 벌지, 문장을 줄여서 벌지 않는다. */}
      <p className="text-xs text-fg-dim">{caveat}</p>
    </MarketCard>
  );
}

/**
 * 헤더 KPI 타일 — `/market` 지수 카드와 같은 골격(라벨 밑줄 → 값 → 보조 한 줄).
 *
 * **값에 등락색을 쓰지 않는다.** 이 페이지의 빨강/파랑은 콜/풋 인코딩이라(차트 3종
 * 전부) KPI 에 가격방향색을 섞으면 "총 GEX 가 음수라 파랑" 이 "풋" 으로 읽힌다.
 */
function StatTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <MarketCard className="flex flex-col gap-sm p-md">
      <div className={`flex items-baseline justify-between gap-x-sm ${CARD_HEADER_RULE}`}>
        <span className="text-xs font-semibold text-fg-dim">{label}</span>
      </div>
      <div className="flex flex-col">
        <span className="whitespace-nowrap font-data text-xl font-semibold tabular-nums text-fg">
          {value}
        </span>
        <span className="font-data text-2xs text-fg-dim tabular-nums">{sub ?? ' '}</span>
      </div>
    </MarketCard>
  );
}

/** 로딩·에러·휴면 3상태의 공통 껍데기 — 본문과 같은 카드 크롬을 쓴다. */
function StateCard({ children }: { children: React.ReactNode }) {
  return (
    <PageContainer className="sentiment-page">
      <div className={`mx-auto w-full ${PAGE_MAX_W}`}>
        <MarketCard className="p-md">{children}</MarketCard>
      </div>
    </PageContainer>
  );
}

export default function Sentiment() {
  const { data, isLoading, error } = useOptionSentiment();
  // 행사가 축 범위. 기본은 ATM 근처 — 실측상 극외가 로또 물량이 전체 축을 지배해
  // 중앙 구조를 좁은 띠로 압축한다(극외가는 기여 표가 커버). 세 차트가 이 도메인을
  // 공유해야 축이 정렬된다.
  const [strikeRange, setStrikeRange] = useState<'atm' | 'all'>('atm');

  if (isLoading && !data) {
    return (
      <StateCard>
        <PageState>불러오는 중</PageState>
      </StateCard>
    );
  }

  if (error) {
    return (
      <StateCard>
        <PageState tone="error">
          심리 지표를 불러오지 못했습니다
          <div className="mt-xs text-xs">{String(error)}</div>
        </PageState>
      </StateCard>
    );
  }

  if (!data || data.unavailable) {
    const copy = UNAVAILABLE_COPY[data?.unavailable ?? ''] ?? {
      title: '표시할 데이터가 없습니다',
      body: () => '',
    };
    const body = copy.body(data?.chain_size ?? null);
    return (
      <StateCard>
        <PageState>
          {copy.title}
          {body && <div className="mt-xs text-xs text-fg-dim">{body}</div>}
        </PageState>
      </StateCard>
    );
  }

  const allStrikes = data.oi_distribution?.strikes.map((s) => s.strike) ?? [];
  const domain: StrikeDomain | null =
    strikeRange === 'atm' ? atmDomain(allStrikes, data.underlying) : fullDomain(allStrikes);
  const maxPain = data.oi_distribution?.max_pain ?? null;
  const painGap = maxPain !== null && data.underlying !== null ? maxPain - data.underlying : null;

  const fullStamp = <AsOf label="전수" ms={data.full_as_of_ms} staleMs={FULL_STALE_MS} />;
  const atmStamp = <AsOf label="ATM" ms={data.atm_as_of_ms} staleMs={ATM_STALE_MS} />;
  return (
    <PageContainer className="sentiment-page">
      <div className={`sentiment-desk mx-auto flex h-full min-h-0 w-full ${PAGE_MAX_W} flex-col gap-md overflow-y-auto`}>
        <div className="sentiment-context flex flex-wrap items-baseline justify-between gap-md px-xs">
          <div className="flex flex-wrap items-baseline gap-md">
            <span className="text-sm font-semibold text-fg-dim">KOSPI200</span>
            <strong className="font-data text-xl font-semibold text-fg tabular-nums">{data.underlying?.toFixed(2) ?? '—'}</strong>
            <span className="text-xs text-fg-dim">정규 옵션 · 근월물 {data.expiry ?? '—'}</span>
          </div>
          <div className="flex flex-wrap gap-x-lg gap-y-xs font-data text-xs text-fg-dim tabular-nums">
            <span>{fullStamp} · 5분 주기</span><span>{atmStamp} · 30초 주기</span>
          </div>
        </div>
        <div className="sentiment-overview grid gap-md">
          <StatTile label="거래량 P/C" value={data.put_call?.volume_ratio?.toFixed(3) ?? '—'} sub={`미결제 P/C ${data.put_call?.oi_ratio?.toFixed(3) ?? '—'}`} />
          <StatTile label="총 GEX" value={data.gamma_exposure ? `${fmtCompact(data.gamma_exposure.total)}원` : '—'} sub={<>1% 이동당 · 감마 플립 {data.gamma_exposure?.flip_strike ?? '—'}</>} />
          <StatTile label="ATM IV" value={data.iv_skew?.atm_iv == null ? '—' : `${data.iv_skew.atm_iv.toFixed(2)}%`} sub={<>25델타 RR {data.iv_skew?.risk_reversal_25d?.toFixed(2) ?? '—'} · <span>+면 하방 보험이 비쌈</span></>} />
          <StatTile label="Max Pain" value={maxPain ?? '—'} sub={painGap === null ? undefined : `현재가 대비 (${painGap >= 0 ? '+' : ''}${painGap.toFixed(1)})`} />
        </div>
        <StrikeWorkspace key={data.expiry ?? 'unknown'} data={data} domain={domain} range={strikeRange} onRangeChange={setStrikeRange}
          fullStamp={fullStamp} atmStamp={atmStamp} putCall={data.put_call && <Section title="Put/Call 비율"
            caveat="풋 매수가 하락 베팅인지 보유 포지션 헤지인지 구분하지 못합니다. 거래량은 당일 흐름, 미결제는 누적 포지션을 뜻합니다."
            asOf={fullStamp}>
            <PutCallPanel pc={data.put_call} /><PutCallSeriesChart points={data.put_call_series} />
          </Section>} />
        <p className="px-xs text-xs text-fg-dim">시장 상태를 관측하기 위한 지표입니다. 투자 판단 도구가 아닙니다.</p>
      </div>
    </PageContainer>
  );
}
