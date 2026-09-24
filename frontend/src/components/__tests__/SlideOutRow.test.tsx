/**
 * Tests for SlideOutRow — closes #551
 *
 * Verifies that the Safari-safe animation class (`slide-out-row`) is applied
 * instead of the legacy `slide-out` class that used max-height transitions.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

// We test the component via its public API — the internal CSS class is
// implementation detail, but we specifically assert `slide-out-row` (not
// `slide-out`) to guard against regression of the Safari fix.

// Import the component from the top-level components/ folder.
// The path alias is not configured for these, so we use a relative path.
import SlideOutRow from '../../../components/SlideOutRow';

describe('SlideOutRow (#551 — Safari animation fix)', () => {
  it('renders children without slide-out-row class initially', () => {
    render(
      <SlideOutRow>
        <span data-testid="child">content</span>
      </SlideOutRow>
    );
    const child = screen.getByTestId('child');
    // The wrapping div should NOT have the animation class before withdrawal
    expect(child.parentElement?.className).not.toContain('slide-out-row');
  });

  it('applies slide-out-row (not slide-out) when withdraw is called', () => {
    render(
      <SlideOutRow>
        {(withdraw) => (
          <button data-testid="withdraw-btn" onClick={withdraw}>
            Withdraw
          </button>
        )}
      </SlideOutRow>
    );

    const btn = screen.getByTestId('withdraw-btn');
    fireEvent.click(btn);

    // After clicking, the wrapper should have the Safari-safe class
    expect(btn.parentElement?.className).toContain('slide-out-row');
    // Critically: the old max-height-based class must NOT be used
    expect(btn.parentElement?.className).not.toContain('slide-out ');
    expect(btn.parentElement?.className).not.toBe('slide-out');
  });

  it('applies will-change: transform on the wrapper when sliding', () => {
    render(
      <SlideOutRow>
        {(withdraw) => (
          <button data-testid="withdraw-btn" onClick={withdraw}>
            Withdraw
          </button>
        )}
      </SlideOutRow>
    );

    const btn = screen.getByTestId('withdraw-btn');
    fireEvent.click(btn);

    expect(btn.parentElement?.style.willChange).toBe('transform, opacity');
  });

  it('calls onRemoved after animation ends', () => {
    const onRemoved = vi.fn();
    render(
      <SlideOutRow onRemoved={onRemoved}>
        {(withdraw) => (
          <button data-testid="withdraw-btn" onClick={withdraw}>
            Withdraw
          </button>
        )}
      </SlideOutRow>
    );

    const btn = screen.getByTestId('withdraw-btn');
    fireEvent.click(btn);
    fireEvent.animationEnd(btn.parentElement!);

    expect(onRemoved).toHaveBeenCalledTimes(1);
  });

  it('renders non-function children without triggering withdrawal', () => {
    render(
      <SlideOutRow>
        <span data-testid="static">static content</span>
      </SlideOutRow>
    );
    expect(screen.getByTestId('static')).toBeTruthy();
  });
});
