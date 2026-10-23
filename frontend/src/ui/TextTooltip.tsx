import { cloneElement, forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactElement } from 'react';
import { useTextTooltip } from './useTextTooltip';

type TriggerAttributes = HTMLAttributes<HTMLElement> & { 'data-tooltip-trigger'?: string; 'data-tooltip'?: string };

/** Adds the shared tooltip without a wrapper that could change toolbar geometry. */
export function TextTooltip({ text, children }: {
  text?: string;
  children: ReactElement<TriggerAttributes>;
}) {
  const props = children.props;
  const expanded = props['aria-expanded'] === true || props['aria-expanded'] === 'true';
  const tip = useTextTooltip(expanded ? '' : text ?? '', 500);
  return <>
    {cloneElement(children, {
      title: undefined,
      'data-tooltip-trigger': '',
      'data-tooltip': text,
      'aria-describedby': [props['aria-describedby'], tip.id].filter(Boolean).join(' ') || undefined,
      onPointerEnter: event => {
        props.onPointerEnter?.(event);
        if (event.buttons === 0 && event.pointerType !== 'touch') tip.show(event.currentTarget);
      },
      onPointerLeave: event => { props.onPointerLeave?.(event); tip.hide(); },
      onPointerDown: event => { props.onPointerDown?.(event); tip.hide(); },
      onFocus: event => { props.onFocus?.(event); tip.showOnFocus(event.currentTarget); },
      onBlur: event => { props.onBlur?.(event); tip.hide(); },
      onClick: event => { props.onClick?.(event); tip.hide(); },
    })}
    {tip.tooltip}
  </>;
}

/** Keeps native button semantics and forwarded refs, including disabled reasons. */
export const TooltipButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function TooltipButton({ title, ...props }, ref) {
    return <TextTooltip text={title}><button type="button" {...props} ref={ref} /></TextTooltip>;
  },
);
