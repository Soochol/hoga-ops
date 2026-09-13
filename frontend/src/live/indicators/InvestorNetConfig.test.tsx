import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import InvestorNetConfig from './InvestorNetConfig';
const foreign = vi.fn();
const institution = vi.fn();
vi.mock('../workspace/windowView', () => ({
  useWindowIndicator: (select: (s: { foreignTradeSide: string; institutionTradeSide: string }) => string) =>
    select({ foreignTradeSide: 'sell', institutionTradeSide: 'net' }),
  useIndicatorActions: () => ({ setForeignTradeSide: foreign, setInstitutionTradeSide: institution }),
}));
beforeEach(() => { foreign.mockClear(); institution.mockClear(); });
it('edits only the foreign setting', () => {
  render(<InvestorNetConfig which="foreign" />);
  expect(screen.getByRole('combobox')).toHaveValue('sell');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'buy' } });
  expect(foreign).toHaveBeenCalledWith('buy');
  expect(institution).not.toHaveBeenCalled();
});
it('edits only the institution setting', () => {
  render(<InvestorNetConfig which="institution" />);
  expect(screen.getByRole('combobox')).toHaveValue('net');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'sell' } });
  expect(institution).toHaveBeenCalledWith('sell');
  expect(foreign).not.toHaveBeenCalled();
});
it('keeps index investor settings on net even when the chart stored a gross side', () => {
  render(<InvestorNetConfig which="foreign" grossSupported={false} />);
  expect(screen.getByRole('combobox')).toHaveValue('net');
  expect(screen.getByRole('combobox')).toBeDisabled();
});
