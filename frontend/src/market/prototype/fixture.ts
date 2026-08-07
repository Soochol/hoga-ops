/** PROTOTYPE 픽스처 — **버려질 코드다.**
 *
 *  파생 7종 투자자 수급 세션 시계열. **실측이 아니라 합성값**이다 — 원천인 KIS
 *  `FHPTJ04030000` 은 실계좌 앱키 전용(모의투자 미지원)이고, 워크트리에서 부르면
 *  같은 앱키의 prod 토큰이 죽는다(#1088). 그래서 문서상 응답 구조 + 시장 규모
 *  근사로 만든다.
 *
 *  합성이어도 **판단 재료로 쓸모 있는 축**은 실물이다:
 *   - 표본 간격 60초 · 세션 09:00–15:45(파생은 주식보다 15분 늦게 닫는다)
 *   - 주체별 순매수 합이 대략 0 인 제로섬 구조(파생의 성질)
 *   - **상품 간 대금 규모가 100배 갈린다** — 선물 1계약 ≈ 1.15억(승수 25만),
 *     콜옵션 1계약 ≈ 75만(프리미엄). 억원 단일 축이 옵션에서 안 읽히는 이유가
 *     이것이고, 변형 A vs B 의 축 선택이 바로 그 질문이다.
 *
 *  시드 고정이라 새로고침해도 같은 그림이다 — 변형을 오갈 때 데이터가 흔들리면
 *  레이아웃 판단이 오염된다.
 */

/** 상품 — KIS `FHPTJ04030000` 의 (시장구분, 업종구분) 쌍이 실제 코드다. */
export type ProductKey = 'F001' | 'OC01' | 'OP01' | 'F004' | 'OC02' | 'OP02' | 'S001';

export type Product = {
  key: ProductKey;
  label: string;
  /** `fid_input_iscd` */
  iscd: string;
  /** 상품군 — 변형 C 가 콜/풋 대칭을 세우는 축이다. */
  family: 'futures' | 'call' | 'put';
  /** 미니·주식선물 구분 배지용 */
  tier: 'main' | 'mini' | 'stock';
  /** 계약 1건의 대략적 명목/프리미엄 대금(백만원). 축 환산 논쟁의 근거. */
  unitMillionWon: number;
};

export const PRODUCTS: readonly Product[] = [
  { key: 'F001', label: '선물', iscd: 'K2I', family: 'futures', tier: 'main', unitMillionWon: 115 },
  { key: 'OC01', label: '콜옵션', iscd: 'K2I', family: 'call', tier: 'main', unitMillionWon: 0.75 },
  { key: 'OP01', label: '풋옵션', iscd: 'K2I', family: 'put', tier: 'main', unitMillionWon: 0.9 },
  { key: 'F004', label: '미니선물', iscd: 'MKI', family: 'futures', tier: 'mini', unitMillionWon: 23 },
  { key: 'OC02', label: '미니콜옵션', iscd: 'MKI', family: 'call', tier: 'mini', unitMillionWon: 0.15 },
  { key: 'OP02', label: '미니풋옵션', iscd: 'MKI', family: 'put', tier: 'mini', unitMillionWon: 0.18 },
  { key: 'S001', label: '주식선물', iscd: '999', family: 'futures', tier: 'stock', unitMillionWon: 9 },
] as const;

/** 주식 시장 — 변형 A 가 같은 선택기에 태우는 대조군이다. */
export const STOCK_MARKETS = [
  { key: 'KSP' as const, label: '코스피' },
  { key: 'KSQ' as const, label: '코스닥' },
];

export type ActorKey = 'individual' | 'foreign' | 'institution';

export const ACTORS: readonly { key: ActorKey; label: string }[] = [
  { key: 'individual', label: '개인' },
  { key: 'foreign', label: '외국인' },
  { key: 'institution', label: '기관' },
];

/** 파생 정규장은 09:00–15:45 다. 주식(15:30)과 다르므로 세션축을 따로 잡는다. */
export const DERIV_SESSION_START_SEC = 9 * 3600;
export const DERIV_SESSION_END_SEC = 15 * 3600 + 45 * 60;
const POLL_SEC = 60;

export type FlowPoint = {
  sec: number;
  /** 순매수 계약수(누적) */
  contracts: Record<ActorKey, number>;
  /** 순매수 대금(누적, 백만원) */
  millionWon: Record<ActorKey, number>;
};

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 상품별 스케일(계약수) · 방향. 실제 하루 순매수 규모의 자릿수를 맞춘 것이다. */
const SHAPE: Record<ProductKey, { scale: number; foreignDrift: number; instDrift: number; seed: number }> = {
  F001: { scale: 9_000, foreignDrift: 1.0, instDrift: -0.55, seed: 11 },
  OC01: { scale: 24_000, foreignDrift: -0.7, instDrift: 0.4, seed: 22 },
  OP01: { scale: 21_000, foreignDrift: 0.85, instDrift: -0.3, seed: 33 },
  F004: { scale: 1_800, foreignDrift: 0.6, instDrift: -0.8, seed: 44 },
  OC02: { scale: 2_600, foreignDrift: -0.35, instDrift: 0.15, seed: 55 },
  OP02: { scale: 2_200, foreignDrift: 0.5, instDrift: -0.2, seed: 66 },
  S001: { scale: 52_000, foreignDrift: -0.9, instDrift: 0.7, seed: 77 },
};

function buildSeries(p: Product): FlowPoint[] {
  const cfg = SHAPE[p.key];
  const rnd = mulberry32(cfg.seed);
  const n = Math.floor((DERIV_SESSION_END_SEC - DERIV_SESSION_START_SEC) / POLL_SEC) + 1;
  const out: FlowPoint[] = [];
  let foreign = 0;
  let inst = 0;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    // 장 초반·마감 직전에 체결이 몰리는 U 자 강도.
    const intensity = 0.45 + 1.4 * (Math.pow(1 - t, 2) + Math.pow(t, 3));
    const step = (cfg.scale / n) * intensity;
    foreign += step * (cfg.foreignDrift + (rnd() - 0.5) * 2.6);
    inst += step * (cfg.instDrift + (rnd() - 0.5) * 2.2);
    // 파생은 제로섬이다 — 개인이 나머지를 받아낸다(기타법인 몫만큼만 어긋난다).
    const individual = -(foreign + inst) * (0.88 + rnd() * 0.06);
    const contracts = {
      foreign: Math.round(foreign),
      institution: Math.round(inst),
      individual: Math.round(individual),
    };
    out.push({
      sec: DERIV_SESSION_START_SEC + i * POLL_SEC,
      contracts,
      millionWon: {
        foreign: Math.round(contracts.foreign * p.unitMillionWon),
        institution: Math.round(contracts.institution * p.unitMillionWon),
        individual: Math.round(contracts.individual * p.unitMillionWon),
      },
    });
  }
  return out;
}

export const DERIV_FLOW: Record<ProductKey, FlowPoint[]> = Object.fromEntries(
  PRODUCTS.map((p) => [p.key, buildSeries(p)]),
) as Record<ProductKey, FlowPoint[]>;

/** 표본이 15:45 까지 다 차 있는 건 장 마감 후 상태다. "지금" 을 흉내내려면 잘라야
 *  부분 커버리지의 생김새(현행 카드의 성질)를 볼 수 있다. 14:20 에서 자른다. */
export const NOW_SEC = 14 * 3600 + 20 * 60;

export function upTo(points: FlowPoint[], sec = NOW_SEC): FlowPoint[] {
  return points.filter((p) => p.sec <= sec);
}

export function lastOf(key: ProductKey): FlowPoint | undefined {
  const s = upTo(DERIV_FLOW[key]);
  return s[s.length - 1];
}

/** 억원 환산 — 현행 카드의 축(`unit: "amt_eok"`)에 맞출 때 쓴다. 백만원 → 억원. */
export function toEok(millionWon: number): number {
  return millionWon / 100;
}

export const SAMPLE_COUNT = upTo(DERIV_FLOW.F001).length;
export const EXPECTED_COUNT =
  Math.floor((DERIV_SESSION_END_SEC - DERIV_SESSION_START_SEC) / POLL_SEC) + 1;
