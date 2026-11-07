export type DailyFlowSubject = 'foreign' | 'institution';
export type DailyFlowSource = 'kiwoom_ka10059';
export type DailyFlowScope = 'KRX';
export type DailyFlowUnit = 'qty_shares';
export type DailyFlowSide = 'net';
export type DailyFlowPagination = 'covered' | 'incomplete';
export type DailyFlowIssueReason = 'invalid_row' | 'duplicate_conflict' | 'invalid_page' | 'cursor_stalled' | 'page_budget' | 'api_error' | 'unavailable';
export interface InvestorDailyFlowObservation { date: string; t_ms: number; institution_net_shares: number | null; foreign_net_shares: number | null }
export interface InvestorDailyFlowIssue { reason: DailyFlowIssueReason; date: string | null; subject: DailyFlowSubject | null; message: string }
export interface InvestorDailyFlowResponse {
  code: string; from: string; to: string; source: DailyFlowSource; provider_scope: DailyFlowScope;
  unit: DailyFlowUnit; trade_side: DailyFlowSide; observations: InvestorDailyFlowObservation[];
  pagination: DailyFlowPagination; unlocated_defect: boolean; pages_observed: number;
  /** Whether this requested range can advance now. false does not imply terminal coverage. */
  can_continue: boolean;
  data_warnings: InvestorDailyFlowIssue[];
}
export interface DailyFlowRequestScope { code: string; from: string; to: string }
export function isDailyFlowDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[0-9]{8}$/.test(value)) return false;
  const date = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10).replaceAll('-', '') === value;
}
const issueReasons: readonly unknown[] = ['invalid_row', 'duplicate_conflict', 'invalid_page', 'cursor_stalled', 'page_budget', 'api_error', 'unavailable'];
function isShares(value: unknown): value is number | null { return value === null || (typeof value === 'number' && Number.isSafeInteger(value)); }
function isObservation(value: unknown): value is InvestorDailyFlowObservation {
  return value !== null && typeof value === 'object' && 'date' in value && isDailyFlowDate(value.date)
    && 't_ms' in value && value.t_ms === Date.parse(`${value.date.slice(0, 4)}-${value.date.slice(4, 6)}-${value.date.slice(6)}T00:00:00Z`)
    && 'institution_net_shares' in value && isShares(value.institution_net_shares)
    && 'foreign_net_shares' in value && isShares(value.foreign_net_shares);
}
function isIssue(value: unknown): value is InvestorDailyFlowIssue {
  return value !== null && typeof value === 'object' && 'reason' in value && issueReasons.includes(value.reason)
    && 'subject' in value && (value.subject === null || value.subject === 'foreign' || value.subject === 'institution')
    && 'date' in value && (value.date === null || isDailyFlowDate(value.date)) && 'message' in value && typeof value.message === 'string';
}
export function parseInvestorDailyFlow(value: unknown, scope: DailyFlowRequestScope): InvestorDailyFlowResponse {
  if (value === null || typeof value !== 'object' || !('code' in value) || value.code !== scope.code
    || !('from' in value) || value.from !== scope.from || !('to' in value) || value.to !== scope.to
    || !('source' in value) || value.source !== 'kiwoom_ka10059' || !('provider_scope' in value) || value.provider_scope !== 'KRX'
    || !('unit' in value) || value.unit !== 'qty_shares' || !('trade_side' in value) || value.trade_side !== 'net'
    || !('pagination' in value) || (value.pagination !== 'covered' && value.pagination !== 'incomplete')
    || !('unlocated_defect' in value) || typeof value.unlocated_defect !== 'boolean'
    || !('pages_observed' in value) || typeof value.pages_observed !== 'number' || !Number.isSafeInteger(value.pages_observed) || value.pages_observed < 0
    || !('can_continue' in value) || typeof value.can_continue !== 'boolean'
    || !('observations' in value) || !Array.isArray(value.observations) || !value.observations.every(isObservation)
    || !('data_warnings' in value) || !Array.isArray(value.data_warnings) || !value.data_warnings.every(isIssue)) {
    throw new Error('투자자 누적 자료의 응답 기준이 다릅니다');
  }
  return { code: value.code, from: value.from, to: value.to, source: value.source, provider_scope: value.provider_scope,
    unit: value.unit, trade_side: value.trade_side, observations: value.observations, pagination: value.pagination,
    unlocated_defect: value.unlocated_defect, pages_observed: value.pages_observed, can_continue: value.can_continue,
    data_warnings: value.data_warnings };
}
