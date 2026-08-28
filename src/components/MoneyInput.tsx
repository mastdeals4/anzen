import { forwardRef, useEffect, useRef, useState } from 'react';
import {
  formatIndonesianMoneyInput,
  parseIndonesianMoneyInput,
  parseIndonesianNumber,
} from '../utils/currency';

/**
 * Indonesian locale-aware currency input.
 *
 * While focused, the user's draft is preserved exactly so intermediate values
 * such as `55.359.075,` remain typeable. The numeric value is still emitted on
 * every valid edit for calculations. On blur, the draft is normalized to the
 * Indonesian display format (`55.359.075,50`).
 */

interface MoneyInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'inputMode'> {
  value: number | null | undefined;
  onChange: (n: number) => void;
  /** Show empty instead of zero. Default true. */
  hideZero?: boolean;
  /** Allow an Indonesian decimal comma. Currency inputs default to true. */
  decimal?: boolean;
  /** Decimal digits shown after blur. Defaults to 2 for currency. */
  minimumFractionDigits?: number;
  /** Maximum decimal precision retained in the display. Defaults to 2. */
  maximumFractionDigits?: number;
}

function displayValue(
  value: number | null | undefined,
  hideZero: boolean,
  decimal: boolean,
  minimumFractionDigits: number,
  maximumFractionDigits: number,
): string {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || (hideZero && numeric === 0)) return '';
  return formatIndonesianMoneyInput(numeric, decimal, minimumFractionDigits, maximumFractionDigits);
}

function finiteBound(bound: string | number | undefined): number | null {
  if (bound === undefined || bound === '') return null;
  const parsed = Number(bound);
  return Number.isFinite(parsed) ? parsed : null;
}

export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput(
  {
    value,
    onChange,
    hideZero = true,
    decimal = true,
    minimumFractionDigits = 2,
    maximumFractionDigits = 2,
    className = '',
    onFocus,
    onBlur,
    min,
    max,
    ...rest
  },
  ref,
) {
  const focusedRef = useRef(false);
  const [draft, setDraft] = useState(() => displayValue(
    value,
    hideZero,
    decimal,
    minimumFractionDigits,
    maximumFractionDigits,
  ));

  const clamp = (amount: number): number => {
    const minimum = finiteBound(min);
    const maximum = finiteBound(max);
    let result = decimal ? amount : Math.round(amount);
    if (minimum !== null) result = Math.max(minimum, result);
    if (maximum !== null) result = Math.min(maximum, result);
    return result;
  };

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(displayValue(value, hideZero, decimal, minimumFractionDigits, maximumFractionDigits));
    }
  }, [value, hideZero, decimal, minimumFractionDigits, maximumFractionDigits]);

  const commitDraft = (nextDraft: string, normalizeDisplay: boolean) => {
    const parsed = parseIndonesianMoneyInput(nextDraft, decimal);
    if (parsed === null) return false;
    const normalized = clamp(parsed);
    onChange(normalized);
    if (normalizeDisplay) {
      setDraft(displayValue(normalized, hideZero, decimal, minimumFractionDigits, maximumFractionDigits));
    }
    return true;
  };

  return (
    <input
      {...rest}
      ref={ref}
      type="text"
      inputMode={decimal ? 'decimal' : 'numeric'}
      value={draft}
      onFocus={(event) => {
        focusedRef.current = true;
        onFocus?.(event);
      }}
      onBlur={(event) => {
        focusedRef.current = false;
        if (!commitDraft(draft, true)) {
          setDraft(displayValue(value, hideZero, decimal, minimumFractionDigits, maximumFractionDigits));
        }
        onBlur?.(event);
      }}
      onPaste={(event) => {
        const pasted = event.clipboardData.getData('text');
        if (!pasted || !/\d/.test(pasted)) return;
        event.preventDefault();
        let parsed = parseIndonesianNumber(pasted);
        if (!decimal) parsed = Math.round(parsed);
        const normalized = clamp(parsed);
        setDraft(formatIndonesianMoneyInput(
          normalized,
          decimal,
          minimumFractionDigits,
          maximumFractionDigits,
        ));
        onChange(normalized);
      }}
      onChange={(event) => {
        const nextDraft = event.currentTarget.value;
        // Locale separators are valid draft characters. Invalid characters or
        // a second comma are rejected without disturbing the current draft.
        if (nextDraft !== '' && parseIndonesianMoneyInput(nextDraft, decimal) === null) return;
        setDraft(nextDraft);
        commitDraft(nextDraft, false);
      }}
      className={className}
    />
  );
});
