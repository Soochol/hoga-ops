import { vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import LeftNav from '../../src/nav/LeftNav';

vi.mock('../../src/capture/useCaptureJob', () => ({
  useCaptureJob: () => ({ job: null }),
}));

it('renders 4 nav items', () => {
  render(<MemoryRouter><LeftNav /></MemoryRouter>);
  expect(screen.getByText('Replay Viewer')).toBeInTheDocument();
  expect(screen.getByText('Inventory')).toBeInTheDocument();
  expect(screen.getByText('Capture')).toBeInTheDocument();
  expect(screen.getByText('Settings')).toBeInTheDocument();
});
