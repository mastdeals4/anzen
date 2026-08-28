import { ReactNode } from 'react';
import { FORM_LABEL, INPUT } from './uiTokens';

export const SAP_INPUT = INPUT;

interface SapRowProps {
  children: ReactNode;
}

export function SapRow({ children }: SapRowProps) {
  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-12">
      {children}
    </div>
  );
}

interface SapFieldProps {
  label: string;
  children: ReactNode;
  span?: number;
  required?: boolean;
  right?: ReactNode;
}

export function SapField({ label, children, span = 6, required, right }: SapFieldProps) {
  const spanClass = span === 12 ? 'sm:col-span-12'
    : span === 8 ? 'sm:col-span-8'
    : span === 6 ? 'sm:col-span-6'
    : span === 4 ? 'sm:col-span-4'
    : span === 3 ? 'sm:col-span-3'
    : span === 2 ? 'sm:col-span-2'
    : 'sm:col-span-1';
  return (
    <div className={spanClass}>
      <label className={`${FORM_LABEL} flex items-center justify-between`}>
        <span>
          {label}
          {required && <span className="text-red-500 ml-0.5">*</span>}
        </span>
        {right}
      </label>
      {children}
    </div>
  );
}
