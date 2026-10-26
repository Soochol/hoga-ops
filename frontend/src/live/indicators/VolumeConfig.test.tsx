import { it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import VolumeConfig from './VolumeConfig';

it('offers candle overlay guidance without the retired cumulative switch', () => {
  render(<VolumeConfig />);
  expect(screen.queryByRole('switch')).toBeNull();
  expect(screen.getByText(/캔들 차트 설정에서 거래량/)).toBeTruthy();
});
