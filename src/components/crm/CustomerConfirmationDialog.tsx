import { useState } from 'react';
import { Modal } from '../Modal';
import { AlertCircle } from 'lucide-react';
import { indonesiaCities } from '../../data/indonesiaCities';
import { FloatingField, FLOAT_INPUT, FLOAT_TEXTAREA } from '../finance/FloatingField';
import { SapRow } from '../finance/SapLayout';

interface CustomerData {
  company_name: string;
  contact_person: string;
  email: string;
  phone: string;
  address?: string;
  city?: string;
  country?: string;
  pbf_license?: string;
  npwp?: string;
}

interface Props {
  isOpen: boolean;
  initialData: Partial<CustomerData>;
  onConfirm: (customerData: CustomerData) => Promise<void>;
  onCancel: () => void;
}

export function CustomerConfirmationDialog({
  isOpen,
  initialData,
  onConfirm,
  onCancel,
}: Props) {
  const [formData, setFormData] = useState<CustomerData>({
    company_name: initialData.company_name || '',
    contact_person: initialData.contact_person || '',
    email: initialData.email || '',
    phone: initialData.phone || '',
    address: initialData.address || '',
    city: initialData.city || 'Jakarta Pusat',
    country: initialData.country || 'Indonesia',
    pbf_license: initialData.pbf_license || '',
    npwp: initialData.npwp || '',
  });

  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!formData.company_name.trim()) {
      newErrors.company_name = 'Company name is required';
    }

    if (formData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = 'Invalid email format';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validateForm()) return;

    setLoading(true);
    try {
      await onConfirm(formData);
    } catch (error) {
      console.error('Error creating customer:', error);
      alert('Failed to create customer. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (field: keyof CustomerData, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[field];
        return newErrors;
      });
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title="Create New Customer"
    >
      <div className="space-y-4">
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-start">
            <AlertCircle className="h-5 w-5 text-blue-600 mr-2 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm text-blue-900 font-medium">
                Creating a new customer record
              </p>
              <p className="text-xs text-blue-700 mt-1">
                Please verify the information below before creating
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-3 max-h-96 overflow-y-auto">
          <SapRow>
            <FloatingField label="Company Name" required filled={!!formData.company_name} error={errors.company_name} span={12}>
              <input name="company_name" aria-label="Enter company name"
                type="text"
                value={formData.company_name}
                onChange={(e) => handleChange('company_name', e.target.value)}
                className={FLOAT_INPUT}
                placeholder="Enter company name"
              />
            </FloatingField>
          </SapRow>

          <SapRow>
            <FloatingField label="Contact Person" filled={!!formData.contact_person} span={6}>
              <input name="contact_person" aria-label="Enter contact person name"
                type="text"
                value={formData.contact_person}
                onChange={(e) => handleChange('contact_person', e.target.value)}
                className={FLOAT_INPUT}
                placeholder="Enter contact person name"
              />
            </FloatingField>
            <FloatingField label="Email" filled={!!formData.email} error={errors.email} span={6}>
              <input name="email" aria-label="Enter email address"
                type="email"
                value={formData.email}
                onChange={(e) => handleChange('email', e.target.value)}
                className={FLOAT_INPUT}
                placeholder="Enter email address"
              />
            </FloatingField>
          </SapRow>

          <SapRow>
            <FloatingField label="Phone" filled={!!formData.phone} span={6}>
              <input name="phone" aria-label="Enter phone number"
                type="text"
                value={formData.phone}
                onChange={(e) => handleChange('phone', e.target.value)}
                className={FLOAT_INPUT}
                placeholder="Enter phone number"
              />
            </FloatingField>
            <FloatingField label="City" filled={!!formData.city} span={6}>
              <select name="city" aria-label="City"
                value={formData.city}
                onChange={(e) => handleChange('city', e.target.value)}
                className={FLOAT_INPUT}
              >
                {indonesiaCities.map((city) => (
                  <option key={city} value={city}>
                    {city}
                  </option>
                ))}
              </select>
            </FloatingField>
          </SapRow>

          <SapRow>
            <FloatingField label="Country" filled={!!formData.country} span={6}>
              <input name="country" aria-label="Enter country"
                type="text"
                value={formData.country}
                onChange={(e) => handleChange('country', e.target.value)}
                className={FLOAT_INPUT}
                placeholder="Enter country"
              />
            </FloatingField>
            <FloatingField label="PBF License" filled={!!formData.pbf_license} span={6}>
              <input name="pbf_license" aria-label="PBF License"
                type="text"
                value={formData.pbf_license}
                onChange={(e) => handleChange('pbf_license', e.target.value)}
                className={FLOAT_INPUT}
                placeholder="Enter PBF license number"
              />
            </FloatingField>
          </SapRow>

          <SapRow>
            <FloatingField label="Address" filled={!!formData.address} textarea span={12}>
              <textarea name="address" aria-label="Enter address"
                value={formData.address}
                onChange={(e) => handleChange('address', e.target.value)}
                rows={2}
                className={FLOAT_TEXTAREA}
                placeholder="Enter address"
              />
            </FloatingField>
          </SapRow>

          <SapRow>
            <FloatingField label="NPWP" filled={!!formData.npwp} span={6}>
              <input name="npwp" aria-label="NPWP"
                type="text"
                value={formData.npwp}
                onChange={(e) => handleChange('npwp', e.target.value)}
                className={FLOAT_INPUT}
                placeholder="Enter NPWP number"
              />
            </FloatingField>
          </SapRow>
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Creating...' : 'Create Customer'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
