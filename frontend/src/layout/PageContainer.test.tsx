import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, it, expect } from 'vitest';
import { PageContainer } from './PageContainer';

describe('PageContainer', () => {
  it('renders children inside the padded frame', () => {
    render(<PageContainer><span>body</span></PageContainer>);
    const child = screen.getByText('body');
    expect(child.parentElement).toHaveClass('p-md');
    expect(child.parentElement).toHaveClass('h-full');
  });

  it('merges extra className and forwards a ref to the frame element', () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <PageContainer ref={ref} className="grid gap-md">
        <span>x</span>
      </PageContainer>,
    );
    expect(ref.current).not.toBeNull();
    expect(ref.current).toHaveClass('grid');
    expect(ref.current).toHaveClass('p-md');
  });
});
