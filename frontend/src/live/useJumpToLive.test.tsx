import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { useJumpToLive } from './useJumpToLive';
import { useLivePageStore } from '../state/livePage';

function Probe() {
  const jump = useJumpToLive();
  const { pathname } = useLocation();
  return (
    <>
      <button onClick={() => jump('005930')}>jump</button>
      <span data-testid="path">{pathname}</span>
    </>
  );
}

describe('useJumpToLive', () => {
  beforeEach(() => {
    useLivePageStore.setState({ activeCode: null });
  });

  it('sets activeCode and navigates to /live when elsewhere', async () => {
    render(
      <MemoryRouter initialEntries={['/inventory']}>
        <Probe />
        <Routes><Route path="*" element={null} /></Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('jump'));
    expect(useLivePageStore.getState().activeCode).toBe('005930');
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/live'));
  });

  it('sets activeCode without changing route when already on /live', () => {
    render(
      <MemoryRouter initialEntries={['/live']}>
        <Probe />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('jump'));
    expect(useLivePageStore.getState().activeCode).toBe('005930');
    expect(screen.getByTestId('path').textContent).toBe('/live');
  });
});
