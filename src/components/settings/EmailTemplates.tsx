import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { FileText, Plus, Edit2, Trash2, Copy, CheckCircle, XCircle } from 'lucide-react';
import { Modal } from '../Modal';

interface EmailTemplate {
  id: string;
  template_name: string;
  subject: string;
  body: string;
  category: string;
  variables: string[];
  use_count: number;
  is_active: boolean;
  created_at: string;
}

export function EmailTemplates() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<EmailTemplate | null>(null);
  const [formData, setFormData] = useState({
    template_name: '',
    subject: '',
    body: '',
    category: 'custom',
    variables: [] as string[],
  });

  const categories = [
    { value: 'price_quote', label: 'Price Quote' },
    { value: 'coa_msds', label: 'COA/MSDS' },
    { value: 'follow_up', label: 'Follow-up' },
    { value: 'thank_you', label: 'Thank You' },
    { value: 'custom', label: 'Custom' },
  ];

  const availableVariables = [
    '{{contact_person}}',
    '{{company_name}}',
    '{{product_name}}',
    '{{specification}}',
    '{{quantity}}',
    '{{supplier_name}}',
    '{{supplier_country}}',
    '{{inquiry_number}}',
    '{{user_name}}',
  ];

  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    try {
      const { data, error } = await supabase
        .from('crm_email_templates')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setTemplates(data || []);
    } catch (error) {
      console.error('Error loading templates:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      if (editingTemplate) {
        const { error } = await supabase
          .from('crm_email_templates')
          .update({
            template_name: formData.template_name,
            subject: formData.subject,
            body: formData.body,
            category: formData.category,
            variables: formData.variables,
            updated_at: new Date().toISOString(),
          })
          .eq('id', editingTemplate.id);

        if (error) throw error;
        alert('Template updated successfully!');
      } else {
        const { error } = await supabase
          .from('crm_email_templates')
          .insert([{
            ...formData,
            created_by: user.id,
            is_active: true,
            use_count: 0,
          }]);

        if (error) throw error;
        alert('Template created successfully!');
      }

      resetForm();
      setShowModal(false);
      loadTemplates();
    } catch (error: any) {
      console.error('Error saving template:', error);
      alert(error.message || 'Failed to save template');
    }
  };

  const handleEdit = (template: EmailTemplate) => {
    setEditingTemplate(template);
    setFormData({
      template_name: template.template_name,
      subject: template.subject,
      body: template.body,
      category: template.category,
      variables: template.variables || [],
    });
    setShowModal(true);
  };

  const handleDuplicate = async (template: EmailTemplate) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('crm_email_templates')
        .insert([{
          template_name: `${template.template_name} (Copy)`,
          subject: template.subject,
          body: template.body,
          category: template.category,
          variables: template.variables,
          created_by: user.id,
          is_active: true,
          use_count: 0,
        }]);

      if (error) throw error;
      alert('Template duplicated successfully!');
      loadTemplates();
    } catch (error) {
      console.error('Error duplicating template:', error);
      alert('Failed to duplicate template');
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Are you sure you want to delete "${name}"?`)) return;

    try {
      const { error } = await supabase
        .from('crm_email_templates')
        .delete()
        .eq('id', id);

      if (error) throw error;
      alert('Template deleted successfully!');
      loadTemplates();
    } catch (error) {
      console.error('Error deleting template:', error);
      alert('Failed to delete template');
    }
  };

  const toggleActive = async (id: string, currentStatus: boolean) => {
    try {
      const { error } = await supabase
        .from('crm_email_templates')
        .update({ is_active: !currentStatus })
        .eq('id', id);

      if (error) throw error;
      loadTemplates();
    } catch (error) {
      console.error('Error updating template:', error);
      alert('Failed to update template status');
    }
  };

  const insertVariable = (variable: string) => {
    setFormData(prev => ({
      ...prev,
      body: prev.body + ' ' + variable,
      variables: prev.variables.includes(variable) ? prev.variables : [...prev.variables, variable],
    }));
  };

  const resetForm = () => {
    setEditingTemplate(null);
    setFormData({
      template_name: '',
      subject: '',
      body: '',
      category: 'custom',
      variables: [],
    });
  };


  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <FileText className="w-5 h-5" />
            Email Templates
          </h3>
          <p className="text-sm text-gray-600 mt-1">
            Create and manage reusable email templates with variable placeholders
          </p>
        </div>
        <button
          onClick={() => {
            resetForm();
            setShowModal(true);
          }}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          New Template
        </button>
      </div>

      {/* Template List */}
      <div className="grid grid-cols-1 gap-4">
        {templates.length === 0 ? (
          <div className="text-center py-12 bg-gray-50 rounded-lg border border-gray-200">
            <FileText className="w-12 h-12 text-gray-400 mx-auto mb-3" />
            <p className="text-gray-600">No templates found</p>
            <button
              onClick={() => setShowModal(true)}
              className="mt-4 text-blue-600 hover:text-blue-700 font-medium"
            >
              Create your first template
            </button>
          </div>
        ) : (
          templates.map((template) => (
            <div
              key={template.id}
              className="p-4 bg-white rounded-lg border border-gray-200 hover:border-gray-300 transition"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <h4 className="font-semibold text-gray-900">{template.template_name}</h4>
                    <span className="px-2 py-0.5 text-xs bg-gray-100 text-gray-700 rounded">
                      {categories.find(c => c.value === template.category)?.label || template.category}
                    </span>
                  </div>
                  <p className="text-sm text-gray-600 mb-2">
                    <strong>Subject:</strong> {template.subject}
                  </p>
                  <div className="flex items-center gap-4 text-xs text-gray-500">
                    <span>Used {template.use_count} times</span>
                    {template.variables?.length > 0 && (
                      <span>Variables: {template.variables.length}</span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => toggleActive(template.id, template.is_active)}
                    className={`p-2 rounded-lg transition ${
                      template.is_active
                        ? 'text-green-600 hover:bg-green-50'
                        : 'text-gray-400 hover:bg-gray-50'
                    }`}
                    title={template.is_active ? 'Active' : 'Inactive'}
                  >
                    {template.is_active ? (
                      <CheckCircle className="w-4 h-4" />
                    ) : (
                      <XCircle className="w-4 h-4" />
                    )}
                  </button>

                  <button
                    onClick={() => handleDuplicate(template)}
                    className="p-2 text-gray-600 hover:bg-gray-50 rounded-lg transition"
                    title="Duplicate"
                  >
                    <Copy className="w-4 h-4" />
                  </button>

                  <button
                    onClick={() => handleEdit(template)}
                    className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition"
                    title="Edit"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>

                  <button
                    onClick={() => handleDelete(template.id, template.template_name)}
                    className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Template Modal */}
      <Modal
        isOpen={showModal}
        onClose={() => {
          setShowModal(false);
          resetForm();
        }}
        title={editingTemplate ? 'Edit Template' : 'Create New Template'}
      >
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Template Name *
            </label>
            <input
              type="text"
              value={formData.template_name}
              onChange={(e) => setFormData({ ...formData, template_name: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              required
              placeholder="e.g., Price Quote - English"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Category *
            </label>
            <select
              value={formData.category}
              onChange={(e) => setFormData({ ...formData, category: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              required
            >
              {categories.map(cat => (
                <option key={cat.value} value={cat.value}>{cat.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email Subject *
            </label>
            <input
              type="text"
              value={formData.subject}
              onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              required
              placeholder="Use variables like {{product_name}}"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email Body (HTML) *
            </label>
            <div className="mb-2 flex flex-wrap gap-1">
              {availableVariables.map(variable => (
                <button
                  key={variable}
                  type="button"
                  onClick={() => insertVariable(variable)}
                  className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 rounded"
                >
                  {variable}
                </button>
              ))}
            </div>
            <textarea
              value={formData.body}
              onChange={(e) => setFormData({ ...formData, body: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              rows={15}
              placeholder="Enter email template body..."
            />
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button
              type="button"
              onClick={() => {
                setShowModal(false);
                resetForm();
              }}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              {editingTemplate ? 'Update Template' : 'Create Template'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
