import { AppIcon } from './AppIcon';
import { useTextTooltip } from './useTextTooltip';

export function InfoButton({ label, text }: { label: string; text: string }) {
  const help = useTextTooltip(text, 500);
  return <>
    <button type="button" className="ui-icon-button" aria-label={label}
      data-tooltip-trigger="" aria-describedby={help.id}
      onMouseEnter={event => help.show(event.currentTarget)} onMouseLeave={help.hide}
      onFocus={event => help.showOnFocus(event.currentTarget)} onBlur={help.hide}
      onClick={event => help.show(event.currentTarget)}>
      <AppIcon name="info" />
    </button>
    {help.tooltip}
  </>;
}
