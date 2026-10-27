import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { Modal } from '../Modal';
import {
  Calendar, User, Tag, Paperclip, X, Loader, Search,
  FileText, AlertCircle
} from 'lucide-react';
import { FloatingField, FLOAT_INPUT, FLOAT_TEXTAREA } from '../finance/FloatingField';
import { SapRow } from '../finance/SapLayout';

interface TaskFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  initialData?: {
    inquiry_id?: string;
    customer_id?: string;
    product_id?: string;
  };
}

interface UserProfile {
  id: string;
  full_name: string;
  email: string;
  role: string;
}

interface EntityOption {
  id: string;
  label: string;
}

export function TaskFormModal({ isOpen, onClose, onSuccess, initialData }: TaskFormModalProps) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [inquiries, setInquiries] = useState<EntityOption[]>([]);
  const [customers, setCustomers] = useState<EntityOption[]>([]);
  const [products, setProducts] = useState<EntityOption[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Form fields
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [deadline, setDeadline] = useState('');
  const [deadlineTime, setDeadlineTime] = useState('');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high' | 'urgent'>('medium');
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [selectedInquiry, setSelectedInquiry] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState('');
  const [selectedProduct, setSelectedProduct] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);

  // Search states
  const [userSearch, setUserSearch] = useState('');
  const [showUserDropdown, setShowUserDropdown] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadUsers();
      loadInquiries();
      loadCustomers();
      loadProducts();

      // Set initial values from initialData
      if (initialData) {
        setSelectedInquiry(initialData.inquiry_id || '');
        setSelectedCustomer(initialData.customer_id || '');
        setSelectedProduct(initialData.product_id || '');
      }

      // Set default deadline to tomorrow
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      setDeadline(tomorrow.toISOString().split('T')[0]);
      setDeadlineTime('17:00');
    }
  }, [isOpen, initialData]);

  const loadUsers = async () => {
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('id, full_name, email, role')
        .eq('is_active', true)
        .order('full_name');

      if (error) throw error;
      setUsers(data || []);
    } catch (error) {
      console.error('Error loading users:', error);
    }
  };

  const loadInquiries = async () => {
    try {
      const { data, error } = await supabase
        .from('crm_inquiries')
        .select('id, inquiry_number, company_name, product_name')
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) throw error;

      setInquiries((data || []).map(i => ({
        id: i.id,
        label: `${i.inquiry_number} - ${i.company_name} (${i.product_name})`
      })));
    } catch (error) {
      console.error('Error loading inquiries:', error);
    }
  };

  const loadCustomers = async () => {
    try {
      const { data, error } = await supabase
        .from('customers')
        .select('id, company_name, contact_person')
        .eq('is_active', true)
        .order('company_name');

      if (error) throw error;

      setCustomers((data || []).map(c => ({
        id: c.id,
        label: `${c.company_name}${c.contact_person ? ` (${c.contact_person})` : ''}`
      })));
    } catch (error) {
      console.error('Error loading customers:', error);
    }
  };

  const loadProducts = async () => {
    try {
      const { data, error } = await supabase
        .from('products')
        .select('id, product_name, product_code')
        .eq('is_active', true)
        .order('product_name');

      if (error) throw error;

      setProducts((data || []).map(p => ({
        id: p.id,
        label: `${p.product_name}${p.product_code ? ` (${p.product_code})` : ''}`
      })));
    } catch (error) {
      console.error('Error loading products:', error);
    }
  };

  const toggleUserSelection = (userId: string) => {
    if (selectedUsers.includes(userId)) {
      setSelectedUsers(selectedUsers.filter(id => id !== userId));
    } else {
      setSelectedUsers([...selectedUsers, userId]);
    }
  };

  const addTag = () => {
    if (tagInput.trim() && !tags.includes(tagInput.trim())) {
      setTags([...tags, tagInput.trim()]);
      setTagInput('');
    }
  };

  const removeTag = (tag: string) => {
    setTags(tags.filter(t => t !== tag));
  };

  const uploadFiles = async (taskId: string): Promise<string[]> => {
    const uploadedUrls: string[] = [];

    for (const file of selectedFiles) {
      const fileName = `${Date.now()}_${file.name}`;
      const filePath = `tasks/${taskId}/${fileName}`;

      const { error } = await supabase.storage
        .from('task-attachments')
        .upload(filePath, file);

      if (error) {
        console.error('Error uploading file:', error);
      } else {
        uploadedUrls.push(filePath);
      }
    }

    return uploadedUrls;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!title.trim()) {
      alert('Please enter a task title');
      return;
    }

    if (!deadline || !deadlineTime) {
      alert('Please set a deadline');
      return;
    }

    if (selectedUsers.length === 0) {
      alert('Please assign at least one user');
      return;
    }

    try {
      setLoading(true);

      // Combine date and time
      const deadlineDateTime = `${deadline}T${deadlineTime}:00`;

      // Create task
      const taskData = {
        title: title.trim(),
        description: description.trim() || null,
        deadline: deadlineDateTime,
        priority,
        created_by: user?.id,
        assigned_users: selectedUsers,
        inquiry_id: selectedInquiry || null,
        customer_id: selectedCustomer || null,
        product_id: selectedProduct || null,
        tags
      };

      const { data: newTask, error: taskError } = await supabase
        .from('tasks')
        .insert([taskData])
        .select()
        .single();

      if (taskError) throw taskError;

      // Upload files if any
      if (selectedFiles.length > 0 && newTask) {
        const uploadedUrls = await uploadFiles(newTask.id);

        // Update task with attachment URLs
        const { error: updateError } = await supabase
          .from('tasks')
          .update({ attachment_urls: uploadedUrls })
          .eq('id', newTask.id);

        if (updateError) throw updateError;
      }

      // Create task assignments
      const assignments = selectedUsers.map(userId => ({
        task_id: newTask.id,
        assigned_user_id: userId,
        assigned_by: user?.id
      }));

      const { error: assignError } = await supabase
        .from('task_assignments')
        .insert(assignments);

      if (assignError) throw assignError;

      onSuccess();
    } catch (error) {
      console.error('Error creating task:', error);
      alert('Failed to create task. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const filteredUsers = users.filter(u =>
    u.full_name?.toLowerCase().includes(userSearch.toLowerCase()) ||
    u.email?.toLowerCase().includes(userSearch.toLowerCase())
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create New Task" size="lg">
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Title */}
        <SapRow>
          <FloatingField label="Task Title" required span={12} filled={!!title.trim()}>
            <input name="title" aria-label="e.g., Send quotation to customer"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Send quotation to customer"
              className={FLOAT_INPUT}
              required
            />
          </FloatingField>
        </SapRow>

        {/* Description */}
        <SapRow>
          <FloatingField label="Description" span={12} textarea filled={!!description.trim()}>
            <textarea name="description" aria-label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add detailed instructions or notes..."
              className={FLOAT_TEXTAREA}
              rows={4}
            />
          </FloatingField>
        </SapRow>

        {/* Deadline and Priority */}
        <SapRow>
          <FloatingField label="Deadline Date" required span={4} filled={!!deadline}>
            <input name="deadline" aria-label="Deadline"
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              className={FLOAT_INPUT}
              required
            />
          </FloatingField>

          <FloatingField label="Deadline Time" required span={4} filled={!!deadlineTime}>
            <input name="deadline_time" aria-label="Deadline Time"
              type="time"
              value={deadlineTime}
              onChange={(e) => setDeadlineTime(e.target.value)}
              className={FLOAT_INPUT}
              required
            />
          </FloatingField>

          <FloatingField label="Priority" required span={4} filled={!!priority}>
            <select name="priority" aria-label="Priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as any)}
              className={FLOAT_INPUT}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </FloatingField>
        </SapRow>

        {/* Assign Users */}
        <SapRow>
          <FloatingField label="Assign To" required span={12} filled={!!userSearch.trim() || selectedUsers.length > 0}
            right={<Search className="w-4 h-4 text-gray-400" />}
          >
            <input name="user_search" aria-label="Search users..."
              type="text"
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              onFocus={() => setShowUserDropdown(true)}
              placeholder="Search users..."
              className={FLOAT_INPUT}
            />
          </FloatingField>

          {showUserDropdown && (
            <div className="sm:col-span-12">
              <div className="relative">
                <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                  {filteredUsers.map(u => (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => toggleUserSelection(u.id)}
                      className={`w-full px-3 py-2 text-left hover:bg-gray-50 flex items-center justify-between ${
                        selectedUsers.includes(u.id) ? 'bg-blue-50' : ''
                      }`}
                    >
                      <div>
                        <p className="text-sm font-medium text-gray-900">{u.full_name}</p>
                        <p className="text-xs text-gray-500">{u.email} • {u.role}</p>
                      </div>
                      {selectedUsers.includes(u.id) && (
                        <div className="w-5 h-5 bg-blue-600 rounded-full flex items-center justify-center">
                          <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Selected Users */}
          {selectedUsers.length > 0 && (
            <div className="sm:col-span-12 flex flex-wrap gap-2 mt-2">
              {selectedUsers.map(userId => {
                const user = users.find(u => u.id === userId);
                return (
                  <span
                    key={userId}
                    className="inline-flex items-center gap-1 px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-sm"
                  >
                    {user?.full_name}
                    <button
                      type="button"
                      onClick={() => toggleUserSelection(userId)}
                      className="text-blue-600 hover:text-blue-800"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
        </SapRow>

        {/* Entity Linking */}
        <SapRow>
          <FloatingField label="Related Inquiry" span={4} filled={!!selectedInquiry}>
            <select name="related_inquiry" aria-label="Related Inquiry"
              value={selectedInquiry}
              onChange={(e) => setSelectedInquiry(e.target.value)}
              className={FLOAT_INPUT}
            >
              <option value="">None</option>
              {inquiries.map(i => (
                <option key={i.id} value={i.id}>{i.label}</option>
              ))}
            </select>
          </FloatingField>

          <FloatingField label="Related Customer" span={4} filled={!!selectedCustomer}>
            <select name="related_customer" aria-label="Related Customer"
              value={selectedCustomer}
              onChange={(e) => setSelectedCustomer(e.target.value)}
              className={FLOAT_INPUT}
            >
              <option value="">None</option>
              {customers.map(c => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </FloatingField>

          <FloatingField label="Related Product" span={4} filled={!!selectedProduct}>
            <select name="related_product" aria-label="Related Product"
              value={selectedProduct}
              onChange={(e) => setSelectedProduct(e.target.value)}
              className={FLOAT_INPUT}
            >
              <option value="">None</option>
              {products.map(p => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </FloatingField>
        </SapRow>

        {/* Tags */}
        <SapRow>
          <FloatingField label="Tags" span={8} filled={!!tagInput.trim()}>
            <input name="tags" aria-label="Tags"
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), addTag())}
              placeholder="Add tag and press Enter"
              className={FLOAT_INPUT}
            />
          </FloatingField>
          <div className="sm:col-span-4 flex items-end pb-0.5">
            <button
              type="button"
              onClick={addTag}
              className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg transition"
            >
              Add
            </button>
          </div>

          {tags.length > 0 && (
            <div className="sm:col-span-12 flex flex-wrap gap-2 mt-2">
              {tags.map(tag => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-3 py-1 bg-gray-100 text-gray-700 rounded-full text-sm"
                >
                  <Tag className="w-3 h-3" />
                  {tag}
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    className="text-gray-500 hover:text-red-600"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </SapRow>

        {/* File Attachments */}
        <SapRow>
          <FloatingField label="Attachments" span={12} staticLabel>
            <input name="attachments" aria-label="Attachments"
              ref={fileInputRef}
              type="file"
              multiple
              onChange={(e) => {
                if (e.target.files) {
                  setSelectedFiles(Array.from(e.target.files));
                }
              }}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
            >
              <Paperclip className="w-4 h-4" />
              Choose Files
            </button>
          </FloatingField>

          {selectedFiles.length > 0 && (
            <div className="sm:col-span-12 mt-2 space-y-2">
              {selectedFiles.map((file, idx) => (
                <div key={idx} className="flex items-center justify-between p-2 bg-gray-50 border border-gray-200 rounded-lg">
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-gray-500" />
                    <span className="text-sm text-gray-700">{file.name}</span>
                    <span className="text-xs text-gray-500">
                      ({(file.size / 1024).toFixed(1)} KB)
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedFiles(files => files.filter((_, i) => i !== idx))}
                    className="text-red-600 hover:text-red-700"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </SapRow>

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-4 border-t">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading || !title.trim() || selectedUsers.length === 0}
            className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? (
              <>
                <Loader className="w-4 h-4 animate-spin" />
                Creating...
              </>
            ) : (
              'Create Task'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
