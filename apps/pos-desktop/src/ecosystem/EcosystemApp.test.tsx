import { afterEach, describe, expect, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { EcosystemApp } from './EcosystemApp';

afterEach(async () => {
  await act(async () => { cleanup(); });
});

describe('EcosystemApp', () => {
  test('boots on POS with persona switcher and order line', () => {
    render(<EcosystemApp />);
    expect(screen.getByRole('region', { name: /Order line/ })).toBeDefined();
    expect(screen.getByRole('tab', { name: /POS/ })).toBeDefined();
  });
  test('switches to all four personas', () => {
    render(<EcosystemApp />);
    const eco = screen.getByTestId('ecosystem');
    fireEvent.click(within(eco).getByRole('tab', { name: /Staff/ }));
    expect(screen.getByText(/Clock In/)).toBeDefined();
    fireEvent.click(within(eco).getByRole('tab', { name: /Manager/ }));
    expect(screen.getByRole('tab', { name: 'Orders' })).toBeDefined();
    fireEvent.click(within(eco).getByRole('tab', { name: /CEO/ }));
    expect(screen.getByText(/Good morning, Sarun/)).toBeDefined();
  });
  test('staff clock-in reveals task card and completes an order', () => {
    render(<EcosystemApp />);
    const eco = screen.getByTestId('ecosystem');
    fireEvent.click(within(eco).getByRole('tab', { name: /Staff/ }));
    fireEvent.click(screen.getByRole('button', { name: /Clock In Now/ }));
    const done = screen.getAllByRole('button', { name: /Done/ })[0]!;
    fireEvent.click(done);
    expect(screen.getByRole('status')).toBeDefined();
  });
  test('POS add-to-cart and place order opens confirmation', () => {
    render(<EcosystemApp />);
    fireEvent.click(screen.getAllByRole('button', { name: /Add to Dish/ })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /Place Order/ }));
    expect(screen.getByText(/confirmed/)).toBeDefined();
  });
});
