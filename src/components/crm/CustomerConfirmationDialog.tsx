import { useState } from 'react';
import { Modal } from '../Modal';
import { Building2, User, Mail, Phone, MapPin, Globe, AlertCircle } from 'lucide-react';
import { indonesiaCities } from '../../data/indonesiaCities';

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

        <div className="space-y-4 max-h-96 overflow-y-auto">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              <Building2 className="inline h-4 w-4 mr-1" />
              Company Name *
            </label>
            <input
              type="text"
              value={formData.company_name}
              onChange={(e) => handleChange('company_name', e.target.value)}
              className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 ${
                errors.company_name ? 'border-red-500' : 'border-gray-300'
              }`}
              placeholder="Enter company name"
            />
            {errors.company_name && (
              <p className="text-xs text-red-600 mt-1">{errors.company_name}</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              <User className="inline h-4 w-4 mr-1" />
              Contact Person
            </label>
            <input
              type="text"
              value={formData.contact_person}
              onChange={(e) => handleChange('contact_person', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              placeholder="Enter contact person name"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              <Mail className="inline h-4 w-4 mr-1" />
              Email
            </label>
            <input
              type="email"
              value={formData.email}
              onChange={(e) => handleChange('email', e.target.value)}
              className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 ${
                errors.email ? 'border-red-500' : 'border-gray-300'
              }`}
              placeholder="Enter email address"
            />
            {errors.email && (
              <p className="text-xs text-red-600 mt-1">{errors.email}</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              <Phone className="inline h-4 w-4 mr-1" />
              Phone
            </label>
            <input
              type="text"
              value={formData.phone}
              onChange={(e) => handleChange('phone', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              placeholder="Enter phone number"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              <MapPin className="inline h-4 w-4 mr-1" />
              Address
            </label>
            <textarea
              value={formData.address}
              onChange={(e) => handleChange('address', e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              placeholder="Enter address"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                City
              </label>
              <select
                value={formData.city}
                onChange={(e) => handleChange('city', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              >
                {indonesiaCities.map((city) => (
                  <option key={city} value={city}>
                    {city}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                <Globe className="inline h-4 w-4 mr-1" />
                Country
              </label>
              <input
                type="text"
                value={formData.country}
                onChange={(e) => handleChange('country', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                placeholder="Enter country"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              PBF License
            </label>
            <input
              type="text"
              value={formData.pbf_license}
              onChange={(e) => handleChange('pbf_license', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              placeholder="Enter PBF license number"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              NPWP
            </label>
            <input
              type="text"
              value={formData.npwp}
              onChange={(e) => handleChange('npwp', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              placeholder="Enter NPWP number"
            />
          </div>
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
