import { Modal } from '../Modal';
import { AlertCircle, ArrowRight } from 'lucide-react';

interface Props {
  isOpen: boolean;
  customerName: string;
  changedFields: string[];
  oldValues: Record<string, string>;
  newValues: Record<string, string>;
  onUpdateCustomer: () => Promise<void>;
  onKeepExisting: () => void;
  onCancel: () => void;
}

export function CustomerUpdateDialog({
  isOpen,
  customerName,
  changedFields,
  oldValues,
  newValues,
  onUpdateCustomer,
  onKeepExisting,
  onCancel,
}: Props) {
  const getFieldLabel = (field: string): string => {
    const labels: Record<string, string> = {
      email: 'Email',
      phone: 'Phone',
      contact_person: 'Contact Person',
      address: 'Address',
      city: 'City',
      country: 'Country',
    };
    return labels[field] || field;
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title="Update Customer Information?"
    >
      <div className="space-y-4">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="flex items-start">
            <AlertCircle className="h-5 w-5 text-yellow-600 mr-2 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm text-yellow-900 font-medium">
                Contact details differ from master record
              </p>
              <p className="text-xs text-yellow-700 mt-1">
                The information you entered for <span className="font-semibold">{customerName}</span> differs from what's stored in the customer database.
              </p>
            </div>
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="bg-gray-50 px-4 py-2 border-b border-gray-200">
            <h4 className="text-sm font-semibold text-gray-700">Changes Detected</h4>
          </div>

          <div className="divide-y divide-gray-200">
            {changedFields.map((field) => (
              <div key={field} className="px-4 py-3">
                <div className="text-xs font-medium text-gray-500 uppercase mb-2">
                  {getFieldLabel(field)}
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex-1 bg-red-50 border border-red-200 rounded px-3 py-2">
                    <div className="text-xs text-red-600 font-medium mb-0.5">Current</div>
                    <div className="text-sm text-gray-900">
                      {oldValues[field] || <span className="text-gray-400 italic">Not set</span>}
                    </div>
                  </div>
                  <ArrowRight className="h-5 w-5 text-gray-400 flex-shrink-0" />
                  <div className="flex-1 bg-green-50 border border-green-200 rounded px-3 py-2">
                    <div className="text-xs text-green-600 font-medium mb-0.5">New</div>
                    <div className="text-sm text-gray-900">
                      {newValues[field] || <span className="text-gray-400 italic">Not set</span>}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
          <p className="text-xs text-blue-900">
            <strong>Tip:</strong> Updating the customer record will apply these changes to all future inquiries for this customer.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row justify-end gap-2 pt-4 border-t">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onKeepExisting}
            className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
          >
            Keep Existing
          </button>
          <button
            type="button"
            onClick={onUpdateCustomer}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Update Customer Record
          </button>
        </div>
      </div>
    </Modal>
  );
}
