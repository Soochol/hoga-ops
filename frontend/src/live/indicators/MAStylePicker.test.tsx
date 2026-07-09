import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MAStylePicker, { MA_COLOR_ROWS } from './MAStylePicker';

describe('MAStylePicker', () => {
  it('renders trigger with color dot + line-width preview reflecting props', () => {
    render(<MAStylePicker color="#EC4899" lineWidth={3} onChange={() => {}} />);
    const trigger = screen.getByRole('button', { name: 'MA 스타일 선택' });
    // Trigger has two aria-hidden previews inside (dot + line). Both should
    // be painted with the current color; the line's height = lineWidth.
    const previews = trigger.querySelectorAll('span[aria-hidden="true"]');
    expect(previews).toHaveLength(2);
    // Dot uses backgroundColor; the line preview uses border-top (so it can
    // reflect solid/dashed/dotted) with width = lineWidth.
    expect((previews[0] as HTMLElement).style.backgroundColor).toMatch(/236.*72.*153|#ec4899/i);
    expect((previews[1] as HTMLElement).style.borderTopColor).toMatch(/236.*72.*153|#ec4899/i);
    expect((previews[1] as HTMLElement).style.borderTopWidth).toBe('3px');
  });

  it('renders 모양(line-style) section only when lineStyle + onLineStyleChange given', () => {
    const onLineStyleChange = vi.fn();
    const { rerender } = render(<MAStylePicker color="#EC4899" lineWidth={1} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'MA 스타일 선택' }));
    // Absent by default (기존 호출부 불변).
    expect(screen.queryAllByRole('button', { name: /^MA 모양 / })).toHaveLength(0);
    rerender(
      <MAStylePicker
        color="#EC4899"
        lineWidth={1}
        lineStyle="dashed"
        onChange={() => {}}
        onLineStyleChange={onLineStyleChange}
      />,
    );
    const styleButtons = screen.getAllByRole('button', { name: /^MA 모양 / });
    expect(styleButtons).toHaveLength(3);
    expect(
      screen.getByRole('button', { name: 'MA 모양 파선' }).getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'MA 모양 점선' }));
    expect(onLineStyleChange).toHaveBeenCalledWith('dotted');
  });

  it('opens combined palette+width popover on click', () => {
    render(<MAStylePicker color="#EC4899" lineWidth={1} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'MA 스타일 선택' }));
    const colorButtons = screen.getAllByRole('button', { name: /^MA 색상 / });
    const widthButtons = screen.getAllByRole('button', { name: /^MA 굵기 / });
    expect(colorButtons).toHaveLength(32);
    expect(widthButtons).toHaveLength(4);
  });

  it('emits {color} and closes popover when a swatch is picked', () => {
    const onChange = vi.fn();
    render(<MAStylePicker color="#EC4899" lineWidth={1} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'MA 스타일 선택' }));
    const target = MA_COLOR_ROWS[2][3];
    const swatch = screen.getByRole('button', { name: `MA 색상 ${target}` });
    fireEvent.click(swatch);
    expect(onChange).toHaveBeenCalledWith({ color: target });
    expect(screen.queryAllByRole('button', { name: /^MA 색상 / })).toHaveLength(0);
  });

  it('emits {lineWidth} when a width card is picked, keeps popover open', () => {
    const onChange = vi.fn();
    render(<MAStylePicker color="#EC4899" lineWidth={1} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'MA 스타일 선택' }));
    const w3 = screen.getByRole('button', { name: 'MA 굵기 3px' });
    fireEvent.click(w3);
    expect(onChange).toHaveBeenCalledWith({ lineWidth: 3 });
    expect(screen.getAllByRole('button', { name: /^MA 굵기 / })).toHaveLength(4);
  });

  it('marks the current color and width as selected via aria-pressed', () => {
    render(<MAStylePicker color="#A855F7" lineWidth={2} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'MA 스타일 선택' }));
    expect(
      screen.getByRole('button', { name: 'MA 색상 #A855F7' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: 'MA 굵기 2px' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('exports a 4x8 grid of 32 distinct colors', () => {
    expect(MA_COLOR_ROWS).toHaveLength(4);
    for (const row of MA_COLOR_ROWS) {
      expect(row).toHaveLength(8);
    }
    const flat = MA_COLOR_ROWS.flat();
    expect(new Set(flat).size).toBe(flat.length);
  });

  it('label prop으로 aria 문구 일반화', () => {
    render(<MAStylePicker color="#1D4ED8" lineWidth={2} onChange={() => {}} label="매도벽" />);
    expect(screen.getByRole('button', { name: '매도벽 스타일 선택' })).toBeTruthy();
  });
});
