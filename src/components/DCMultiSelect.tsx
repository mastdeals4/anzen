import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check, Search } from 'lucide-react';

interface DCOption {
  challan_id: string;
  challan_number: string;
  challan_date: string;
  item_count: number;
}

interface DCMultiSelectProps {
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
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredOptions = options.filter(option =>
    option.challan_number.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const toggleDC = (dcId: string) => {
    if (selectedDCIds.includes(dcId)) {
      onChange(selectedDCIds.filter(id => id !== dcId));
    } else {
      onChange([...selectedDCIds, dcId]);
    }
  };

  const toggleSelectAll = () => {
    if (selectedDCIds.length === filteredOptions.length) {
      onChange([]);
    } else {
      onChange(filteredOptions.map(opt => opt.challan_id));
    }
  };

  const selectedCount = selectedDCIds.length;
  const displayText = selectedCount === 0
    ? placeholder
    : selectedCount === 1
    ? options.find(opt => opt.challan_id === selectedDCIds[0])?.challan_number || `${selectedCount} DCs selected`
    : `${selectedCount} DCs selected`;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-2 py-1.5 text-sm text-left bg-white border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 focus:border-transparent flex items-center justify-between"
      >
        <span className={selectedCount === 0 ? 'text-gray-400' : 'text-gray-900'}>
          {displayText}
        </span>
        <ChevronDown className={`w-3 h-3 transition-transform ${isOpen ? 'transform rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-96 overflow-hidden flex flex-col">
          <div className="p-2 border-b border-gray-200">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search..."
                className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          </div>

          <div className="overflow-y-auto max-h-80">
            {filteredOptions.length > 1 && (
              <div
                className="px-3 py-2 hover:bg-gray-50 cursor-pointer border-b border-gray-200 sticky top-0 bg-white"
                onClick={toggleSelectAll}
              >
                <div className="flex items-center gap-2">
                  <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${
                    selectedDCIds.length === filteredOptions.length
                      ? 'bg-green-600 border-green-600'
                      : selectedDCIds.length > 0
                      ? 'bg-gray-300 border-gray-300'
                      : 'border-gray-300'
                  }`}>
                    {selectedDCIds.length > 0 && (
                      <Check className="w-3 h-3 text-white" />
                    )}
                  </div>
                  <span className="font-medium text-gray-900">(Select All)</span>
                </div>
              </div>
            )}

            {filteredOptions.length === 0 ? (
              <div className="px-3 py-4 text-center text-gray-500">
                No delivery challans found
              </div>
            ) : (
              filteredOptions.map((option) => {
                const isSelected = selectedDCIds.includes(option.challan_id);
                return (
                  <div
                    key={option.challan_id}
                    className="px-3 py-2 hover:bg-gray-50 cursor-pointer"
                    onClick={() => toggleDC(option.challan_id)}
                  >
                    <div className="flex items-center gap-2">
                      <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${
                        isSelected ? 'bg-green-600 border-green-600' : 'border-gray-300'
                      }`}>
                        {isSelected && <Check className="w-3 h-3 text-white" />}
                      </div>
                      <div className="flex-1">
                        <div className="font-medium text-gray-900">{option.challan_number}</div>
                        <div className="text-xs text-gray-500">
                          {new Date(option.challan_date).toLocaleDateString()} • {option.item_count} items pending
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
