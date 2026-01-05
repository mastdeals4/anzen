import { useState } from 'react';
import { Modal } from '../Modal';
import { CheckCircle, Users, Mail, Phone, Calendar, AlertCircle } from 'lucide-react';

interface Customer {
  id: string;
  company_name: string;
  contact_person?: string;
  email?: string;
  phone?: string;
  created_at?: string;
}

interface MatchResult {
  customer: Customer;
  score: number;
  matchType: 'exact' | 'startsWith' | 'contains' | 'fuzzy';
  confidence: 'high' | 'medium' | 'low';
}

interface Props {
  isOpen: boolean;
  matches: MatchResult[];
  searchTerm: string;
  onSelect: (customer: Customer) => void;
  onCreateNew: () => void;
  onCancel: () => void;
  inquiryCounts?: Record<string, number>;
}

export function CustomerSelectionDialog({
  isOpen,
  matches,
  searchTerm,
  onSelect,
  onCreateNew,
  onCancel,
  inquiryCounts = {},
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const handleConfirm = () => {
    const selected = matches.find(m => m.customer.id === selectedId);
    if (selected) {
      onSelect(selected.customer);
    }
  };

  const getMatchBadgeColor = (confidence: string) => {
    switch (confidence) {
      case 'high':
        return 'bg-green-100 text-green-800';
      case 'medium':
        return 'bg-yellow-100 text-yellow-800';
      case 'low':
        return 'bg-orange-100 text-orange-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getMatchTypeLabel = (matchType: string) => {
    switch (matchType) {
      case 'exact':
        return 'Exact Match';
      case 'startsWith':
        return 'Starts With';
      case 'contains':
        return 'Contains';
      case 'fuzzy':
        return 'Similar Name';
      default:
        return 'Match';
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title="Select Existing Customer"
    >
      <div className="space-y-4">
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-start">
            <AlertCircle className="h-5 w-5 text-blue-600 mr-2 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm text-blue-900 font-medium">
                We found {matches.length} existing customer{matches.length !== 1 ? 's' : ''} similar to "{searchTerm}"
              </p>
              <p className="text-xs text-blue-700 mt-1">
                Please select the correct customer or create a new one
              </p>
            </div>
          </div>
        </div>

        <div className="max-h-96 overflow-y-auto space-y-2">
          {matches.map((match) => {
            const inquiryCount = inquiryCounts[match.customer.id] || 0;
            const isSelected = selectedId === match.customer.id;

            return (
              <div
                key={match.customer.id}
                onClick={() => setSelectedId(match.customer.id)}
                className={`border rounded-lg p-4 cursor-pointer transition-all ${
                  isSelected
                    ? 'border-blue-500 bg-blue-50 shadow-md'
                    : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <input
                        type="radio"
                        checked={isSelected}
                        onChange={() => setSelectedId(match.customer.id)}
                        className="h-4 w-4 text-blue-600"
                      />
                      <h3 className="font-semibold text-gray-900">
                        {match.customer.company_name}
                      </h3>
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs font-medium ${getMatchBadgeColor(
                          match.confidence
                        )}`}
                      >
                        {getMatchTypeLabel(match.matchType)} ({match.score}%)
                      </span>
                    </div>

                    <div className="ml-6 space-y-1">
                      {match.customer.contact_person && (
                        <div className="flex items-center text-sm text-gray-600">
                          <Users className="h-4 w-4 mr-2" />
                          {match.customer.contact_person}
                        </div>
                      )}
                      {match.customer.email && (
                        <div className="flex items-center text-sm text-gray-600">
                          <Mail className="h-4 w-4 mr-2" />
                          {match.customer.email}
                        </div>
                      )}
                      {match.customer.phone && (
                        <div className="flex items-center text-sm text-gray-600">
                          <Phone className="h-4 w-4 mr-2" />
                          {match.customer.phone}
                        </div>
                      )}
                      <div className="flex items-center text-sm text-gray-500">
                        <Calendar className="h-4 w-4 mr-2" />
                        {inquiryCount} {inquiryCount === 1 ? 'inquiry' : 'inquiries'} on record
                      </div>
                    </div>
                  </div>

                  {isSelected && (
                    <CheckCircle className="h-6 w-6 text-blue-600 flex-shrink-0" />
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="border-t pt-4">
          <button
            onClick={onCreateNew}
            className="w-full text-left px-4 py-3 border border-dashed border-gray-300 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition-colors"
          >
            <div className="flex items-center text-blue-600">
              <Users className="h-5 w-5 mr-2" />
              <span className="font-medium">None of these - Create New Customer</span>
            </div>
            <p className="text-xs text-gray-500 ml-7 mt-1">
              Create a new customer record for "{searchTerm}"
            </p>
          </button>
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!selectedId}
            className={`px-4 py-2 rounded-lg text-white ${
              selectedId
                ? 'bg-blue-600 hover:bg-blue-700'
                : 'bg-gray-300 cursor-not-allowed'
            }`}
          >
            Select Customer
          </button>
        </div>
      </div>
    </Modal>
  );
}
