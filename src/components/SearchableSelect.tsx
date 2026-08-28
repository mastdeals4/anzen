import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { useDebounce } from '../hooks/useDebounce';

interface Option {
  value: string;
  label: string;
  group?: string;
}

interface SearchableSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  required?: boolean;
  /** When provided, shows a "Create X" option when no results match. Called with the current search text. */
  onCreateNew?: (searchText: string) => void;
}

const STRIP_PREFIXES = /^(PT\.?\s*|CV\.?\s*|UD\.?\s*|TBK\.?\s*|LTD\.?\s*|CO\.?\s*)/i;
const STRIP_TOKENS = /\b(pt|cv|ud|tbk|ltd|co)\.?\b/gi;

function normalize(text: string): string {
  return text
    .replace(STRIP_PREFIXES, '')
    .replace(STRIP_TOKENS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = 'Select...',
  className = '',
  disabled = false,
  onCreateNew,
}: SearchableSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
  const buttonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find(opt => opt.value === value);
  const debouncedFilter = useDebounce(filter, 120);

  const filtered = useMemo(() => {
    if (!debouncedFilter) return options;
    const q = debouncedFilter.toLowerCase().trim();
    const normalizedQ = normalize(debouncedFilter);
    const qTokens = normalizedQ.split(/\s+/).filter(Boolean);
    return options.filter(opt => {
      const raw = opt.label.toLowerCase();
      if (raw.includes(q)) return true;
      const stripped = normalize(opt.label);
      if (stripped.includes(normalizedQ)) return true;
      if (qTokens.length === 0) return false;
      const optTokens = stripped.split(/\s+/).filter(Boolean);
      return qTokens.every(qt => optTokens.some(ot => ot.includes(qt)));
    });
  }, [options, debouncedFilter]);

  const updateDropdownPosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const dropdownHeight = Math.min(320, window.innerHeight * 0.4);
    const minWidth = Math.max(rect.width, 240);
    const leftPos = Math.min(rect.left, window.innerWidth - minWidth - 8);

    if (spaceBelow >= dropdownHeight || spaceBelow >= spaceAbove) {
      setDropdownStyle({
        position: 'fixed',
        top: rect.bottom + 2,
        left: leftPos,
        minWidth,
        zIndex: 9999,
      });
    } else {
      setDropdownStyle({
        position: 'fixed',
        bottom: window.innerHeight - rect.top + 2,
        left: leftPos,
        minWidth,
        zIndex: 9999,
      });
    }
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        containerRef.current && !containerRef.current.contains(target) &&
        !(listRef.current && listRef.current.closest('[data-searchable-dropdown]')?.contains(target))
      ) {
        setIsOpen(false);
        setFilter('');
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      window.addEventListener('scroll', updateDropdownPosition, true);
      window.addEventListener('resize', updateDropdownPosition);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
        window.removeEventListener('scroll', updateDropdownPosition, true);
        window.removeEventListener('resize', updateDropdownPosition);
      };
    }
  }, [isOpen, updateDropdownPosition]);

  useEffect(() => {
    if (isOpen) {
      updateDropdownPosition();
      buttonRef.current?.focus();
      if (value && !filter) {
        const idx = filtered.findIndex(o => o.value === value);
        if (idx !== -1) {
          setHighlightedIndex(idx);
          scrollToIndex(idx);
        }
      }
    } else {
      setHighlightedIndex(-1);
      setFilter('');
    }
  }, [isOpen]);

  useEffect(() => {
    setHighlightedIndex(-1);
  }, [debouncedFilter]);

  useEffect(() => {
    if (isOpen && highlightedIndex >= 0) {
      scrollToIndex(highlightedIndex);
    }
  }, [highlightedIndex]);

  const scrollToIndex = (index: number) => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll<HTMLElement>('[role="option"]');
    const el = items[index];
    if (el) el.scrollIntoView({ block: 'nearest' });
  };

  const handleSelect = (val: string) => {
    onChange(val);
    setIsOpen(false);
    setFilter('');
  };

  const handleButtonKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!isOpen) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setIsOpen(true);
      }
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      setIsOpen(false);
      setFilter('');
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex(prev => (prev < filtered.length - 1 ? prev + 1 : prev));
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex(prev => (prev > 0 ? prev - 1 : 0));
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightedIndex >= 0 && highlightedIndex < filtered.length) {
        handleSelect(filtered[highlightedIndex].value);
      } else if (onCreateNew && filter.trim() && filtered.length === 0) {
        onCreateNew(filter.trim());
        setIsOpen(false);
        setFilter('');
      }
      return;
    }

    if (e.key === 'Backspace') {
      e.preventDefault();
      setFilter(prev => prev.slice(0, -1));
      return;
    }

    if (e.key === 'Delete') {
      e.preventDefault();
      setFilter('');
      return;
    }

    // Printable character — append to filter
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setFilter(prev => prev + e.key);
    }
  };

  const flatFiltered = filtered;

  const dropdown = isOpen ? (
    <div
      data-searchable-dropdown="true"
      style={dropdownStyle}
      className="bg-white border border-gray-200 rounded shadow-2xl overflow-hidden"
    >
      {filter && (
        <div className="px-2 py-1 border-b border-gray-100 bg-gray-50 flex items-center gap-1">
          <span className="text-[10px] text-gray-400 uppercase tracking-wide shrink-0">Filter:</span>
          <span className="text-xs font-medium text-gray-800 truncate">{filter}</span>
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); setFilter(''); buttonRef.current?.focus(); }}
            className="ml-auto text-[10px] text-gray-400 hover:text-gray-600 shrink-0 px-0.5"
          >
            ✕
          </button>
        </div>
      )}
      <div ref={listRef} className="max-h-72 overflow-y-auto" role="listbox">
        {flatFiltered.length === 0 ? (
          onCreateNew && filter.trim() ? (
            <div
              onMouseDown={(e) => { e.preventDefault(); onCreateNew(filter.trim()); setIsOpen(false); setFilter(''); }}
              className="px-2 py-1.5 cursor-pointer text-xs text-blue-700 hover:bg-blue-50 flex items-center gap-1.5 font-medium"
              role="option"
            >
              <span className="text-sm leading-none">+</span>
              Create &ldquo;{filter.trim()}&rdquo;
            </div>
          ) : (
            <div className="px-2 py-2 text-xs text-gray-400 text-center">No results</div>
          )
        ) : (
          <>
            {(() => {
              const hasGroups = flatFiltered.some(o => o.group);
              if (!hasGroups) {
                return flatFiltered.map((option, index) => (
                  <div
                    key={option.value}
                    onMouseDown={(e) => { e.preventDefault(); handleSelect(option.value); }}
                    className={`px-2 py-[5px] cursor-pointer text-xs leading-tight ${
                      index === highlightedIndex
                        ? 'bg-blue-500 text-white'
                        : option.value === value
                        ? 'bg-blue-50 text-blue-900'
                        : 'text-gray-800 hover:bg-gray-50'
                    }`}
                    role="option"
                    aria-selected={option.value === value}
                  >
                    {option.label}
                  </div>
                ));
              }
              let lastGroup = '';
              return flatFiltered.map((option, index) => {
                const showHeader = option.group && option.group !== lastGroup;
                if (showHeader) lastGroup = option.group!;
                return (
                  <div key={option.value}>
                    {showHeader && (
                      <div className="px-2 pt-1.5 pb-0.5 text-[9px] font-semibold text-gray-400 uppercase tracking-wide bg-gray-50 border-b border-gray-100">
                        {option.group}
                      </div>
                    )}
                    <div
                      onMouseDown={(e) => { e.preventDefault(); handleSelect(option.value); }}
                      className={`px-2 py-[5px] cursor-pointer text-xs leading-tight ${
                        index === highlightedIndex
                          ? 'bg-blue-500 text-white'
                          : option.value === value
                          ? 'bg-blue-50 text-blue-900'
                          : 'text-gray-800 hover:bg-gray-50'
                      }`}
                      role="option"
                      aria-selected={option.value === value}
                    >
                      {option.label}
                    </div>
                  </div>
                );
              });
            })()}
            {onCreateNew && filter.trim() && (
              <div
                onMouseDown={(e) => { e.preventDefault(); onCreateNew(filter.trim()); setIsOpen(false); setFilter(''); }}
                className="px-2 py-[5px] cursor-pointer text-xs text-blue-700 hover:bg-blue-50 flex items-center gap-1.5 font-medium border-t border-gray-100"
                role="option"
              >
                <span className="text-sm leading-none">+</span>
                Create &ldquo;{filter.trim()}&rdquo;
              </div>
            )}
          </>
        )}
      </div>
    </div>
  ) : null;

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          if (!disabled) {
            setIsOpen(prev => !prev);
          }
        }}
        onKeyDown={handleButtonKeyDown}
        disabled={disabled}
        className={`w-full px-3 border rounded-lg text-left flex items-center justify-between h-[34px] ${
          /\bpy-/.test(className) ? '' : 'py-2'
        } ${disabled ? 'bg-gray-100 cursor-not-allowed' : 'bg-white hover:border-blue-500'} ${className}`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className={`truncate text-sm ${selectedOption ? 'text-gray-900' : 'text-gray-400'}`}>
          {isOpen && filter ? (
            <span className="text-gray-600">{filter}<span className="animate-pulse">|</span></span>
          ) : selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown className={`w-4 h-4 text-gray-400 shrink-0 ml-2 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {typeof document !== 'undefined' && dropdown && createPortal(dropdown, document.body)}
    </div>
  );
}
