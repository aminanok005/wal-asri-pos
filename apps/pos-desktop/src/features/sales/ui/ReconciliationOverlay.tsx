import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  resolveStockConflict,
  ReconcileError,
  type ResolveConflictArgs,
  type ResolveConflictResult,
  type StockConflict,
} from '../api/reconcile';
import { parseUnitsInput, milliToDecimalString, unitsToMilli } from '../domain/milliUnits';
import { useCanResolveStockConflict } from '../access/stockConflictAccess';
import './styles/reconciliation-overlay.css';

/**
 * The three ways a manager can settle a conflict, plus the fields the form
 * collects for them. `type` is the choice; `reason` is mandatory for all; a
 * custom count is parsed and converted to milli only at submit.
 */
type ResolutionType = 'useLocal' | 'useCloud' | 'custom';

interface ReconciliationOverlayProps {
  readonly isOpen: boolean;
  /** The conflict being resolved, or `null` when nothing is selected. */
  readonly conflict: StockConflict | null;
  /**
   * The terminal performing the resolve, from `get_terminal_identity`. Passed
   * straight to the backend as the audit actor. Left `undefined` when the till
   * has no identity — an absent actor is honest, a fabricated one is not.
   */
  readonly actorTerminalId?: string | undefined;
  readonly onClose: () => void;
  /** Called after a successful resolve so the parent refetches the list. */
  readonly onResolved: () => void;
  /**
   * The resolve call. Defaults to the real `resolveStockConflict`; a test passes
   * a double so success and failure can be driven without a Tauri runtime and
   * without a global module mock (which would leak across bun test files).
   */
  readonly resolveConflict?: (args: ResolveConflictArgs) => Promise<ResolveConflictResult>;
}

/** The focusable elements the focus trap cycles through. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * ReconciliationOverlay — the modal that lets a manager settle one stock
 * conflict.
 *
 * ── WHY THE DIFF IS SHOWN IN UNITS, SENT IN MILLI ───────────────────────────
 * A manager reads "หน้าร้าน 2.500 / คลาวด์ 2.000", not "2500 vs 2000 milli".
 * The form displays the canonical decimal (`milliToDecimalString`) but sends
 * the integer milli count the contract requires. The conversion from a typed
 * decimal lives in `../domain/milliUnits` and uses `Math.round(x * 1000)` so a
 * human's "2.5" becomes exactly `2500`, never `2499.9999`.
 *
 * ── WHY CLOUD IS DISABLED, NOT GUESSED, WHEN NULL ───────────────────────────
 * `cloudQuantityMilli` is `null` when the cloud has never reported a figure.
 * The "ใช้ค่าจากคลาวด์" option is then rendered DISABLED with an explanation —
 * there is no number to copy, so offering the choice would invite a manager to
 * "accept" a value that does not exist.
 *
 * ── WHY TWO STEPS ───────────────────────────────────────────────────────────
 * Resolving overwrites a stock balance. The first step collects the decision
 * and a mandatory reason; the second is an explicit confirm that restates the
 * exact milli value about to be written. A single tap on "confirm" is how a
 * balance gets overwritten by accident.
 *
 * ── WHY A FAILURE KEEPS EVERYTHING ──────────────────────────────────────────
 * On a rejected resolve the overlay does NOT close and does NOT clear the form:
 * the manager's reason and chosen value are still valid and re-typing them is
 * exactly the friction that makes people give up. Only success advances.
 *
 * ── PERMISSION ──────────────────────────────────────────────────────────────
 * The confirm controls are rendered ONLY when `useCanResolveStockConflict()` is
 * true. Everyone else — a cashier — sees the conflict explained and the line
 * "ต้องให้ผู้จัดการดำเนินการ", with no way to submit.
 */
export const ReconciliationOverlay: React.FC<ReconciliationOverlayProps> = ({
  isOpen,
  conflict,
  actorTerminalId,
  onClose,
  onResolved,
  resolveConflict = resolveStockConflict,
}) => {
  const canResolve = useCanResolveStockConflict();

  const [type, setType] = useState<ResolutionType>('useLocal');
  const [reason, setReason] = useState('');
  const [customInput, setCustomInput] = useState('');
  const [step, setStep] = useState<'select' | 'confirm'>('select');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resolved, setResolved] = useState(false);
  /** The Thai line announced through `aria-live`. */
  const [announcement, setAnnouncement] = useState('');

  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  const cloudAvailable = conflict !== null && conflict.cloudQuantityMilli !== null;

  // Reset the whole form whenever a NEW conflict is opened. Keyed on
  // `conflict?.inventoryItemId` so switching conflicts re-primes the form, but
  // a re-render with the same conflict (e.g. a poll that changes nothing) does
  // NOT wipe a half-typed reason.
  useEffect(() => {
    if (isOpen && conflict) {
      setType('useLocal');
      setReason('');
      setCustomInput('');
      setStep('select');
      setFieldError(null);
      setSubmitError(null);
      setSubmitting(false);
      setResolved(false);
      setAnnouncement('');
    }
  }, [isOpen, conflict?.inventoryItemId]);

  // The milli value the current choice resolves to, or null when it is not yet
  // determinable (a custom box that is empty/invalid). Never guesses a cloud
  // figure that is null.
  const resolvedMilli = useMemo((): number | null => {
    if (!conflict) return null;
    if (type === 'useLocal') return conflict.localQuantityMilli;
    if (type === 'useCloud') return conflict.cloudQuantityMilli;
    const parsed = parseUnitsInput(customInput);
    if (!parsed.ok) return null;
    return unitsToMilli(parsed.units);
  }, [conflict, type, customInput]);

  // Focus management: remember what had focus, move focus into the dialog on
  // open, and restore it on close.
  useEffect(() => {
    if (!isOpen) return;
    previouslyFocused.current = document.activeElement;
    const first = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialogRef.current)?.focus();
    return () => {
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  }, [isOpen]);

  // Esc closes (unless a resolve is mid-flight), and Tab is trapped inside the
  // dialog so a keyboard user cannot tab out into the page behind the modal.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const container = dialogRef.current;
      if (!container) return;
      const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, submitting, onClose]);

  /** Validate the first step; return true when it is safe to advance. */
  const validateSelect = useCallback((): boolean => {
    if (!conflict) return false;
    if (reason.trim() === '') {
      setFieldError('กรุณากรอกเหตุผลก่อนดำเนินการ');
      return false;
    }
    if (type === 'custom') {
      const parsed = parseUnitsInput(customInput);
      if (!parsed.ok) {
        setFieldError(parsed.error);
        return false;
      }
    }
    if (type === 'useCloud' && conflict.cloudQuantityMilli === null) {
      setFieldError('ยังไม่มีค่าจากคลาวด์ให้ใช้');
      return false;
    }
    setFieldError(null);
    return true;
  }, [conflict, reason, type, customInput]);

  const goToConfirm = useCallback(() => {
    if (validateSelect()) setStep('confirm');
  }, [validateSelect]);

  const submit = useCallback(async () => {
    if (!conflict || resolvedMilli === null) return;
    if (reason.trim() === '') {
      setStep('select');
      setFieldError('กรุณากรอกเหตุผลก่อนดำเนินการ');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await resolveConflict({
        inventoryItemId: conflict.inventoryItemId,
        branchId: conflict.branchId,
        resolvedQuantityMilli: resolvedMilli,
        reason: reason.trim(),
        actorTerminalId,
      });
      setResolved(true);
      setAnnouncement('บันทึกการกระทบยอดสำเร็จ');
      // Let the parent refetch immediately; it closes the overlay when the
      // conflict list is empty.
      onResolved();
    } catch (cause: unknown) {
      // Do NOT close, do NOT clear: the manager's reason and choice stand so
      // they can retry without re-entering anything.
      const message =
        cause instanceof ReconcileError || cause instanceof Error
          ? cause.message
          : 'บันทึกไม่สำเร็จ กรุณาลองอีกครั้ง';
      setSubmitError(message);
      setAnnouncement('บันทึกการกระทบยอดไม่สำเร็จ');
    } finally {
      setSubmitting(false);
    }
  }, [conflict, resolvedMilli, reason, actorTerminalId, onResolved, resolveConflict]);

  if (!isOpen || !conflict) return null;

  const localText = milliToDecimalString(conflict.localQuantityMilli);
  const cloudText =
    conflict.cloudQuantityMilli === null ? '—' : milliToDecimalString(conflict.cloudQuantityMilli);
  const resolvedText = resolvedMilli === null ? '—' : milliToDecimalString(resolvedMilli);

  return (
    <div
      className="recon-overlay__backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="recon-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recon-title"
        aria-describedby="recon-desc"
        tabIndex={-1}
      >
        <h2 id="recon-title" className="recon-overlay__title">
          กระทบยอดสต็อก
        </h2>

        <div id="recon-desc" className="recon-overlay__diff">
          <span className="recon-overlay__item">รหัสสินค้า: {conflict.inventoryItemId}</span>
          <div className="recon-overlay__figures">
            <span className="recon-overlay__figure">
              หน้าร้าน: <b>{localText}</b>
            </span>
            <span className="recon-overlay__figure">
              คลาวด์: <b>{cloudText}</b>
            </span>
          </div>
        </div>

        {/* The status line every screen reader announces. */}
        <div className="recon-overlay__live" role="status" aria-live="polite">
          {announcement}
        </div>

        {resolved ? (
          <div className="recon-overlay__done">
            <p className="recon-overlay__done-text">บันทึกการกระทบยอดสำเร็จแล้ว</p>
            <div className="recon-overlay__actions">
              <button type="button" className="recon-btn recon-btn--primary" onClick={onClose}>
                ปิด
              </button>
            </div>
          </div>
        ) : step === 'select' ? (
          <div className="recon-overlay__body">
            <fieldset className="recon-fieldset">
              <legend className="recon-overlay__legend">เลือกค่าที่จะใช้</legend>

              <label className="recon-choice">
                <input
                  type="radio"
                  name="recon-type"
                  value="useLocal"
                  checked={type === 'useLocal'}
                  onChange={() => {
                    setType('useLocal');
                    setFieldError(null);
                  }}
                  disabled={!canResolve}
                />
                <span className="recon-choice__label">
                  ใช้ค่าหน้าร้าน ({localText})
                </span>
              </label>

              <label className={`recon-choice${cloudAvailable ? '' : ' recon-choice--disabled'}`}>
                <input
                  type="radio"
                  name="recon-type"
                  value="useCloud"
                  checked={type === 'useCloud'}
                  disabled={!cloudAvailable || !canResolve}
                  onChange={() => {
                    setType('useCloud');
                    setFieldError(null);
                  }}
                />
                <span className="recon-choice__label">
                  ใช้ค่าจากคลาวด์ ({cloudText})
                  {!cloudAvailable && (
                    <span className="recon-choice__hint">
                      {' '}
                      — ยังไม่มีค่าจากคลาวด์ให้ใช้ จึงเลือกไม่ได้
                    </span>
                  )}
                </span>
              </label>

              <label className="recon-choice">
                <input
                  type="radio"
                  name="recon-type"
                  value="custom"
                  checked={type === 'custom'}
                  onChange={() => {
                    setType('custom');
                    setFieldError(null);
                  }}
                  disabled={!canResolve}
                />
                <span className="recon-choice__label">ระบุค่าด้วยตนเอง</span>
              </label>

              {type === 'custom' && canResolve && (
                <div className="recon-custom">
                  <label className="recon-custom__label" htmlFor="recon-custom-qty">
                    ปริมาณใหม่ (หน่วย เช่น 2.5)
                  </label>
                  <input
                    id="recon-custom-qty"
                    className="recon-custom__input"
                    type="text"
                    inputMode="decimal"
                    value={customInput}
                    placeholder="0.000"
                    onChange={(event) => {
                      setCustomInput(event.target.value);
                      setFieldError(null);
                    }}
                  />
                </div>
              )}
            </fieldset>

            <div className="recon-reason">
              <label className="recon-reason__label" htmlFor="recon-reason">
                เหตุผล (จำเป็นต้องกรอกทุกครั้ง) *
              </label>
              <textarea
                id="recon-reason"
                className="recon-reason__input"
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  setFieldError(null);
                }}
                placeholder="อธิบายว่าทำไมเลือกค่านี้"
                required
                aria-required="true"
                readOnly={!canResolve}
              />
            </div>

            {fieldError && (
              <p className="recon-overlay__error" role="alert">
                {fieldError}
              </p>
            )}

            {!canResolve && (
              <p className="recon-overlay__locked" role="note">
                การกระทบยอดต้องให้ผู้จัดการดำเนินการ
              </p>
            )}

            <div className="recon-overlay__actions">
              <button
                type="button"
                className="recon-btn recon-btn--ghost"
                onClick={onClose}
                disabled={submitting}
              >
                ยกเลิก
              </button>
              {canResolve && (
                <button
                  type="button"
                  className="recon-btn recon-btn--primary"
                  onClick={goToConfirm}
                  disabled={submitting}
                >
                  ตรวจทานอีกครั้ง
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="recon-overlay__body">
            <p className="recon-overlay__confirm-lead">
              ยืนยันที่จะบันทึกปริมาณเป็น <b>{resolvedText}</b> สำหรับรหัส {conflict.inventoryItemId}
            </p>
            <p className="recon-overlay__confirm-reason">เหตุผล: {reason.trim()}</p>

            {submitError && (
              <p className="recon-overlay__error" role="alert">
                {submitError}
              </p>
            )}

            <div className="recon-overlay__actions">
              <button
                type="button"
                className="recon-btn recon-btn--ghost"
                onClick={() => setStep('select')}
                disabled={submitting}
              >
                กลับไปแก้ไข
              </button>
              <button
                type="button"
                className="recon-btn recon-btn--primary"
                onClick={() => void submit()}
                disabled={submitting}
              >
                {submitting ? 'กำลังบันทึก…' : 'ยืนยันบันทึก'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
