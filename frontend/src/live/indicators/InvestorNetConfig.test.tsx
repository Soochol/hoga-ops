import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import InvestorNetConfig from './InvestorNetConfig';
const setSide = vi.fn();
vi.mock('../workspace/windowView', () => ({
  useWindowIndicator: (select: (s: { investorTradeSide: string }) => string) => select({ investorTradeSide: 'sell' }),
  useIndicatorActions: () => ({ setInvestorTradeSide: setSide }),
}));
it('changes both investor panes through their shared chart setting', () => {
  render(<InvestorNetConfig />);
  expect(screen.getByRole('combobox')).toHaveValue('sell');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'buy' } });
  expect(setSide).toHaveBeenCalledWith('buy');
});
it('keeps index investor settings on net even when the chart stored a gross side', () => {
  render(<InvestorNetConfig grossSupported={false} />);
  expect(screen.getByRole('combobox')).toHaveValue('net');
  expect(screen.getByRole('combobox')).toBeDisabled();
});
