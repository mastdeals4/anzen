import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { Modal } from '../Modal';
import {
  Calendar, User, Tag, Paperclip, Send, AtSign, X,
  Download, FileText, Image, File, MessageSquare,
  Clock, CheckCircle2, Loader, Edit2, Trash2
} from 'lucide-react';

interface TaskDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  taskId: string;
  onUpdate: () => void;
}

interface Task {
  id: string;
  title: string;
  description: string | null;
  deadline: string;
  priority: string;
  status: string;
  created_by: string;
  assigned_users: string[];
  inquiry_id: string | null;
  customer_id: string | null;
  product_id: string | null;
  attachment_urls: string[];
  tags: string[];
  completed_at: string | null;
  created_at: string;
  creator_name: string;
  assignee_names: string[];
  inquiry_number?: string;
  customer_name?: string;
  product_name?: string;
}

interface Comment {
  id: string;
  task_id: string;
  comment_text: string;
  user_id: string;
  user_name: string;
  mentions: string[];
  attachment_urls: string[];
  is_edited: boolean;
  created_at: string;
  parent_comment_id: string | null;
}

interface UserProfile {
  id: string;
  full_name: string;
  email: string;
}

export function TaskDetailModal({ isOpen, onClose, taskId, onUpdate }: TaskDetailModalProps) {
  const { user } = useAuth();
  const [task, setTask] = useState<Task | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [commentText, setCommentText] = useState('');
  const [showMentions, setShowMentions] = useState(false);
  const [mentionSearch, setMentionSearch] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isOpen && taskId) {
      loadTaskDetails();
      loadComments();
      loadUsers();
    }
  }, [isOpen, taskId]);

  const loadTaskDetails = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('tasks')
        .select(`
          *,
          creator:created_by(full_name),
          inquiry:crm_inquiries(inquiry_number),
          customer:customers(company_name),
          product:products(name)
        `)
        .eq('id', taskId)
        .single();

      if (error) throw error;

      // Get assignee names
      const assigneeIds = data.assigned_users || [];
      const { data: assignees } = await supabase
        .from('user_profiles')
        .select('id, full_name')
        .in('id', assigneeIds);

      setTask({
        ...data,
        creator_name: data.creator?.full_name,
        assignee_names: assignees?.map(a => a.full_name) || [],
        inquiry_number: data.inquiry?.inquiry_number,
        customer_name: data.customer?.company_name,
        product_name: data.product?.name
      });
    } catch (error) {
      console.error('Error loading task:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadComments = async () => {
    try {
      const { data, error } = await supabase
        .from('task_comments')
        .select(`
          *,
          user:user_id(full_name)
        `)
        .eq('task_id', taskId)
        .eq('is_deleted', false)
        .order('created_at', { ascending: true });

      if (error) throw error;

      setComments((data || []).map(c => ({
        ...c,
        user_name: c.user?.full_name || 'Unknown User'
      })));
    } catch (error) {
      console.error('Error loading comments:', error);
    }
  };

  const loadUsers = async () => {
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('id, full_name, email')
        .eq('is_active', true)
        .order('full_name');

      if (error) throw error;
      setUsers(data || []);
    } catch (error) {
      console.error('Error loading users:', error);
    }
  };

  const handleCommentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setCommentText(value);

    // Check for @ mentions
    const lastWord = value.split(' ').pop() || '';
    if (lastWord.startsWith('@')) {
      setMentionSearch(lastWord.slice(1));
      setShowMentions(true);
    } else {
      setShowMentions(false);
    }
  };

  const insertMention = (userName: string, userId: string) => {
    const words = commentText.split(' ');
    words[words.length - 1] = `@${userName} `;
    setCommentText(words.join(' '));
    setShowMentions(false);
    commentInputRef.current?.focus();
  };

  const extractMentions = (text: string): string[] => {
    const mentionRegex = /@(\w+)/g;
    const mentions: string[] = [];
    let match;

    while ((match = mentionRegex.exec(text)) !== null) {
      const userName = match[1];
      const user = users.find(u => u.full_name.replace(/\s+/g, '') === userName);
      if (user) {
        mentions.push(user.id);
      }
    }

    return mentions;
  };

  const uploadFiles = async (): Promise<string[]> => {
    const uploadedUrls: string[] = [];

    for (const file of selectedFiles) {
      const fileName = `${Date.now()}_${file.name}`;
      const filePath = `tasks/${taskId}/comments/${fileName}`;

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

  const handleAddComment = async () => {
    if (!commentText.trim() && selectedFiles.length === 0) return;

    try {
      setUploading(true);

      // Upload files if any
      const attachmentUrls = await uploadFiles();

      // Extract mentions
      const mentions = extractMentions(commentText);

      // Insert comment
      const { error } = await supabase
        .from('task_comments')
        .insert([{
          task_id: taskId,
          comment_text: commentText,
          user_id: user?.id,
          mentions: mentions,
          attachment_urls: attachmentUrls
        }]);

      if (error) throw error;

      setCommentText('');
      setSelectedFiles([]);
      loadComments();
    } catch (error) {
      console.error('Error adding comment:', error);
      alert('Failed to add comment');
    } finally {
      setUploading(false);
    }
  };

  const handleStatusChange = async (newStatus: string) => {
    try {
      setStatusUpdating(true);

      const { error } = await supabase
        .from('tasks')
        .update({ status: newStatus })
        .eq('id', taskId);

      if (error) throw error;

      loadTaskDetails();
      onUpdate();
    } catch (error) {
      console.error('Error updating status:', error);
      alert('Failed to update status');
    } finally {
      setStatusUpdating(false);
    }
  };

  const getFileIcon = (url: string) => {
    const ext = url.split('.').pop()?.toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext || '')) {
      return <Image className="w-4 h-4" />;
    } else if (['pdf'].includes(ext || '')) {
      return <FileText className="w-4 h-4" />;
    } else {
      return <File className="w-4 h-4" />;
    }
  };

  const downloadFile = async (filePath: string) => {
    try {
      const { data, error } = await supabase.storage
        .from('task-attachments')
        .download(filePath);

      if (error) throw error;

      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url;
      a.download = filePath.split('/').pop() || 'download';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error downloading file:', error);
    }
  };

  const getStatusStyles = (status: string) => {
    const styles = {
      to_do: 'bg-gray-100 text-gray-700 border-gray-300',
      in_progress: 'bg-blue-100 text-blue-700 border-blue-300',
      waiting: 'bg-orange-100 text-orange-700 border-orange-300',
      completed: 'bg-green-100 text-green-700 border-green-300'
    };
    return styles[status as keyof typeof styles] || styles.to_do;
  };

  const getPriorityStyles = (priority: string) => {
    const styles = {
      low: 'bg-gray-100 text-gray-700',
      medium: 'bg-yellow-100 text-yellow-700',
      high: 'bg-orange-100 text-orange-700',
      urgent: 'bg-red-100 text-red-700'
    };
    return styles[priority as keyof typeof styles] || styles.medium;
  };

  if (loading || !task) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title="Loading...">
        <div className="flex items-center justify-center py-12">
          <Loader className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={task.title}
      size="xl"
    >
      <div className="space-y-6">
        {/* Task Header */}
        <div className="flex flex-wrap gap-2">
          <span className={`px-3 py-1 rounded-full text-sm font-medium ${getPriorityStyles(task.priority)}`}>
            {task.priority.toUpperCase()}
          </span>
          <select
            value={task.status}
            onChange={(e) => handleStatusChange(e.target.value)}
            disabled={statusUpdating}
            className={`px-3 py-1 rounded-full text-sm font-medium border-2 ${getStatusStyles(task.status)} cursor-pointer disabled:opacity-50`}
          >
            <option value="to_do">To Do</option>
            <option value="in_progress">In Progress</option>
            <option value="waiting">Waiting</option>
            <option value="completed">Completed</option>
          </select>
        </div>

        {/* Task Description */}
        {task.description && (
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-2">Description</h3>
            <p className="text-gray-900 whitespace-pre-wrap">{task.description}</p>
          </div>
        )}

        {/* Task Details */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-center gap-2 text-sm">
            <Calendar className="w-4 h-4 text-gray-500" />
            <span className="text-gray-700">Deadline:</span>
            <span className="font-medium text-gray-900">
              {new Date(task.deadline).toLocaleString()}
            </span>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <User className="w-4 h-4 text-gray-500" />
            <span className="text-gray-700">Created by:</span>
            <span className="font-medium text-gray-900">{task.creator_name}</span>
          </div>

          {task.assignee_names.length > 0 && (
            <div className="flex items-center gap-2 text-sm">
              <User className="w-4 h-4 text-gray-500" />
              <span className="text-gray-700">Assigned to:</span>
              <span className="font-medium text-gray-900">{task.assignee_names.join(', ')}</span>
            </div>
          )}

          {task.inquiry_number && (
            <div className="flex items-center gap-2 text-sm">
              <Tag className="w-4 h-4 text-gray-500" />
              <span className="text-gray-700">Inquiry:</span>
              <span className="font-medium text-blue-600">{task.inquiry_number}</span>
            </div>
          )}

          {task.customer_name && (
            <div className="flex items-center gap-2 text-sm">
              <User className="w-4 h-4 text-gray-500" />
              <span className="text-gray-700">Customer:</span>
              <span className="font-medium text-gray-900">{task.customer_name}</span>
            </div>
          )}

          {task.product_name && (
            <div className="flex items-center gap-2 text-sm">
              <Tag className="w-4 h-4 text-gray-500" />
              <span className="text-gray-700">Product:</span>
              <span className="font-medium text-gray-900">{task.product_name}</span>
            </div>
          )}
        </div>

        {/* Task Attachments */}
        {task.attachment_urls.length > 0 && (
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
              <Paperclip className="w-4 h-4" />
              Attachments ({task.attachment_urls.length})
            </h3>
            <div className="grid grid-cols-2 gap-2">
              {task.attachment_urls.map((url, idx) => (
                <button
                  key={idx}
                  onClick={() => downloadFile(url)}
                  className="flex items-center gap-2 p-2 border border-gray-200 rounded-lg hover:bg-gray-50 text-left"
                >
                  {getFileIcon(url)}
                  <span className="text-sm text-gray-700 truncate">{url.split('/').pop()}</span>
                  <Download className="w-4 h-4 ml-auto text-gray-400" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Comments Section */}
        <div className="border-t pt-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <MessageSquare className="w-5 h-5" />
            Discussion ({comments.length})
          </h3>

          {/* Comments List */}
          <div className="space-y-4 mb-4 max-h-96 overflow-y-auto">
            {comments.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">No comments yet. Start the discussion!</p>
            ) : (
              comments.map(comment => (
                <div key={comment.id} className="flex gap-3">
                  <div className="flex-shrink-0">
                    <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white font-medium text-sm">
                      {comment.user_name.charAt(0).toUpperCase()}
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="bg-gray-50 rounded-lg p-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-medium text-sm text-gray-900">{comment.user_name}</span>
                        <span className="text-xs text-gray-500">
                          {new Date(comment.created_at).toLocaleString()}
                        </span>
                      </div>
                      <p className="text-sm text-gray-900 whitespace-pre-wrap">{comment.comment_text}</p>

                      {comment.attachment_urls.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {comment.attachment_urls.map((url, idx) => (
                            <button
                              key={idx}
                              onClick={() => downloadFile(url)}
                              className="flex items-center gap-2 text-xs text-blue-600 hover:text-blue-700"
                            >
                              {getFileIcon(url)}
                              {url.split('/').pop()}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Comment Input */}
          <div className="space-y-3">
            <div className="relative">
              <textarea
                ref={commentInputRef}
                value={commentText}
                onChange={handleCommentChange}
                placeholder="Add a comment... Use @ to mention someone"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
                rows={3}
              />

              {/* @Mentions Dropdown */}
              {showMentions && (
                <div className="absolute bottom-full left-0 mb-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto z-10">
                  {users
                    .filter(u => u.full_name.toLowerCase().includes(mentionSearch.toLowerCase()))
                    .slice(0, 5)
                    .map(u => (
                      <button
                        key={u.id}
                        onClick={() => insertMention(u.full_name.replace(/\s+/g, ''), u.id)}
                        className="w-full px-3 py-2 text-left hover:bg-gray-50 flex items-center gap-2"
                      >
                        <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs">
                          {u.full_name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-900">{u.full_name}</p>
                          <p className="text-xs text-gray-500">{u.email}</p>
                        </div>
                      </button>
                    ))}
                </div>
              )}
            </div>

            {/* Selected Files */}
            {selectedFiles.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedFiles.map((file, idx) => (
                  <div key={idx} className="flex items-center gap-2 px-3 py-1 bg-gray-100 rounded-lg text-sm">
                    <Paperclip className="w-4 h-4 text-gray-500" />
                    <span className="text-gray-700">{file.name}</span>
                    <button
                      onClick={() => setSelectedFiles(files => files.filter((_, i) => i !== idx))}
                      className="text-gray-500 hover:text-red-600"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-between items-center">
              <input
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
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition"
              >
                <Paperclip className="w-4 h-4" />
                Attach Files
              </button>

              <button
                onClick={handleAddComment}
                disabled={uploading || (!commentText.trim() && selectedFiles.length === 0)}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
              >
                {uploading ? (
                  <>
                    <Loader className="w-4 h-4 animate-spin" />
                    Posting...
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    Post Comment
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
