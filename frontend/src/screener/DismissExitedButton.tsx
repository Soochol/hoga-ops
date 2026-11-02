import { ToolbarButton } from '../ui/PageShell';

export function DismissExitedButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return <ToolbarButton disabled={disabled} onClick={onClick} className="shrink-0 whitespace-nowrap rounded-md">
    이탈 제외
  </ToolbarButton>;
}
