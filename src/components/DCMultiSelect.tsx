import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, Search } from 'lucide-react';
import { formatDate } from '../utils/dateFormat';

export interface DCOption {
  challan_id: string;
  challan_number: string;
  challan_date: string;
  item_count: number;
  product_names?: string;
}

export interface DCMultiSelectProps {
  options: DCOption[];
  selectedDCIds: string[];
  onChange: (selectedIds: string[]) => void;
  placeholder?: string;
}

export function DCMultiSelect({
  options,
  selectedDCIds,
  onChange,
  placeholder = 'Select Delivery Challans'
}: DCMultiSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerButtonRef = useRef<HTMLButtonElement>(null);
  const dropdownPanelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const updateDropdownPosition = useCallback(() => {
    if (!triggerButtonRef.current) return;
    const rect = triggerButtonRef.current.getBoundingClientRect();
    const dropdownHeight = 360;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;

    // Minimum comfortable width for DC numbers and product names
    const minWidth = Math.max(rect.width, 340);
    const maxViewportWidth = window.innerWidth - 16;
    const finalWidth = Math.min(minWidth, maxViewportWidth);

    // Keep dropdown within viewport boundaries
    const leftPos = Math.max(8, Math.min(rect.left, window.innerWidth - finalWidth - 8));

    if (spaceBelow >= dropdownHeight || spaceBelow >= spaceAbove) {
      setDropdownStyle({
        position: 'fixed',
        top: rect.bottom + 4,
        left: leftPos,
        width: finalWidth,
        maxHeight: Math.min(380, Math.max(160, spaceBelow - 12)),
        zIndex: 99999,
      });
    } else {
      setDropdownStyle({
        position: 'fixed',
        bottom: window.innerHeight - rect.top + 4,
        left: leftPos,
        width: finalWidth,
        maxHeight: Math.min(380, Math.max(160, spaceAbove - 12)),
        zIndex: 99999,
      });
    }
  }, []);

  // Update position on scroll (including modal container scroll) and resize
  useEffect(() => {
    if (!isOpen) return;

    updateDropdownPosition();

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        containerRef.current?.contains(target) ||
        dropdownPanelRef.current?.contains(target)
      ) {
        return;
      }
      setIsOpen(false);
      setSearchTerm('');
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        setSearchTerm('');
        triggerButtonRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    // Use capture: true so scrolling inside the modal or any parent element re-aligns the dropdown
    window.addEventListener('scroll', updateDropdownPosition, true);
    window.addEventListener('resize', updateDropdownPosition);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', updateDropdownPosition, true);
      window.removeEventListener('resize', updateDropdownPosition);
    };
  }, [isOpen, updateDropdownPosition]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isOpen) {
      const timer = requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
      return () => cancelAnimationFrame(timer);
    }
  }, [isOpen]);

  const filteredOptions = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return options;
    return options.filter(option =>
      option.challan_number.toLowerCase().includes(term) ||
      (option.product_names || '').toLowerCase().includes(term)
    );
  }, [options, searchTerm]);

  const toggleDC = (dcId: string) => {
    if (selectedDCIds.includes(dcId)) {
      onChange(selectedDCIds.filter(id => id !== dcId));
    } else {
      onChange([...selectedDCIds, dcId]);
    }
  };

  const toggleSelectAll = () => {
    const allFilteredSelected = filteredOptions.length > 0 &&
      filteredOptions.every(opt => selectedDCIds.includes(opt.challan_id));

    if (allFilteredSelected) {
      const filteredIds = new Set(filteredOptions.map(opt => opt.challan_id));
      onChange(selectedDCIds.filter(id => !filteredIds.has(id)));
    } else {
      const newSelected = new Set(selectedDCIds);
      filteredOptions.forEach(opt => newSelected.add(opt.challan_id));
      onChange(Array.from(newSelected));
    }
  };

  const selectedCount = selectedDCIds.length;
  const displayText = selectedCount === 0
    ? placeholder
    : selectedCount === 1
    ? options.find(opt => opt.challan_id === selectedDCIds[0])?.challan_number || `${selectedCount} DC selected`
    : `${selectedCount} DCs selected`;

  const allFilteredSelected = filteredOptions.length > 0 &&
    filteredOptions.every(opt => selectedDCIds.includes(opt.challan_id));
  const someFilteredSelected = !allFilteredSelected &&
    filteredOptions.some(opt => selectedDCIds.includes(opt.challan_id));

  return (
    <div className="relative w-full h-full flex items-center" ref={containerRef} data-dc-multiselect="true">
      <button
        ref={triggerButtonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => {
          setIsOpen(!isOpen);
          if (isOpen) setSearchTerm('');
        }}
        className="w-full h-full px-2.5 py-1 text-xs text-left bg-transparent border-0 rounded-none focus:outline-none flex items-center justify-between hover:bg-black/5 transition-colors cursor-pointer"
      >
        <span className={`truncate ${selectedCount === 0 ? 'text-gray-400' : 'text-gray-900 font-medium'}`}>
          {displayText}
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-gray-400 shrink-0 ml-1 transition-transform duration-200 ${isOpen ? 'transform rotate-180 text-blue-600' : ''}`}
        />
      </button>

      {isOpen && typeof document !== 'undefined' && createPortal(
        <div
          ref={dropdownPanelRef}
          style={dropdownStyle}
          data-dc-dropdown-portal="true"
          className="bg-white border border-gray-300 rounded-lg shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-100"
        >
          {/* Search Header */}
          <div className="p-2 border-b border-gray-200 bg-gray-50/70 shrink-0">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
              <input
                ref={searchInputRef}
                name="dc_search_term"
                aria-label="Search Delivery Challans..."
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search DC number or product..."
                className="w-full pl-8 pr-3 py-1.5 border border-gray-300 rounded-md text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          </div>

          {/* Options List */}
          <div className="overflow-y-auto flex-1 divide-y divide-gray-100">
            {filteredOptions.length > 1 && (
              <div
                role="button"
                tabIndex={0}
                className="px-3 py-2 hover:bg-blue-50/60 cursor-pointer border-b border-gray-200 sticky top-0 bg-gray-50/95 backdrop-blur-xs z-10 transition-colors"
                onClick={toggleSelectAll}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleSelectAll();
                  }
                }}
              >
                <div className="flex items-center gap-2.5">
                  <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                    allFilteredSelected
                      ? 'bg-blue-600 border-blue-600 text-white'
                      : someFilteredSelected
                      ? 'bg-blue-100 border-blue-400 text-blue-700'
                      : 'border-gray-300 bg-white'
                  }`}>
                    {allFilteredSelected ? (
                      <Check className="w-3 h-3 stroke-[3]" />
                    ) : someFilteredSelected ? (
                      <div className="w-2 h-0.5 bg-blue-700 rounded-sm" />
                    ) : null}
                  </div>
                  <span className="text-xs font-semibold text-gray-800">
                    {allFilteredSelected ? 'Deselect All' : '(Select All)'}
                  </span>
                  <span className="text-[11px] text-gray-400 ml-auto font-normal">
                    {filteredOptions.length} DC{filteredOptions.length > 1 ? 's' : ''}
                  </span>
                </div>
              </div>
            )}

            {filteredOptions.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-gray-500">
                {searchTerm ? 'No delivery challans match your search' : 'No approved delivery challans available'}
              </div>
            ) : (
              filteredOptions.map((option) => {
                const isSelected = selectedDCIds.includes(option.challan_id);
                return (
                  <div
                    key={option.challan_id}
                    role="checkbox"
                    aria-checked={isSelected}
                    tabIndex={0}
                    className={`px-3 py-2 hover:bg-blue-50/50 cursor-pointer transition-colors flex items-start gap-2.5 ${
                      isSelected ? 'bg-blue-50/30' : ''
                    }`}
                    onClick={() => toggleDC(option.challan_id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleDC(option.challan_id);
                      }
                    }}
                  >
                    <div className={`w-4 h-4 rounded border shrink-0 mt-0.5 flex items-center justify-center transition-colors ${
                      isSelected ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-300 bg-white'
                    }`}>
                      {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1.5">
                        <span className="text-xs font-bold text-gray-900 tracking-tight">
                          {option.challan_number}
                        </span>
                        <span className="text-[10px] text-gray-400 font-medium shrink-0">
                          {formatDate(option.challan_date)}
                        </span>
                      </div>
                      {option.product_names && (
                        <div className="text-[11px] text-gray-700 font-medium truncate mt-0.5" title={option.product_names}>
                          {option.product_names}
                        </div>
                      )}
                      <div className="text-[10px] text-gray-500 mt-0.5">
                        {option.item_count} item{option.item_count !== 1 ? 's' : ''} ready to invoice
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
