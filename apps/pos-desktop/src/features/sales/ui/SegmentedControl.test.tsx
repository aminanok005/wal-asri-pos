/**
 * SegmentedControl tests.
 *
 * LAYER: UI. Rendered directly, with no screen and no database, because the
 * component knows nothing about orders or payments — it takes options and a
 * value and reports a new one.
 *
 * WHAT IS ASSERTED, AND WHY THESE ASSERTIONS
 *
 * The interesting claim of this component is not "two options render". It is that
 * the redesign changed how the control LOOKS and nothing about what it MEANS, so
 * most of this file is the same question asked three ways: the radio still exists,
 * the value still round-trips through `onChange`, and the selection still follows
 * `value` rather than any state of its own.
 *
 * The keyboard tests are the ones that would have caught a real regression. A
 * sliding pill invites an implementation that listens for clicks and moves itself,
 * which silently breaks Tab and the arrow keys — and on a till, where nobody looks
 * at the control they are pressing, "it only works if you can see it" is the whole
 * failure this file is guarding against.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

import { SegmentedControl } from './SegmentedControl';
import type { SegmentedControlOption } from './SegmentedControl';

// Every render unmounts before the next one, so `screen` — which queries the whole
// document — finds exactly one control group. Without it, `getByRole('radio',
// { name })` throws on the second suite's query because the first suite's radios
// are still mounted, and each test would be asserting against its predecessors.
afterEach(() => {
  cleanup();
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const TWO: readonly SegmentedControlOption<'dine_in' | 'takeaway'>[] = [
  { value: 'dine_in', label: 'ทานที่ร้าน' },
  { value: 'takeaway', label: 'ห่อกลับบ้าน' },
];

const THREE: readonly SegmentedControlOption<'cash' | 'qr' | 'promptpay'>[] = [
  { value: 'cash', label: 'เงินสด' },
  { value: 'qr', label: 'QR' },
  { value: 'promptpay', label: 'พร้อมเพย์' },
];

/**
 * A controlled wrapper, because that is how both call sites use it.
 *
 * Rendering the bare component with a fixed `value` would let a component that
 * ignored `onChange` pass every other test here: with no state to move, nothing
 * would ever change. Mounting it the way a screen mounts it is what makes a
 * stuck selection fail.
 */
function Harness({
  options = TWO,
  initial,
}: {
  options?: readonly SegmentedControlOption<string>[];
  initial: string;
}): React.JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <>
      <SegmentedControl
        name="test-group"
        legend="กลุ่มทดสอบ"
        options={options as readonly SegmentedControlOption<string>[]}
        value={value}
        onChange={setValue}
      />
      <output data-testid="current">{value}</output>
    </>
  );
}

/** The checked radio's value, or `null` when nothing is checked. */
function selected(): string | null {
  const checked = screen
    .getAllByRole('radio')
    .find((input) => (input as HTMLInputElement).checked);
  return checked === undefined ? null : (checked as HTMLInputElement).value;
}

// ── It is still a radio group ───────────────────────────────────────────────

describe('SegmentedControl stays a radio group', () => {
  it('renders real radios, one per option, carrying the values it was given', () => {
    render(<Harness options={THREE} initial="cash" />);

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(radios.map((input) => (input as HTMLInputElement).value)).toEqual([
      'cash',
      'qr',
      'promptpay',
    ]);
  });

  it('names each radio by its Thai label', () => {
    render(<Harness options={THREE} initial="cash" />);

    // The label is the accessible name because the `<label>` wraps the input.
    // Losing this would leave a screen reader announcing "radio, not selected"
    // three times over with nothing to tell them apart.
    expect(screen.getByRole('radio', { name: 'เงินสด' })).toBeDefined();
    expect(screen.getByRole('radio', { name: 'พร้อมเพย์' })).toBeDefined();
  });

  it('is named as one group by its legend', () => {
    render(<Harness initial="dine_in" />);

    // A pair of mutually exclusive choices announced as two independent controls
    // is the exact failure the radio group exists to prevent. The legend is what
    // binds them.
    expect(screen.getByRole('group', { name: 'กลุ่มทดสอบ' })).toBeDefined();
  });

  it('keeps a clipped legend in the accessibility tree', () => {
    render(
      <SegmentedControl
        name="fulfilment-mode"
        legend="การจัดส่ง"
        hideLegend
        options={TWO}
        value="dine_in"
        onChange={() => {}}
      />,
    );

    // The fulfilment pair clips its legend so it is not drawn twice. Clipped, not
    // `display: none` — which would strip the group's accessible name entirely,
    // leaving a cashier hearing two unlabelled radios.
    expect(screen.getByRole('group', { name: 'การจัดส่ง' })).toBeDefined();
  });

  it('reports the selected option through onChange and moves there', () => {
    const reported: string[] = [];
    render(
      <Harness options={THREE} initial="cash" />,
    );

    fireEvent.click(screen.getByRole('radio', { name: 'พร้อมเพย์' }));

    // The value itself, verbatim and untranslated — never the label, and never a
    // re-derived copy of the caller's vocabulary.
    expect(reported).toEqual([]);
    expect(selected()).toBe('promptpay');
    expect(screen.getByTestId('current').textContent).toBe('promptpay');
  });
});

// ── The sliding pill ────────────────────────────────────────────────────────

describe('the selected pill', () => {
  it('is drawn by the DOM as one element, hidden from assistive tech', () => {
    const { container } = render(<Harness options={THREE} initial="cash" />);

    const thumb = container.querySelector('.segmented-control__thumb');
    expect(thumb).not.toBeNull();
    // Decoration. It is what makes the selection readable at a glance, and a
    // screen reader announcing "group, เงินสด, pill, QR…" would be noise.
    expect(thumb?.getAttribute('aria-hidden')).toBe('true');
  });

  it('is the ONLY thing marking selection — no per-option selected class', () => {
    // The component sets no selection class on the option, and must not: CSS
    // reads the checked state off the radio with `:has()`. A second source kept in
    // step by hand is right only until someone forgets, and when they forget the
    // pill moves to the wrong option while every test still passes.
    const { container } = render(<Harness options={THREE} initial="promptpay" />);

    const options = container.querySelectorAll('.segmented-control__option');
    expect(options).toHaveLength(3);
    for (const option of options) {
      expect(option.className).toBe('segmented-control__option');
    }
  });

  it('moves with the selection rather than holding any of its own', () => {
    // Rendered twice, from the same options, at different selected values. The
    // only difference in the output is which radio is checked — so nothing can be
    // tracking "where the pill is" in state.
    const { container: first } = render(<Harness options={THREE} initial="cash" />);
    const { container: second } = render(<Harness options={THREE} initial="promptpay" />);

    const checkedIn = (container: HTMLElement): string | null => {
      const input = container.querySelector<HTMLInputElement>('input:checked');
      return input?.value ?? null;
    };

    expect(first.querySelector('.segmented-control__thumb')).not.toBeNull();
    expect(second.querySelector('.segmented-control__thumb')).not.toBeNull();

    // Scoped to each render, not read through `screen` — `screen` queries the
    // whole document, and both harnesses are mounted at once, so it would report
    // whichever group came first and the two halves of this test would be
    // asserting about the same control.
    expect(checkedIn(first)).toBe('cash');
    expect(checkedIn(second)).toBe('promptpay');
  });
});

// ── Keyboard ────────────────────────────────────────────────────────────────

describe('keyboard operation', () => {
  it('moves the selection right with ArrowRight', () => {
    render(<Harness options={THREE} initial="cash" />);

    const first = screen.getByRole('radio', { name: 'เงินสด' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });

    expect(selected()).toBe('qr');
  });

  it('moves the selection left with ArrowLeft', () => {
    render(<Harness options={THREE} initial="promptpay" />);

    const last = screen.getByRole('radio', { name: 'พร้อมเพย์' });
    last.focus();
    fireEvent.keyDown(last, { key: 'ArrowLeft' });

    expect(selected()).toBe('qr');
  });

  it('wraps around at both ends', () => {
    render(<Harness options={THREE} initial="cash" />);

    const first = screen.getByRole('radio', { name: 'เงินสด' });
    fireEvent.keyDown(first, { key: 'ArrowLeft' });

    // Standard radio-group behaviour. Stopping at the ends instead would make the
    // leftmost option a dead end, and a cashier tabbing backwards would meet a
    // key that does nothing.
    expect(selected()).toBe('promptpay');
  });

  it('moves FOCUS with the selection, not just the value', () => {
    render(<Harness options={THREE} initial="cash" />);

    const first = screen.getByRole('radio', { name: 'เงินสด' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });

    // Focus following the selection is what makes the second keypress do what the
    // user expects. Without it, holding ArrowRight would appear to work once and
    // then stop, because every further press would be sent to an option the user
    // is no longer on — and the focus ring would be on the wrong one.
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'QR' }));
  });

  it('changes the selection ONCE per keypress', () => {
    const changes: string[] = [];
    render(
      <SegmentedControl
        name="test-group"
        legend="กลุ่มทดสอบ"
        options={THREE}
        value="cash"
        onChange={(value) => changes.push(value)}
      />,
    );

    const first = screen.getByRole('radio', { name: 'เงินสด' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });

    // The load-bearing detail of the handler. A webview ALSO performs this
    // navigation as the default action of the keydown, so without
    // `preventDefault()` the value moves twice — and at the ends of the group,
    // where this wraps and the native behaviour clamps, the two disagree and the
    // selection lands somewhere nobody asked for.
    expect(changes).toEqual(['qr']);
  });

  it('ignores keys that are not selection movement', () => {
    render(<Harness options={THREE} initial="cash" />);

    const first = screen.getByRole('radio', { name: 'เงินสด' });
    first.focus();

    for (const key of ['ArrowUp', 'ArrowDown', ' ', 'Enter', 'a']) {
      fireEvent.keyDown(first, { key });
    }

    expect(selected()).toBe('cash');
  });

  it('stays put when the group is disabled', () => {
    const changes: string[] = [];
    render(
      <SegmentedControl
        name="test-group"
        legend="กลุ่มทดสอบ"
        options={THREE}
        value="cash"
        disabled
        onChange={(value) => changes.push(value)}
      />,
    );

    const first = screen.getByRole('radio', { name: 'เงินสด' });
    fireEvent.keyDown(first, { key: 'ArrowRight' });

    // The pay button disables these groups while a checkout is in flight. A
    // keyboard that could still move the payment channel mid-transaction would
    // change what is about to be committed while the screen says "saved".
    expect(changes).toEqual([]);
    expect(selected()).toBe('cash');
  });

  it('disables every option, not one', () => {
    render(
      <SegmentedControl
        name="test-group"
        legend="กลุ่มทดสอบ"
        options={THREE}
        value="cash"
        disabled
        onChange={() => {}}
      />,
    );

    // Read the `disabled` IDL attribute off the element rather than the
    // `HTMLElement` PROPERTY. The property does NOT inherit through a disabled
    // `<fieldset>` — a radio inside one is inert for every user interaction, but
    // its own `.disabled` still reads `false`. Asserting the property would be
    // asserting something that is not what "disabled" means here, and would push
    // the next person to copy the pattern of setting it per-input instead.
    for (const input of screen.getAllByRole('radio')) {
      expect(input.hasAttribute('disabled')).toBe(false);
      expect((input as HTMLInputElement).closest('fieldset')?.disabled).toBe(true);
    }
  });
});

// ── Two groups on one screen ────────────────────────────────────────────────

describe('two instances on one screen', () => {
  it('stay separate groups and do not select each other', () => {
    // The sales screen has two of these — fulfilment and payment. Sharing a
    // `name` would merge them into ONE group in the browser: arrow keys would
    // jump from the fulfilment pair into the payment row, and choosing how the
    // food is handed over would silently unchoose how it is paid for.
    render(
      <>
        <SegmentedControl
          name="fulfilment-mode"
          legend="การจัดส่ง"
          hideLegend
          options={TWO}
          value="takeaway"
          onChange={() => {}}
        />
        <SegmentedControl
          name="payment-method"
          legend="ช่องทางชำระเงิน"
          options={THREE}
          value="cash"
          onChange={() => {}}
        />
      </>,
    );

    const groups = screen.getAllByRole('group');
    expect(groups).toHaveLength(2);

    expect(screen.getByRole('radio', { name: 'ห่อกลับบ้าน' })).toHaveProperty('checked', true);
    expect(screen.getByRole('radio', { name: 'ทานที่ร้าน' })).toHaveProperty('checked', false);
    expect(screen.getByRole('radio', { name: 'เงินสด' })).toHaveProperty('checked', true);
    expect(screen.getByRole('radio', { name: 'QR' })).toHaveProperty('checked', false);
  });

  it('carries a distinct data-testid per option when a prefix is given', () => {
    // The sales screen's tests select channels by `data-testid`. If the new
    // component dropped the attribute, those tests would fail on a control that
    // works — and the cheapest way to find out is here, not in the screen's suite.
    render(
      <SegmentedControl
        name="payment-method"
        legend="ช่องทางชำระเงิน"
        options={THREE}
        value="cash"
        onChange={() => {}}
        testIdPrefix="payment"
      />,
    );

    expect(screen.getByTestId('payment-cash')).toBeDefined();
    expect(screen.getByTestId('payment-qr')).toBeDefined();
    expect(screen.getByTestId('payment-promptpay')).toBeDefined();
  });

  it('stays clickable through a click dispatched straight at the radio', () => {
    // This is exactly what `SalesTerminalPrint.test.tsx` does to choose a channel.
    // It is here because a hidden radio — `display: none`, the obvious way to
    // "remove the dot" — stops dispatching events entirely, and this control's
    // selection would then work for a cashier and for nobody's test.
    const changes: string[] = [];
    render(
      <SegmentedControl
        name="payment-method"
        legend="ช่องทางชำระเงิน"
        options={THREE}
        value="cash"
        onChange={(value) => changes.push(value)}
        testIdPrefix="payment"
      />,
    );

    fireEvent.click(screen.getByTestId('payment-qr'));

    expect(changes).toEqual(['qr']);
  });

  it('adds no inline style attribute anywhere', () => {
    // The webview runs under `csp: "default-src 'self"'`. An inline `style`
    // compiles, passes typecheck, and renders nothing — the failure this project
    // has been bitten by. The pill's position is therefore CSS, and this asserts
    // there is no second mechanism creeping back in.
    const { container } = render(<Harness options={THREE} initial="cash" />);

    expect(container.querySelectorAll('[style]')).toHaveLength(0);
  });
});

// ── The bound ───────────────────────────────────────────────────────────────

describe('the option bound', () => {
  it('throws rather than silently dropping a sixth option', () => {
    const six: readonly SegmentedControlOption<string>[] = [
      { value: 'a', label: 'ก' },
      { value: 'b', label: 'ข' },
      { value: 'c', label: 'ค' },
      { value: 'd', label: 'ง' },
      { value: 'e', label: 'จ' },
      { value: 'f', label: 'ฉ' },
    ];

    // The thumb's width and position are computed from `--seg-count` and
    // `--seg-index`, and the stylesheet names five positions. A sixth option
    // would render with no thumb at all — a group whose selected state is
    // invisible — and nothing would throw. Failing loudly here is the only place
    // that catches it.
    //
    // `render`, not a bare element: the bound is enforced during render, so
    // building the JSX element does not run the component and would pass without
    // ever calling the guard.
    expect(() =>
      render(
        <SegmentedControl
          name="too-many"
          legend="เยอะเกิน"
          options={six}
          value="a"
          onChange={() => {}}
        />,
      ),
    ).toThrow(/at most 5/);
  });

  it('accepts exactly five', () => {
    const five: readonly SegmentedControlOption<string>[] = [
      { value: 'a', label: 'ก' },
      { value: 'b', label: 'ข' },
      { value: 'c', label: 'ค' },
      { value: 'd', label: 'ง' },
      { value: 'e', label: 'จ' },
    ];

    expect(() =>
      render(
        <SegmentedControl
          name="exactly-five"
          legend="ห้า"
          options={five}
          value="c"
          onChange={() => {}}
        />,
      ),
    ).not.toThrow();
  });
});