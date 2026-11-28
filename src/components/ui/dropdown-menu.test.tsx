import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DropdownMenu, type MenuItem } from './dropdown-menu';

const items: MenuItem[] = [
  { label: 'First', onSelect: vi.fn() },
  { label: 'Second', onSelect: vi.fn() },
  { label: 'Disabled', onSelect: vi.fn(), disabled: true }
];

describe('DropdownMenu', () => {
  it('exposes its label and selectable items, then closes after selection', async () => {
    render(<DropdownMenu label="Transfer options" items={items} />);

    const trigger = screen.getByRole('button', { name: 'Transfer options' });
    fireEvent.click(trigger);

    const first = await screen.findByRole('menuitem', { name: 'First' });
    await waitFor(() => expect(document.activeElement).toBe(first));

    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Second' }));

    fireEvent.click(screen.getByRole('menuitem', { name: 'Second' }));
    expect(items[1].onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('returns focus to the trigger on Escape', async () => {
    render(<DropdownMenu label="More actions" items={items} />);

    const trigger = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(trigger);

    const first = await screen.findByRole('menuitem', { name: 'First' });
    await waitFor(() => expect(document.activeElement).toBe(first));

    fireEvent.keyDown(first, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
