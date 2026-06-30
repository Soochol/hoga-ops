import { LiveSymbolSearch } from './LiveSymbolSearch';
import { WorkspaceHeader } from '../ui/WorkspaceShell';

export function LiveHeader() {
  return (
    <WorkspaceHeader testId="live-header">
      {/* No page-title text here: the top menu marks /live as the active page,
          and the active symbol shows one row down in LiveStatusBar — a header
          "Live" duplicated the nav and added no context. */}
      <LiveSymbolSearch />
    </WorkspaceHeader>
  );
}
