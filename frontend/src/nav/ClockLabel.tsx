import { useWallClockSecond } from '../util/useWallClockSecond';
import { kstClockParts } from './ClockLabelHelpers';


export default function ClockLabel() {
  const { date, time, iso } = kstClockParts(useWallClockSecond());
  return (
    <time
      role="timer"
      dateTime={iso}
      aria-label={`현재 시각 ${date} ${time} KST`}
      className="font-data inline-flex shrink-0 items-baseline gap-1.5 whitespace-nowrap text-xs"
    >
      <span className="text-fg-dim">{date}</span>
      <span className="text-fg">{time}</span>
    </time>
  );
}
