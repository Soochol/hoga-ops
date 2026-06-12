import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import LiveSettingsSections from './LiveSettingsSections';

describe('LiveSettingsSections', () => {
  afterEach(cleanup);

  it('renders toggles from every category (chart·indicators·surge)', () => {
    render(<LiveSettingsSections />);
    expect(screen.getByTestId('settings-toggle-auctionWindowMask')).toBeTruthy(); // chart
    expect(screen.getByTestId('settings-toggle-fillStrengthCumulative')).toBeTruthy(); // indicators
    expect(screen.getByTestId('settings-toggle-surgeMarkerEnabled')).toBeTruthy(); // surge
  });

  it('groups toggles under labelled category sections', () => {
    const { container } = render(<LiveSettingsSections />);
    expect(container.querySelector('[data-settings-category="surge"]')).toBeTruthy();
    expect(container.querySelector('[data-settings-category="indicators"]')).toBeTruthy();
    expect(container.querySelector('[data-settings-category="chart"]')).toBeTruthy();
  });
});
