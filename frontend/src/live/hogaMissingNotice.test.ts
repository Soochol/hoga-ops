import { describe, expect, it } from 'vitest';
import { deriveHogaMissingDetail, deriveHogaMissingNotice } from './hogaMissingNotice';

const absent = (date: string, reason = 'source_missing') => ({ date, reason });

describe('deriveHogaMissingNotice', () => {
  it('결손이 없으면 안내하지 않는다', () => {
    expect(deriveHogaMissingNotice({
      missingDates: [], venue: 'NXT', hasAnyHogaPoints: true,
    })).toBeNull();
    expect(deriveHogaMissingNotice({
      missingDates: undefined, venue: 'NXT', hasAnyHogaPoints: true,
    })).toBeNull();
  });

  it('NXT 전 구간 결손 — 시장 이름을 넣는다', () => {
    // 이 케이스가 이 기능의 존재 이유다: NXT 는 kiwoom_live 가 저장을 시작한 날부터만
    // 존재하므로 그 이전 조회는 전부 빈다. 이름이 없으면 사용자는 원인을 못 찾는다.
    expect(deriveHogaMissingNotice({
      missingDates: [absent('20260701'), absent('20260702')],
      venue: 'NXT',
      hasAnyHogaPoints: false,
    })).toBe('NXT 호가 기록 없음');
  });

  it('통합은 라벨이 한글이다', () => {
    expect(deriveHogaMissingNotice({
      missingDates: [absent('20260701')], venue: 'UN', hasAnyHogaPoints: false,
    })).toBe('통합 호가 기록 없음');
  });

  it('KRX 는 시장 이름을 빼고 말한다', () => {
    // "KRX 호가 기록 없음" 은 시장을 원인으로 오해하게 만든다 — KRX 에서 결손의
    // 원인은 시장이 아니라 그날 캡처가 없다는 것이다.
    expect(deriveHogaMissingNotice({
      missingDates: [absent('20260701', 'stock_date_missing')],
      venue: 'KRX',
      hasAnyHogaPoints: false,
    })).toBe('호가 기록 없음');
  });

  it('일부 구간만 결손이면 "포함" 으로 말한다', () => {
    // 보이는 데이터가 있는데 "없음" 이라고 하면 화면과 모순된다.
    expect(deriveHogaMissingNotice({
      missingDates: [absent('20260701')], venue: 'NXT', hasAnyHogaPoints: true,
    })).toBe('NXT 호가 기록 없는 구간 포함');
  });

  it('손상은 결손과 다르게 말한다 — 재캡처 여지가 있다', () => {
    expect(deriveHogaMissingNotice({
      missingDates: [{ date: '20260701', reason: 'meta_unreadable' }],
      venue: 'NXT',
      hasAnyHogaPoints: false,
    })).toBe('호가 기록 손상');
  });

  it('결손과 손상이 섞이면 결손을 우선한다', () => {
    // 손상은 재캡처로 고칠 수 있고 결손은 아니다 — 먼저 알아야 할 쪽이 결손이다.
    expect(deriveHogaMissingNotice({
      missingDates: [
        { date: '20260701', reason: 'meta_unreadable' },
        absent('20260702', 'venue_unsupported'),
      ],
      venue: 'NXT',
      hasAnyHogaPoints: false,
    })).toBe('NXT 호가 기록 없음');
  });

  it('no_upstream_data 는 날짜를 말한다 — 한 건이면 그 날짜', () => {
    // 캔들이 **보충되지 않은** 업스트림 결손일 — 그날은 호가만이 아니라 캔들까지 없어
    // 차트에 빈칸으로 남는다. "호가 기록 없음" 으로 뭉뚱그리면 절반만 맞다. 그리고
    // 희소하므로(전체 429거래일 중 4일) 날짜를 지목할 수 있다 — 사용자가 차트에서
    // 어디가 빠졌는지 바로 찾는다. `datesWithCandles` 미지정이 곧 "보충 없음" 이다.
    expect(deriveHogaMissingNotice({
      missingDates: [{ date: '20251218', reason: 'no_upstream_data' }],
      venue: 'KRX',
      hasAnyHogaPoints: false,
    })).toBe('12/18 업스트림 데이터 없음');
  });

  it('no_upstream_data 가 여러 날이면 일수로 말한다', () => {
    // 날짜를 다 나열하면 한 줄을 넘겨 차트를 가린다.
    expect(deriveHogaMissingNotice({
      missingDates: [
        { date: '20250924', reason: 'no_upstream_data' },
        { date: '20251218', reason: 'no_upstream_data' },
      ],
      venue: 'KRX',
      hasAnyHogaPoints: true,
    })).toBe('업스트림 데이터 없음 2일');
  });

  it('업스트림 결손이 venue 결손보다 구체적이다 — 그쪽을 말한다', () => {
    expect(deriveHogaMissingNotice({
      missingDates: [
        { date: '20260701', reason: 'source_missing' },
        { date: '20251218', reason: 'no_upstream_data' },
      ],
      venue: 'NXT',
      hasAnyHogaPoints: false,
    })).toBe('12/18 업스트림 데이터 없음');
  });

  it('not_captured 는 /live 에서 침묵한다 — 안내가 아니라 노이즈다', () => {
    // 실측(2026-08-16): 90일 창에서 한 종목이 22일까지 미캡처일 수 있다. 그걸
    // "호가 기록 없음" 으로 말하면 /live 배너가 상시 켜져 의미를 잃는다. 이 사유는
    // 저장 구간이 명시적인 /study 에서만 뜻이 있다.
    //
    // ⚠ 필터가 **분류보다 먼저** 와야 한다. 뒤에 두면 `not_captured` 만 담긴 목록이
    // `!absent` 로 떨어져 "호가 기록 손상" 이 뜬다 — 침묵이 아니라 오진이다.
    expect(deriveHogaMissingNotice({
      missingDates: [{ date: '20260805', reason: 'not_captured' }],
      venue: 'KRX',
      hasAnyHogaPoints: true,
    })).toBeNull();
    expect(deriveHogaMissingNotice({
      missingDates: [{ date: '20260805', reason: 'not_captured' }],
      venue: 'NXT',
      hasAnyHogaPoints: false,
    })).toBeNull();
  });

  it('not_captured 가 섞여도 진짜 결손은 그대로 말한다', () => {
    expect(deriveHogaMissingNotice({
      missingDates: [
        { date: '20260805', reason: 'not_captured' },
        { date: '20251218', reason: 'no_upstream_data' },
      ],
      venue: 'KRX',
      hasAnyHogaPoints: false,
    })).toBe('12/18 업스트림 데이터 없음');
  });

  it('미지의 사유는 손상 문구로 폴백한다 — 렌더가 깨지지 않는다', () => {
    // 백엔드가 새 MissingReason 을 추가해도 프론트가 빈 화면이 되지 않아야 한다.
    expect(deriveHogaMissingNotice({
      missingDates: [{ date: '20260701', reason: 'something_new' }],
      venue: 'KRX',
      hasAnyHogaPoints: false,
    })).toBe('호가 기록 손상');
  });
});

describe('deriveHogaMissingDetail', () => {
  it('캔들이 없는 업스트림 결손은 "캔들만 표시" 라고 말하면 안 된다', () => {
    // 기본 문구(#1133)는 호가 pane 전용 맥락이라 **보충되지 않은** 이 사유에는
    // 틀린 말이다. 그날은 호가·체결·캔들이 전부 없어 차트에서 통째로 빠진다.
    expect(deriveHogaMissingDetail([{ date: '20251218', reason: 'no_upstream_data' }]))
      .toBe('그날은 캔들과 호가가 모두 없어 차트에서 빠집니다.');
  });

  it('그 외 사유는 종전 문구를 유지한다', () => {
    expect(deriveHogaMissingDetail([{ date: '20260701', reason: 'source_missing' }]))
      .toBe('이 구간은 호가 지표를 만들 데이터가 없어 캔들만 표시됩니다.');
  });

  it('캔들이 보충된 업스트림 결손은 기본 문구로 돌아간다 — 그날 없는 건 호가뿐이다', () => {
    // 시각 문구와 **같은 헬퍼**로 갈리는지 재는 자리다. 여기가 갈리면 화면엔
    // 「호가 기록 없는 구간 포함」인데 스크린리더엔 「캔들과 호가가 모두 없어」가 남는다.
    expect(deriveHogaMissingDetail(
      [{ date: '20251218', reason: 'no_upstream_data' }],
      new Set(['20251218']),
    )).toBe('이 구간은 호가 지표를 만들 데이터가 없어 캔들만 표시됩니다.');
  });

  it('보충되지 않은 날이 하나라도 남으면 캔들 결손을 말한다', () => {
    expect(deriveHogaMissingDetail(
      [
        { date: '20251218', reason: 'no_upstream_data' },
        { date: '20251219', reason: 'no_upstream_data' },
      ],
      new Set(['20251218']),
    )).toBe('그날은 캔들과 호가가 모두 없어 차트에서 빠집니다.');
  });
});

/**
 * 키움 보충·벤더 REST 가 캔들을 되받아 온 `no_upstream_data` 날짜 (2026-08-26).
 *
 * 실측 010140 의 `20260313`·`20260319`·`20260518` 이 그 경우였다 — 각 날짜당 5분봉
 * 78봉이 정상으로 그려지는데 안내는 「업스트림 데이터 없음 3일」이었고, 옆에 뜬
 * 「hogaplay · 키움 보충」 배지와 정면으로 모순됐다.
 *
 * **판별식이 `datesWithCandles` 하나여야 한다** — 같은 `missingDates` 에 이 집합만
 * 넣고 빼서 출력이 갈리는지가 이 묶음의 red-check 다. 갈리지 않으면 수정이 불활성이다.
 */
describe('deriveHogaMissingNotice — 캔들이 보충된 업스트림 결손', () => {
  const upstream = (date: string) => ({ date, reason: 'no_upstream_data' });
  const THREE = [upstream('20260313'), upstream('20260319'), upstream('20260518')];

  it('전부 보충됐으면 「업스트림 데이터 없음」이라고 말하지 않는다', () => {
    // 대조군: 같은 입력에 집합만 없으면 종전 문구가 나온다(아래 마지막 케이스).
    expect(deriveHogaMissingNotice({
      missingDates: THREE,
      venue: 'KRX',
      hasAnyHogaPoints: true,
      datesWithCandles: new Set(['20260313', '20260319', '20260518']),
    })).toBe('호가 기록 없는 구간 포함');
  });

  it('보충됐고 호가 포인트가 전혀 없으면 「호가 기록 없음」', () => {
    // `no_upstream_data` 가 ABSENT_REASONS 에 남아 있어야 성립한다. 빼면 이 케이스가
    // `!absent` 분기로 떨어져 「호가 기록 손상」 오진이 된다 — 손상이 아니다.
    expect(deriveHogaMissingNotice({
      missingDates: THREE,
      venue: 'KRX',
      hasAnyHogaPoints: false,
      datesWithCandles: new Set(['20260313', '20260319', '20260518']),
    })).toBe('호가 기록 없음');
  });

  it('일부만 보충됐으면 **남은 것만** 센다', () => {
    expect(deriveHogaMissingNotice({
      missingDates: THREE,
      venue: 'KRX',
      hasAnyHogaPoints: false,
      datesWithCandles: new Set(['20260313']),
    })).toBe('업스트림 데이터 없음 2일');
  });

  it('한 날만 남으면 그 날짜를 지목한다 — 차트의 빈칸이 실제로 하나다', () => {
    expect(deriveHogaMissingNotice({
      missingDates: THREE,
      venue: 'KRX',
      hasAnyHogaPoints: false,
      datesWithCandles: new Set(['20260313', '20260319']),
    })).toBe('05/18 업스트림 데이터 없음');
  });

  it('venue 결손은 보충 대상이 아니라 집합이 있어도 그대로 말한다', () => {
    // `FILLABLE_REASONS`(minuteGapFillPlan.ts)가 이 사유를 안 채운다 — NXT 차트에
    // KRX 봉을 섞지 않기 위해서다. 문구도 그 정책을 따라야 한다.
    expect(deriveHogaMissingNotice({
      missingDates: [{ date: '20260313', reason: 'venue_unsupported' }],
      venue: 'NXT',
      hasAnyHogaPoints: false,
      datesWithCandles: new Set(['20260313']),
    })).toBe('NXT 호가 기록 없음');
  });

  it('집합을 안 주면 종전 동작 그대로 — 기존 호출부가 회귀하지 않는다', () => {
    expect(deriveHogaMissingNotice({
      missingDates: THREE, venue: 'KRX', hasAnyHogaPoints: true,
    })).toBe('업스트림 데이터 없음 3일');
  });
});

describe('deriveHogaMissingNotice — /study 의 not_captured 문구', () => {
  const notCaptured = (date: string) => ({ date, reason: 'not_captured' });

  it('옵션을 켜면 미캡처를 말한다 — 한 건이면 날짜', () => {
    expect(deriveHogaMissingNotice({
      missingDates: [notCaptured('20260805')],
      venue: 'KRX',
      hasAnyHogaPoints: true,
      includeNotCaptured: true,
    })).toBe('08/05 미캡처');
  });

  it('여러 날이면 일수로', () => {
    expect(deriveHogaMissingNotice({
      missingDates: [notCaptured('20260805'), notCaptured('20260806'), notCaptured('20260807')],
      venue: 'KRX',
      hasAnyHogaPoints: true,
      includeNotCaptured: true,
    })).toBe('미캡처 3일');
  });

  it('옵션이 꺼져 있으면 종전대로 침묵한다 — /live 의 기본값', () => {
    expect(deriveHogaMissingNotice({
      missingDates: [notCaptured('20260805')],
      venue: 'KRX',
      hasAnyHogaPoints: true,
    })).toBeNull();
  });

  it('결손이 함께 있으면 결손을 먼저 말한다 — 고칠 수 없는 쪽이 우선', () => {
    // 이 모듈의 기존 정책과 같은 규칙이다("손상은 재캡처로 고칠 수 있고 결손은 아니다").
    // 미캡처도 **고칠 수 있는** 부류라 결손 뒤에 선다.
    expect(deriveHogaMissingNotice({
      missingDates: [notCaptured('20260805'), { date: '20251218', reason: 'no_upstream_data' }],
      venue: 'KRX',
      hasAnyHogaPoints: true,
      includeNotCaptured: true,
    })).toBe('12/18 업스트림 데이터 없음');
  });

  it('미캡처의 뒷문장은 "캡처하면 채워진다" 여야 한다', () => {
    expect(deriveHogaMissingDetail([notCaptured('20260805')]))
      .toBe('아직 캡처하지 않은 날입니다. 캡처하면 채워집니다.');
  });
});
