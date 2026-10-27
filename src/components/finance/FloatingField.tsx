import { ReactNode } from 'react';

/**
 * FloatingField — Standardized Google Forms-style label-above-input field.
 *
 * Renders a crisp label on its own line above the control box, eliminating
 * floating label collisions with input values, placeholders, and date pickers.
 * Control height is compact (32–34px), with clean borders and subtle focus rings.
 */

interface FloatingFieldProps {
  label: string;
  /** Retained for API compatibility */
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
  /** Retained for API compatibility */
  staticLabel?: boolean;
  /** Use auto-height (textarea) mode instead of fixed 34px. */
  textarea?: boolean;
  children: ReactNode;
}

export function FloatingField({
  label, required, error, hint, right, prefix, span = 6, textarea = false, children,
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

  return (
    <div className={`${spanClass} min-w-0 flex flex-col`}>
      <label className="floating-label block text-[11px] font-medium text-gray-700 mb-1 leading-tight select-none">
        <span className="truncate">
          {label}{required && <span className="text-red-500 ml-0.5">*</span>}
        </span>
      </label>
      <div
        className={`floating-field relative border border-gray-300 rounded-md bg-white transition-colors focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500 flex items-stretch ${
          textarea ? 'min-h-[60px] h-auto' : 'h-[32px] sm:h-[34px]'
        } ${error ? '!border-red-500 focus-within:!ring-red-500' : ''}`}
      >
        {prefix && <div className="floating-adornment floating-prefix">{prefix}</div>}
        <div className="floating-control flex-1 min-w-0 flex items-center h-full">
          {children}
        </div>
        {right && <div className="floating-adornment">{right}</div>}
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
  'w-full h-full px-2.5 py-1 text-xs bg-transparent border-0 rounded-none outline-none focus:outline-none focus:ring-0 placeholder:text-gray-400 text-gray-900';

export const FLOAT_TEXTAREA =
  'w-full h-full px-2.5 py-1.5 text-xs bg-transparent border-0 rounded-none outline-none focus:outline-none focus:ring-0 placeholder:text-gray-400 text-gray-900 resize-none';
