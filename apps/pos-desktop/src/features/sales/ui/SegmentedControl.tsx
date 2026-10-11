/**
 * SegmentedControl — ONE control for every exclusive choice on the till.
 *
 * LAYER: UI (presentation). It renders, and it reports intent through `onChange`.
 * It knows nothing about orders, payments or rounding: it is handed a list of
 * options and a selected value, and the screen above it decides what a selection
 * MEANS. `SalesTerminalView` passes `orderType` and `PaymentMethod` straight
 * through, so the two groups on that screen differ only in their options.
 *
 * ── WHY IT IS STILL REAL RADIOS ─────────────────────────────────────────────
 *
 * A pair of mutually exclusive choices is a radio GROUP, and `aria-pressed` on two
 * buttons would announce "these are two independent toggles that could both be
 * on". A cashier hearing that cannot tell whether the customer is seated or is
 * taking the order away. So this keeps `<fieldset>` + `<legend>` + real
 * `<input type="radio">`, the shape both call sites already had, and changes only
 * how it LOOKS.
 *
 * Nothing about the semantics moves: `name`, `value`, `checked` and `onChange` are
 * exactly what they were, which is why `SalesTerminalView`'s `orderType` state
 * and its `PaymentMethod` state need no wrapper at all.
 *
 * ── WHY THE RADIO IS CLIPPED RATHER THAN GONE ────────────────────────────────
 *
 * `.segmented-control__input` is the visually-hidden clip recipe, NOT
 * `display: none`. A hidden radio is still focusable, still in the accessibility
 * tree, and still the target of a click — which matters twice over here:
 *
 *   • Tab must reach the group, and the arrow keys must work on it.
 *   • The existing tests fire clicks straight at the input by `data-testid`.
 *     An input removed from the layout stops dispatching anything, and those
 *     tests would fail on a component that works perfectly in a browser.
 *
 * It is 1x1px and clipped rather than sized to zero so it cannot overflow the
 * well, and it is placed BEFORE the label text so a click on the text hits the
 * input as well — though the whole option is a tap target regardless.
 *
 * ── WHY THE SELECTED PILL IS A SLIDING THUMB ────────────────────────────────
 *
 * One element carries the selection and moves between the options with
 * `transform`, rather than each option painting its own selected background. The
 * difference is not decoration: with per-option backgrounds, the selection
 * APPEARS and DISAPPEARS, and on a till the eye is not on the control — it is on
 * the customer or the next tile. A pill that slides answers "which one is
 * selected?" from peripheral vision alone, because something visibly moved there.
 *
 * `transform` specifically, never `left`/`margin`: animating a layout property
 * re-runs layout for the element on every frame, and this is a control that
 * changes on every press.
 *
 * @see ./styles/segmented-control.css — the well, the thumb, and the clip
 */

import { useCallback, useRef } from 'react';
import type { JSX, KeyboardEvent } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

/** One selectable option. `value` is what `onChange` reports, verbatim. */
export interface SegmentedControlOption<TValue extends string> {
  /**
   * The value reported on selection, and the radio's own `value`.
   *
   * Generic and unconstrained on purpose: a caller passes `'takeaway'` or
   * `'promptpay'` straight through and gets them back typed, so this component
   * never has to know the vocabulary it is being used to edit.
   */
  readonly value: TValue;
  /** The visible Thai label — also the radio's accessible name. */
  readonly label: string;
}

export interface SegmentedControlProps<TValue extends string> {
  /**
   * The radio group's `name`. MUST be unique per group on the page: two groups
   * sharing a name become ONE group in the browser, and arrow keys would jump
   * from the fulfilment pair into the payment pair.
   */
  readonly name: string;
  /**
   * The group's visible name, rendered as the `<legend>`. Also the fieldset's
   * accessible name, which is why it is a `<legend>` and not an `aria-label`.
   */
  readonly legend: string;
  /**
   * Clip the legend instead of showing it. For a group sitting inside a panel
   * that already names itself — the fulfilment pair sits under the rail's basket
   * with nothing above it, while the payment group has to say what the three
   * chips are to a new cashier.
   */
  readonly hideLegend?: boolean;
  /** The options, in display order. Two to five. */
  readonly options: readonly SegmentedControlOption<TValue>[];
  /** Which option is selected. The caller owns this; this never stores it. */
  readonly value: TValue;
  /** Reports the newly selected option's `value`. The caller's state moves. */
  readonly onChange: (value: TValue) => void;
  /** Disables the WHOLE group, not one option. */
  readonly disabled?: boolean;
  /**
   * Extra class on the `<fieldset>`, for the SCREEN's own arrangement (a margin
   * that positions this group inside its panel). Deliberately not a style prop:
   * under the webview's `csp: "default-src 'self'"` an inline `style` attribute
   * compiles, typechecks, and renders nothing.
   */
  readonly className?: string;
  /**
   * Prefix for each radio's `data-testid`, so the existing
   * `fulfilment-dine_in` / `payment-cash` handles keep resolving.
   */
  readonly testIdPrefix?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The bound, and why it is loud
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The most options the sliding thumb is drawn for.
 *
 * A thumb one column wide that moves `translateX(n × 100%)` needs a rule per
 * option position, and there are five of them in the stylesheet. A sixth option
 * would silently render with NO thumb — a group whose selected state is invisible
 * — which is exactly the kind of defect that ships because nothing threw. So the
 * bound is enforced here, where it can be read.
 *
 * Five is two groups' worth of headroom over the two and three the terminal has
 * today; raising it means adding one rule per new position, nothing else.
 */
const MAX_OPTIONS = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function SegmentedControl<TValue extends string>({
  name,
  legend,
  hideLegend = false,
  options,
  value,
  onChange,
  disabled = false,
  className,
  testIdPrefix,
}: SegmentedControlProps<TValue>): JSX.Element {
  if (options.length > MAX_OPTIONS) {
    // Thrown during render rather than clamped. A silent clamp would drop options
    // the caller believes are selectable, and the cashier would be told an option
    // exists by a screen that cannot choose it.
    throw new Error(
      `SegmentedControl "${name}" was given ${options.length} options; the sliding pill is drawn for at most ${MAX_OPTIONS}.`,
    );
  }

  /**
   * The radios themselves, so the arrow keys can move FOCUS as well as
   * selection.
   *
   * Focus is not optional here: a radio group whose arrows change the value
   * without moving focus would have the next keypress typed at a control the
   * user is no longer on, and `:focus-visible` would be drawing its ring on an
   * option that is no longer selected.
   */
  const inputs = useRef<(HTMLInputElement | null)[]>([]);

  /**
   * LEFT/RIGHT move the selection, wrapping at both ends.
   *
   * A radio group has standard keyboard behaviour and this is it, so it is
   * implemented here rather than left to the UA — which makes it TESTABLE, and
   * stops the control's arrow keys from depending on which webview a branch's
   * till happens to be running.
   *
   * `preventDefault()` is the load-bearing line. A browser already performs this
   * navigation as the default action of the keydown, so WITHOUT it the selection
   * would be changed twice — once here and once natively — and the two would
   * disagree at the ends of the group, where wrapping differs from clamping.
   * Suppressing the default leaves this handler as the only one moving.
   */
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLFieldSetElement>) => {
      const forward = event.key === 'ArrowRight';
      const backward = event.key === 'ArrowLeft';

      if (!forward && !backward) return;
      if (disabled) return;

      event.preventDefault();

      const current = options.findIndex((option) => option.value === value);
      if (current < 0) return;

      const step = forward ? 1 : -1;
      const nextIndex = (current + step + options.length) % options.length;
      const next = options[nextIndex];
      if (next === undefined) return;

      inputs.current[nextIndex]?.focus();
      onChange(next.value);
    },
    [disabled, onChange, options, value],
  );

  // The clip recipe lives in `segmented-control.css`; only the class is set here.
  const fieldsetClass = ['segmented-control', className].filter(Boolean).join(' ');

  return (
    <fieldset className={fieldsetClass} disabled={disabled} onKeyDown={handleKeyDown}>
      <legend
        className={
          hideLegend
            ? 'segmented-control__legend segmented-control__legend--clipped'
            : 'segmented-control__legend segmented-control__legend--shown'
        }
      >
        {legend}
      </legend>

      {/*
       * THE WELL, and the only wrapper between the fieldset and the options.

       * The `<fieldset>` itself is deliberately borderless and transparent: the
       * pill you see is this element, so a visible legend sits ABOVE the pill
       * rather than being swallowed by a 999px radius around it.
       */}
      <div className="segmented-control__well">
        {options.map((option, index) => (
          <label key={option.value} className="segmented-control__option">
            <input
              ref={(element) => {
                inputs.current[index] = element;
              }}
              className="segmented-control__input"
              type="radio"
              name={name}
              value={option.value}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
              data-testid={testIdPrefix === undefined ? undefined : `${testIdPrefix}-${option.value}`}
            />
            {option.label}
          </label>
        ))}

        {/*
         * The thumb, LAST in the DOM and therefore not a reading-order
         * participant — it is `aria-hidden` decoration, and the position rules
         * address options by `nth-child`, which is only true while it stays out
         * of the way of the option numbering.
         */}
        <span className="segmented-control__thumb" aria-hidden="true" />
      </div>
    </fieldset>
  );
}

export default SegmentedControl;