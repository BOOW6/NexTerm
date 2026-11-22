import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';

function Bomb({ active }: { active: boolean }): React.JSX.Element {
  if (active) {
    throw new Error('panel exploded');
  }
  return <p>fine</p>;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('ErrorBoundary', () => {
  it('renders children while nothing throws', () => {
    render(
      <ErrorBoundary label="test">
        <Bomb active={false} />
      </ErrorBoundary>
    );
    expect(screen.getByText('fine')).toBeTruthy();
  });

  it('shows the fallback instead of crashing the whole tree', () => {
    render(
      <ErrorBoundary label="test">
        <Bomb active={true} />
      </ErrorBoundary>
    );
    // The boundary must contain the failure (role=alert) rather than letting
    // React unmount the entire root.
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('panel exploded')).toBeTruthy();
    // Both recovery actions are present (copy is locale-dependent).
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });
});
