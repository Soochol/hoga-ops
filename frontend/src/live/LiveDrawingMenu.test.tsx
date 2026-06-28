import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import LiveDrawingMenu from './LiveDrawingMenu';
import { useDrawingsStore } from '../state/drawings';

beforeEach(() => {
  useDrawingsStore.getState().setActiveTool('select');
  useDrawingsStore.getState().clearAll();
});

it('renders the drawing menu in a body portal so chart layers cannot cover it', () => {
  render(<LiveDrawingMenu />);

  fireEvent.click(screen.getByRole('button', { name: '그리기' }));

  expect(screen.getByRole('menu').parentElement).toBe(document.body);
});

it('selects a drawing tool from the portaled menu', () => {
  render(<LiveDrawingMenu />);

  fireEvent.click(screen.getByRole('button', { name: '그리기' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /추세선/ }));

  expect(useDrawingsStore.getState().activeTool).toBe('trendline');
  expect(screen.queryByRole('menu')).toBeNull();
});
