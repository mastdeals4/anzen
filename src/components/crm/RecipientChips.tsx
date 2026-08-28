import { useState } from 'react';
import { X, Plus } from 'lucide-react';
import { isValidEmail } from '../../services/sourcingRecipients';

interface Props {
  label: string;
  emails: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * Compact chip-style email recipient editor used in the Anvi Sourcing
 * preview modal. Validates email format; click X to remove; Enter or comma
 * commits the typed address.
 */
export function RecipientChips({ label, emails, onChange, placeholder, disabled }: Props) {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  const commit = (raw: string) => {
    const value = raw.trim().replace(/,$/, '');
    if (!value) return;
    if (!isValidEmail(value)) {
      setError('Invalid email');
      return;
    }
    if (emails.includes(value)) {
      setInput('');
      return;
    }
    onChange([...emails, value]);
    setInput('');
    setError('');
  };

  const remove = (idx: number) => {
    onChange(emails.filter((_, i) => i !== idx));
  };

  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wide text-gray-500 font-medium mb-1">{label}</label>
      <div className={`flex flex-wrap gap-1 border border-gray-300 rounded px-1.5 py-1 bg-white min-h-[28px] ${disabled ? 'opacity-60' : ''}`}>
        {emails.map((e, i) => (
          <span key={i} className="inline-flex items-center gap-1 bg-blue-50 border border-blue-200 text-blue-700 text-[11px] px-1.5 py-0.5 rounded">
            {e}
            {!disabled && (
              <button onClick={() => remove(i)} className="text-blue-500 hover:text-red-500" title="Remove">
                <X className="w-3 h-3" />
              </button>
            )}
          </span>
        ))}
        <input
          disabled={disabled}
          value={input}
          onChange={e => { setInput(e.target.value); setError(''); }}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(input); }
            if (e.key === 'Backspace' && input === '' && emails.length > 0) {
              onChange(emails.slice(0, -1));
            }
          }}
          onBlur={() => input.trim() && commit(input)}
          placeholder={placeholder || 'Type email + Enter'}
          className="flex-1 min-w-[120px] text-[11px] outline-none border-none bg-transparent"
        />
        {!disabled && input.trim() === '' && (
          <button onClick={() => commit(input)} className="text-[10px] text-blue-600 hover:underline ml-1 inline-flex items-center gap-0.5">
            <Plus className="w-3 h-3" /> add
          </button>
        )}
      </div>
      {error && <p className="text-[10px] text-red-600 mt-0.5">{error}</p>}
    </div>
  );
}
