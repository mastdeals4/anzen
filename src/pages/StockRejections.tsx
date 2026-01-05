import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { AlertTriangle, Plus, Search, CheckCircle, XCircle, Clock, Upload, Eye, Camera, FileText, Edit, Trash2 } from 'lucide-react';
import { Modal } from '../components/Modal';
import { StockRejectionView } from '../components/StockRejectionView';

interface StockRejection {
  id: string;
  rejection_number: string;
  rejection_date: string;
  quantity_rejected: number;
  rejection_reason: string;
  rejection_details: string;
  status: string;
  financial_loss: number;
  disposition: string;
  photos: any[];
  product: {
    product_name: string;
    product_code: string;
    unit: string;
  };
  batch: {
    batch_number: string;
    current_stock: number;
  };
}

interface Product {
  id: string;
  product_name: string;
  product_code: string;
}

interface Batch {
  id: string;
  batch_number: string;
  current_stock: number;
  import_price: number;
}

export default function StockRejections() {
  const { user, userProfile } = useAuth();
  const { t } = useLanguage();
  const [rejections, setRejections] = useState<StockRejection[]>([]);
  const [filteredRejections, setFilteredRejections] = useState<StockRejection[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [selectedRejection, setSelectedRejection] = useState<StockRejection | null>(null);
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [editingRejectionId, setEditingRejectionId] = useState<string | null>(null);

  const [products, setProducts] = useState<Product[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [photos, setPhotos] = useState<File[]>([]);
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);

  const [formData, setFormData] = useState({
    product_id: '',
    batch_id: '',
    rejection_date: new Date().toISOString().split('T')[0],
    quantity_rejected: 0,
    rejection_reason: 'quality_failed',
    rejection_details: '',
    disposition: 'pending',
    inspection_report: '',
  });

  useEffect(() => {
    fetchRejections();
    fetchProducts();
  }, []);

  useEffect(() => {
    filterRejections();
  }, [searchTerm, statusFilter, rejections]);

  const fetchRejections = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('stock_rejections')
        .select(`
          *,
          product:products(product_name, product_code, unit),
          batch:batches(batch_number, current_stock)
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setRejections(data || []);
    } catch (error: any) {
      console.error('Error fetching rejections:', error);
      alert(t('errorFetchingRejections') || 'Error fetching rejections');
    } finally {
      setLoading(false);
    }
  };

  const fetchProducts = async () => {
    const { data } = await supabase
      .from('products')
      .select('id, product_name, product_code')
      .eq('is_active', true)
      .order('product_name');
    setProducts(data || []);
  };

  const fetchBatchesForProduct = async (productId: string) => {
    const { data } = await supabase
      .from('batches')
      .select('id, batch_number, current_stock, import_price')
      .eq('product_id', productId)
      .gt('current_stock', 0)
      .order('batch_number');
    setBatches(data || []);
  };

  const filterRejections = () => {
    let filtered = rejections;

    if (statusFilter !== 'all') {
      filtered = filtered.filter(r => r.status === statusFilter);
    }

    if (searchTerm) {
      filtered = filtered.filter(r =>
        r.rejection_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
        r.product.product_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        r.batch.batch_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
        r.rejection_details.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    setFilteredRejections(filtered);
  };

  const handleProductChange = (productId: string) => {
    setFormData({ ...formData, product_id: productId, batch_id: '' });
    if (productId) {
      fetchBatchesForProduct(productId);
    }
  };

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const filesArray = Array.from(e.target.files);
      setPhotos([...photos, ...filesArray]);

      filesArray.forEach((file) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          setPhotoUrls((prev) => [...prev, reader.result as string]);
        };
        reader.readAsDataURL(file);
      });
    }
  };

  const removePhoto = (index: number) => {
    setPhotos(photos.filter((_, i) => i !== index));
    setPhotoUrls(photoUrls.filter((_, i) => i !== index));
  };

  const handleEdit = async (rejection: StockRejection) => {
    try {
      setFormData({
        product_id: rejection.product_id,
        batch_id: rejection.batch_id,
        rejection_date: rejection.rejection_date,
        quantity_rejected: rejection.quantity_rejected,
        rejection_reason: rejection.rejection_reason,
        rejection_details: rejection.rejection_details,
        disposition: rejection.disposition,
        inspection_report: rejection.inspection_report || '',
      });

      await fetchBatchesForProduct(rejection.product_id);

      if (rejection.photos && Array.isArray(rejection.photos)) {
        const urls = rejection.photos.map((photo: any) => photo.url);
        setPhotoUrls(urls);
      }

      setEditMode(true);
      setEditingRejectionId(rejection.id);
      setShowCreateModal(true);
    } catch (error) {
      console.error('Error loading rejection for edit:', error);
      alert('Failed to load rejection for editing');
    }
  };

  const handleDelete = async (id: string, photos: any[]) => {
    if (!confirm('Are you sure you want to delete this stock rejection? This action cannot be undone.')) {
      return;
    }

    try {
      if (photos && Array.isArray(photos) && photos.length > 0) {
        for (const photo of photos) {
          if (photo.url) {
            const fileName = photo.url.split('/').pop();
            if (fileName) {
              await supabase.storage
                .from('rejection_photos')
                .remove([`${id}/${fileName}`]);
            }
          }
        }
      }

      const { error } = await supabase
        .from('stock_rejections')
        .delete()
        .eq('id', id)
        .eq('status', 'pending_approval');

      if (error) throw error;

      alert('Stock rejection deleted successfully');
      fetchRejections();
    } catch (error: any) {
      console.error('Error deleting rejection:', error);
      alert(error.message || 'Failed to delete stock rejection');
    }
  };

  const uploadPhotos = async (rejectionId: string) => {
    const uploadedPhotos = [];

    for (const photo of photos) {
      const fileName = `${rejectionId}/${Date.now()}_${photo.name}`;
      const { data, error } = await supabase.storage
        .from('rejection_photos')
        .upload(fileName, photo);

      if (error) {
        console.error('Error uploading photo:', error);
        continue;
      }

      const { data: urlData } = supabase.storage
        .from('rejection_photos')
        .getPublicUrl(fileName);

      uploadedPhotos.push({
        url: urlData.publicUrl,
        filename: photo.name,
        uploaded_at: new Date().toISOString(),
      });
    }

    return uploadedPhotos;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.product_id || !formData.batch_id || !formData.rejection_details) {
      alert(t('pleaseCompleteAllFields') || 'Please complete all required fields');
      return;
    }

    try {
      const selectedBatch = batches.find(b => b.id === formData.batch_id);
      if (!selectedBatch) {
        alert(t('invalidBatch') || 'Invalid batch selected');
        return;
      }

      if (formData.quantity_rejected > selectedBatch.current_stock) {
        alert(
          t('quantityExceedsStock') ||
          `Rejection quantity cannot exceed available stock (${selectedBatch.current_stock})`
        );
        return;
      }

      const unitCost = selectedBatch.import_price || 0;
      const financialLoss = formData.quantity_rejected * unitCost;

      if (editMode && editingRejectionId) {
        const { error: rejectionError } = await supabase
          .from('stock_rejections')
          .update({
            ...formData,
            unit_cost: unitCost,
            financial_loss: financialLoss,
            inspected_by: user?.id,
          })
          .eq('id', editingRejectionId)
          .eq('status', 'pending_approval');

        if (rejectionError) throw rejectionError;

        let uploadedPhotos = [];
        if (photos.length > 0) {
          uploadedPhotos = await uploadPhotos(editingRejectionId);

          const { data: existingRejection } = await supabase
            .from('stock_rejections')
            .select('photos')
            .eq('id', editingRejectionId)
            .single();

          const existingPhotos = existingRejection?.photos || [];
          const allPhotos = [...existingPhotos, ...uploadedPhotos];

          await supabase
            .from('stock_rejections')
            .update({ photos: allPhotos })
            .eq('id', editingRejectionId);
        }

        alert('Stock rejection updated successfully');
      } else {
        const { data: rejectionData, error: rejectionError } = await supabase
          .from('stock_rejections')
          .insert({
            ...formData,
            unit_cost: unitCost,
            financial_loss: financialLoss,
            created_by: user?.id,
            inspected_by: user?.id,
          })
          .select()
          .single();

        if (rejectionError) throw rejectionError;

        let uploadedPhotos = [];
        if (photos.length > 0) {
          uploadedPhotos = await uploadPhotos(rejectionData.id);

          await supabase
            .from('stock_rejections')
            .update({ photos: uploadedPhotos })
            .eq('id', rejectionData.id);
        }

        if (financialLoss >= 100) {
          const requiredRole = financialLoss >= 1000 ? 'admin' : 'manager';
          await supabase.from('approval_workflows').insert({
            transaction_type: 'stock_rejection',
            transaction_id: rejectionData.id,
            requested_by: user?.id,
            amount: financialLoss,
            quantity: formData.quantity_rejected,
            status: 'pending',
            metadata: { required_role: requiredRole },
          });
        }

        alert(t('rejectionCreatedSuccessfully') || 'Stock rejection created successfully');
      }

      setShowCreateModal(false);
      resetForm();
      fetchRejections();
    } catch (error: any) {
      console.error('Error saving rejection:', error);
      alert(error.message || t('errorCreatingRejection') || 'Error saving stock rejection');
    }
  };

  const resetForm = () => {
    setFormData({
      product_id: '',
      batch_id: '',
      rejection_date: new Date().toISOString().split('T')[0],
      quantity_rejected: 0,
      rejection_reason: 'quality_failed',
      rejection_details: '',
      disposition: 'pending',
      inspection_report: '',
    });
    setPhotos([]);
    setPhotoUrls([]);
    setEditMode(false);
    setEditingRejectionId(null);
  };

  const getStatusBadge = (status: string) => {
    const styles = {
      pending_approval: 'bg-yellow-100 text-yellow-800',
      approved: 'bg-green-100 text-green-800',
      rejected: 'bg-red-100 text-red-800',
      disposed: 'bg-gray-100 text-gray-800',
    };

    const icons = {
      pending_approval: <Clock className="w-3 h-3 mr-1" />,
      approved: <CheckCircle className="w-3 h-3 mr-1" />,
      rejected: <XCircle className="w-3 h-3 mr-1" />,
      disposed: <CheckCircle className="w-3 h-3 mr-1" />,
    };

    return (
      <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${styles[status as keyof typeof styles] || 'bg-gray-100 text-gray-800'}`}>
        {icons[status as keyof typeof icons]}
        {status.replace('_', ' ').toUpperCase()}
      </span>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-lg">{t('loading') || 'Loading...'}</div>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6 p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">
          {t('stockRejections') || 'Stock Rejections'}
        </h1>
        <button
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center justify-center px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
        >
          <AlertTriangle className="w-5 h-5 mr-2" />
          {t('newRejection') || 'New Rejection'}
        </button>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="flex flex-col sm:flex-row gap-4 mb-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
            <input
              type="text"
              placeholder={t('searchRejections') || 'Search rejections...'}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="all">{t('allStatuses') || 'All Statuses'}</option>
            <option value="pending_approval">{t('pendingApproval') || 'Pending Approval'}</option>
            <option value="approved">{t('approved') || 'Approved'}</option>
            <option value="rejected">{t('rejected') || 'Rejected'}</option>
            <option value="disposed">{t('disposed') || 'Disposed'}</option>
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('rejectionNumber') || 'Rejection #'}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('date') || 'Date'}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('product') || 'Product'}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('batch') || 'Batch'}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('quantity') || 'Quantity'}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('reason') || 'Reason'}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('loss') || 'Loss'}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('status') || 'Status'}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('actions') || 'Actions'}
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredRejections.map((rejection) => (
                <tr key={rejection.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">
                    {rejection.rejection_number}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900">
                    {new Date(rejection.rejection_date).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900">
                    <div>{rejection.product.product_name}</div>
                    <div className="text-xs text-gray-500">{rejection.product.product_code}</div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900">
                    {rejection.batch.batch_number}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900">
                    {rejection.quantity_rejected}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {rejection.rejection_reason.replace('_', ' ')}
                  </td>
                  <td className="px-4 py-3 text-sm text-red-600 font-medium">
                    ${rejection.financial_loss?.toFixed(2) || '0.00'}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {getStatusBadge(rejection.status)}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          setSelectedRejection(rejection);
                          setShowDetailsModal(true);
                        }}
                        className="text-blue-600 hover:text-blue-800 inline-flex items-center"
                      >
                        <Eye className="w-4 h-4 mr-1" />
                        {t('view') || 'View'}
                      </button>

                      {rejection.status === 'pending_approval' && (
                        <>
                          <button
                            onClick={() => handleEdit(rejection)}
                            className="text-yellow-600 hover:text-yellow-800 inline-flex items-center"
                            title="Edit Rejection"
                          >
                            <Edit className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDelete(rejection.id, rejection.photos)}
                            className="text-red-600 hover:text-red-800 inline-flex items-center"
                            title="Delete Rejection"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredRejections.length === 0 && (
            <div className="text-center py-8 text-gray-500">
              {t('noRejectionsFound') || 'No rejections found'}
            </div>
          )}
        </div>
      </div>

      {showCreateModal && (
        <Modal
          isOpen={showCreateModal}
          onClose={() => {
            setShowCreateModal(false);
            resetForm();
          }}
          title={editMode ? (t('editStockRejection') || 'Edit Stock Rejection') : (t('createStockRejection') || 'Create Stock Rejection')}
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('product') || 'Product'} *
                </label>
                <select
                  value={formData.product_id}
                  onChange={(e) => handleProductChange(e.target.value)}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="">{t('selectProduct') || 'Select Product'}</option>
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.product_name} ({product.product_code})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('batch') || 'Batch'} *
                </label>
                <select
                  value={formData.batch_id}
                  onChange={(e) => setFormData({ ...formData, batch_id: e.target.value })}
                  required
                  disabled={!formData.product_id}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100"
                >
                  <option value="">{t('selectBatch') || 'Select Batch'}</option>
                  {batches.map((batch) => (
                    <option key={batch.id} value={batch.id}>
                      {batch.batch_number} (Stock: {batch.current_stock})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('rejectionDate') || 'Rejection Date'} *
                </label>
                <input
                  type="date"
                  value={formData.rejection_date}
                  onChange={(e) => setFormData({ ...formData, rejection_date: e.target.value })}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('quantityRejected') || 'Quantity Rejected (Kg)'} *
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={formData.quantity_rejected || ''}
                  onChange={(e) => setFormData({ ...formData, quantity_rejected: parseFloat(e.target.value) })}
                  required
                  min="0.01"
                  placeholder="Enter quantity in Kg"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('rejectionReason') || 'Rejection Reason'} *
                </label>
                <select
                  value={formData.rejection_reason}
                  onChange={(e) => setFormData({ ...formData, rejection_reason: e.target.value })}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="quality_failed">{t('qualityFailed') || 'Quality Failed'}</option>
                  <option value="expired">{t('expired') || 'Expired'}</option>
                  <option value="damaged">{t('damaged') || 'Damaged'}</option>
                  <option value="contaminated">{t('contaminated') || 'Contaminated'}</option>
                  <option value="other">{t('other') || 'Other'}</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('disposition') || 'Disposition'}
                </label>
                <select
                  value={formData.disposition}
                  onChange={(e) => setFormData({ ...formData, disposition: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="pending">{t('pending') || 'Pending'}</option>
                  <option value="scrap">{t('scrap') || 'Scrap'}</option>
                  <option value="return_to_supplier">{t('returnToSupplier') || 'Return to Supplier'}</option>
                  <option value="rework">{t('rework') || 'Rework'}</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('rejectionDetails') || 'Rejection Details'} *
              </label>
              <textarea
                value={formData.rejection_details}
                onChange={(e) => setFormData({ ...formData, rejection_details: e.target.value })}
                required
                rows={3}
                placeholder={t('describeRejectionReason') || 'Describe the reason for rejection in detail...'}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('inspectionReport') || 'Inspection Report'} (Optional)
              </label>
              <textarea
                value={formData.inspection_report}
                onChange={(e) => setFormData({ ...formData, inspection_report: e.target.value })}
                rows={3}
                placeholder={t('enterInspectionReport') || 'Enter inspection report details...'}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                {t('photos') || 'Photos'} ({photos.length})
              </label>
              <div className="space-y-3">
                <label className="flex items-center justify-center px-4 py-3 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-blue-400 transition-colors">
                  <Camera className="w-5 h-5 mr-2 text-gray-400" />
                  <span className="text-sm text-gray-600">{t('uploadPhotos') || 'Upload Photos'}</span>
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handlePhotoChange}
                    className="hidden"
                  />
                </label>

                {photoUrls.length > 0 && (
                  <div className="grid grid-cols-3 gap-2">
                    {photoUrls.map((url, index) => (
                      <div key={index} className="relative">
                        <img src={url} alt={`Photo ${index + 1}`} className="w-full h-24 object-cover rounded-lg" />
                        <button
                          type="button"
                          onClick={() => removePhoto(index)}
                          className="absolute top-1 right-1 bg-red-600 text-white rounded-full p-1 hover:bg-red-700"
                        >
                          <XCircle className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 flex items-start">
              <AlertTriangle className="w-5 h-5 text-yellow-600 mr-2 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-yellow-800">
                <p className="font-medium">{t('approvalRequired') || 'Approval Required'}</p>
                <p className="mt-1">
                  {t('rejectionApprovalNote') ||
                    'Rejections under $100 require manager approval. Over $100 require manager approval. Over $1000 require admin approval.'}
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-4">
              <button
                type="button"
                onClick={() => {
                  setShowCreateModal(false);
                  resetForm();
                }}
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
              >
                {t('cancel') || 'Cancel'}
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
              >
                {editMode ? (t('updateRejection') || 'Update Rejection') : (t('createRejection') || 'Create Rejection')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {showDetailsModal && selectedRejection && (
        <StockRejectionView
          rejection={selectedRejection}
          onClose={() => {
            setShowDetailsModal(false);
            setSelectedRejection(null);
          }}
        />
      )}
    </div>
  );
}
