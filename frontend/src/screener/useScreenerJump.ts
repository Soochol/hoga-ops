import { useLocation, useNavigate } from 'react-router';
import type { ScreenerCalculation } from '../api/screener';
import { useJumpToLive, wantsNewTab, type JumpModifiers } from '../live/useJumpToLive';
import { openWorkspaceInNewTab } from '../live/openWorkspaceInNewTab';

/** The chart currently reads its own current vendor prices; carry the result reference explicitly. */
export function useScreenerJump(calculation?: ScreenerCalculation | null) {
  const openLive = useJumpToLive();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (code: string, label?: string, event?: JumpModifiers) => {
    if (calculation?.policy !== 'separate_bases_v2' || !calculation.snapshot_id) {
      openLive(code, label, event); return;
    }
    const params = new URLSearchParams({ screener_code: code, screener_snapshot: calculation.snapshot_id,
      screener_asof: calculation.adjusted_as_of ?? '' });
    if (wantsNewTab(event)) {
      params.set('code', code);
      openWorkspaceInNewTab(`/live?${params}`);
    } else {
      openLive(code, label, event);
      navigate(`/live?${params}`, { replace: pathname === '/live' });
    }
  };
}
