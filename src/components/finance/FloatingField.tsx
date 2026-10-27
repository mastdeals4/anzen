import { ReactNode } from 'react';

/**
 * FloatingField — Google-style outlined floating-label field, scoped to the
 * Expense modal. NOT a replacement for SapField; other finance modules keep
 * their existing label-above-input layout.
 *
 * Behaviour
 *   • Empty + unfocused → label sits centered inside the outlined field.
 *   • Focused            → border highlights blue, label floats into a notch
 *                          in the top border (opaque background masks the line).
 *   • Filled             → label stays in the top notch, value visible below.
 *   • Cleared + blurred  → label drops back inside.
 *
 * The "filled" state is controlled by the parent (it knows the value for every
 * child type: text input, native select, MoneyInput, SearchableSelect, date).
 * Focus is detected via :focus-within on the wrapper, so the parent never needs
 * to track focus.
 *
 * Sizing (from the compact-expense brief): 34px target / 36px max field height,
 * 12px value text, 10–11px label, ~8px horizontal padding.
 */

interface FloatingFieldProps {
  label: string;
  /** True when the field has a non-empty value (parent-controlled). */
  filled?: boolean;
  required?: boolean;
  error?: string;
  hint?: string;
  /** Optional inline adornment rendered inside the field on the right. */
  right?: ReactNode;
  /** Optional inline adornment rendered inside the field on the left (prefix). */
  prefix?: ReactNode;
  /** Grid column span inside a 12-col SapRow. */
  span?: 1 | 2 | 3 | 4 | 5 | 6 | 8 | 12;
  /** Disable the floating animation (e.g. static display fields). */
  staticLabel?: boolean;
  /** Use auto-height (textarea) mode instead of fixed 34px. */
  textarea?: boolean;
  children: ReactNode;
}

export function FloatingField({
  label, filled = false, required, error, hint, right, prefix, span = 6, staticLabel = false, textarea = false, children,
}: FloatingFieldProps) {
  const spanClass =
    span === 12 ? 'sm:col-span-12'
    : span === 8 ? 'sm:col-span-8'
    : span === 6 ? 'sm:col-span-6'
    : span === 5 ? 'sm:col-span-5'
    : span === 4 ? 'sm:col-span-4'
    : span === 3 ? 'sm:col-span-3'
    : span === 2 ? 'sm:col-span-2'
    : 'sm:col-span-1';

  const stateClass = [
    'floating-field',
    filled || staticLabel ? 'is-filled' : '',
    error ? 'is-error' : '',
    staticLabel ? 'is-static' : '',
    textarea ? 'is-textarea' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={`${spanClass} min-w-0`}>
      <div className={stateClass}>
        <label className="floating-label">
          {label}{required && <span className="text-red-500 ml-0.5">*</span>}
        </label>
        <div className="floating-control">
          {prefix && <div className="floating-adornment floating-prefix">{prefix}</div>}
          {children}
          {right && <div className="floating-adornment">{right}</div>}
        </div>
      </div>
      {error ? (
        <div className="text-[10px] text-red-600 mt-0.5 leading-tight">{error}</div>
      ) : hint ? (
        <div className="text-[10px] text-gray-500 mt-0.5 leading-tight">{hint}</div>
      ) : null}
    </div>
  );
}

/**
 * Inner-input class for FloatingField. Use on native <input>/<select> and
 * MoneyInput that live inside a FloatingField. No border — the wrapper draws it.
 */
export const FLOAT_INPUT =
  'w-full h-full px-2 pt-2.5 pb-0 text-xs bg-transparent border-0 rounded-none outline-none focus:outline-none focus:ring-0 placeholder-transparent';

export const FLOAT_TEXTAREA =
  'w-full h-full px-2 pt-3.5 pb-1 text-xs bg-transparent border-0 rounded-none outline-none focus:outline-none focus:ring-0 placeholder-transparent resize-none';
