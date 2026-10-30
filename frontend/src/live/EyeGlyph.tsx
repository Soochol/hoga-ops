import { AppIcon } from '../ui/AppIcon';

/** Slash is a shape signal for hidden state, independent of color. */
export default function EyeGlyph({ hidden }: { hidden: boolean }) {
  return <AppIcon name={hidden ? 'eyeOff' : 'eye'} />;
}
