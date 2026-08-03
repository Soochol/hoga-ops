import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';

/** 미러: hoga/api/models.py::PutCallRatioModel */
export interface PutCallRatio {
  /** 분모가 0이면 null — '비율 없음'이지 0이 아니다. 장 초반에 실제로 난다. */
  volume_ratio: number | null;
  oi_ratio: number | null;
  call_volume: number;
  put_volume: number;
  call_oi: number;
  put_oi: number;
}

export interface StrikeOi {
  strike: number;
  call_oi: number;
  put_oi: number;
}

export interface OiDistribution {
  strikes: StrikeOi[];
  max_pain: number | null;
}

export interface GexPoint {
  strike: number;
  gex: number;
}

export interface GammaExposure {
  points: GexPoint[];
  total: number;
  flip_strike: number | null;
}

export interface IvPoint {
  strike: number;
  call_iv: number | null;
  put_iv: number | null;
}

export interface IvSkew {
  points: IvPoint[];
  atm_iv: number | null;
  risk_reversal_25d: number | null;
}

/**
 * 미러: hoga/api/models.py::OptionSentimentResponse (ADR-0135).
 *
 * `full_as_of_ms` 와 `atm_as_of_ms` 가 따로 있는 이유: 전수 계층(5분)과 ATM
 * 계층(30초)의 관측 시각이 다르다. 화면은 이 둘을 각각 표시해야 한다 —
 * 하나로 뭉치면 5분 전 GEX 와 30초 전 ATM IV 가 같은 시각으로 읽힌다.
 */
export interface OptionSentiment {
  /** null 이면 정상. 'kis_credentials_missing' | 'warming' | 'collector_failed' | 'option_master_unavailable' */
  unavailable: string | null;
  expiry: string | null;
  underlying: number | null;
  full_as_of_ms: number | null;
  atm_as_of_ms: number | null;
  put_call: PutCallRatio | null;
  oi_distribution: OiDistribution | null;
  gamma_exposure: GammaExposure | null;
  iv_skew: IvSkew | null;
}

/**
 * `/api/sentiment/option` 폴링.
 *
 * 30초는 백엔드 ATM 계층 주기와 맞춘 값이다. 더 자주 불러도 전수 스냅샷은
 * 5분에 한 번만 갱신되므로 얻는 게 없다. 첫 요청이 백엔드 수집 루프를
 * 깨우고(요청 구동), 페이지를 닫으면 10분 뒤 루프가 스스로 멈춘다.
 */
export function useOptionSentiment() {
  return useQuery({
    queryKey: ['sentiment', 'option'],
    queryFn: () => apiCall<OptionSentiment>('/api/sentiment/option'),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}
