import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Layout } from '../components/Layout';
import { useAuth } from '../contexts/AuthContext';
import {
  Plus, Search, Filter, Clock, CheckCircle2, AlertCircle,
  Calendar, User, Tag, Flame, ArrowUp, Minus, Circle,
  MessageSquare, Paperclip, ExternalLink, MoreVertical,
  Eye, Edit, Trash2
} from 'lucide-react';
import { TaskDetailModal } from '../components/tasks/TaskDetailModal';
import { TaskFormModal } from '../components/tasks/TaskFormModal';

interface Task {
  id: string;
  title: string;
  description: string | null;
  deadline: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'to_do' | 'in_progress' | 'waiting' | 'completed';
  created_by: string;
  assigned_users: string[];
  inquiry_id: string | null;
  customer_id: string | null;
  product_id: string | null;
  attachment_urls: string[];
  tags: string[];
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  comment_count?: number;
  creator_name?: string;
  assignee_names?: string[];
  inquiry_number?: string;
  customer_name?: string;
  product_name?: string;
}

interface FilterState {
  status: string[];
  priority: string[];
  assignedTo: string[];
  view: 'all' | 'my-tasks' | 'pending' | 'completed' | 'overdue';
}

export function Tasks() {
  const { user, profile } = useAuth();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filteredTasks, setFilteredTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [showTaskDetail, setShowTaskDetail] = useState(false);
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [showTaskMenu, setShowTaskMenu] = useState<string | null>(null);

  const [filters, setFilters] = useState<FilterState>({
    status: [],
    priority: [],
    assignedTo: [],
    view: 'my-tasks'
  });

  const [stats, setStats] = useState({
    total: 0,
    pending: 0,
    completed: 0,
    overdue: 0
  });

  useEffect(() => {
    loadTasks();
  }, [user]);

  useEffect(() => {
    applyFilters();
  }, [tasks, filters, searchQuery]);

  const loadTasks = async () => {
    try {
      setLoading(true);

      let query = supabase
        .from('tasks')
        .select(`
          *,
          creator:created_by(full_name),
          inquiry:crm_inquiries(inquiry_number),
          customer:customers(company_name),
          product:products(product_name)
        `)
        .eq('is_deleted', false)
        .order('deadline', { ascending: true });

      const { data, error } = await query;

      if (error) throw error;

      // Get comment counts for each task
      const taskIds = data?.map(t => t.id) || [];
      const { data: commentCounts } = await supabase
        .from('task_comments')
        .select('task_id')
        .in('task_id', taskIds)
        .eq('is_deleted', false);

      const commentCountMap: { [key: string]: number } = {};
      commentCounts?.forEach(c => {
        commentCountMap[c.task_id] = (commentCountMap[c.task_id] || 0) + 1;
      });

      const tasksWithDetails = (data || []).map(task => ({
        ...task,
        creator_name: task.creator?.full_name,
        inquiry_number: task.inquiry?.inquiry_number,
        customer_name: task.customer?.company_name,
        product_name: task.product?.product_name,
        comment_count: commentCountMap[task.id] || 0
      }));

      setTasks(tasksWithDetails);
      calculateStats(tasksWithDetails);
    } catch (error) {
      console.error('Error loading tasks:', error);
    } finally {
      setLoading(false);
    }
  };

  const calculateStats = (taskList: Task[]) => {
    const now = new Date();
    const myTasks = taskList.filter(t =>
      t.assigned_users.includes(user?.id || '') || t.created_by === user?.id
    );

    setStats({
      total: myTasks.length,
      pending: myTasks.filter(t => t.status !== 'completed').length,
      completed: myTasks.filter(t => t.status === 'completed').length,
      overdue: myTasks.filter(t =>
        t.status !== 'completed' && new Date(t.deadline) < now
      ).length
    });
  };

  const applyFilters = () => {
    let filtered = [...tasks];

    // Apply view filter
    if (filters.view === 'my-tasks') {
      filtered = filtered.filter(t =>
        t.assigned_users.includes(user?.id || '') || t.created_by === user?.id
      );
    } else if (filters.view === 'pending') {
      filtered = filtered.filter(t =>
        t.status !== 'completed' &&
        (t.assigned_users.includes(user?.id || '') || t.created_by === user?.id)
      );
    } else if (filters.view === 'completed') {
      filtered = filtered.filter(t =>
        t.status === 'completed' &&
        (t.assigned_users.includes(user?.id || '') || t.created_by === user?.id)
      );
    } else if (filters.view === 'overdue') {
      const now = new Date();
      filtered = filtered.filter(t =>
        t.status !== 'completed' &&
        new Date(t.deadline) < now &&
        (t.assigned_users.includes(user?.id || '') || t.created_by === user?.id)
      );
    }

    // Apply status filter
    if (filters.status.length > 0) {
      filtered = filtered.filter(t => filters.status.includes(t.status));
    }

    // Apply priority filter
    if (filters.priority.length > 0) {
      filtered = filtered.filter(t => filters.priority.includes(t.priority));
    }

    // Apply search
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(t =>
        t.title.toLowerCase().includes(query) ||
        t.description?.toLowerCase().includes(query) ||
        t.customer_name?.toLowerCase().includes(query) ||
        t.product_name?.toLowerCase().includes(query) ||
        t.inquiry_number?.toLowerCase().includes(query)
      );
    }

    setFilteredTasks(filtered);
  };

  const getPriorityIcon = (priority: string) => {
    switch (priority) {
      case 'urgent':
        return <Flame className="w-4 h-4 text-red-600" />;
      case 'high':
        return <ArrowUp className="w-4 h-4 text-orange-600" />;
      case 'medium':
        return <Minus className="w-4 h-4 text-yellow-600" />;
      default:
        return <Circle className="w-4 h-4 text-gray-400" />;
    }
  };

  const getStatusBadge = (status: string) => {
    const styles = {
      to_do: 'bg-gray-100 text-gray-700',
      in_progress: 'bg-blue-100 text-blue-700',
      waiting: 'bg-orange-100 text-orange-700',
      completed: 'bg-green-100 text-green-700'
    };

    const labels = {
      to_do: 'To Do',
      in_progress: 'In Progress',
      waiting: 'Waiting',
      completed: 'Completed'
    };

    return (
      <span className={`px-2 py-1 rounded-full text-xs font-medium ${styles[status as keyof typeof styles]}`}>
        {labels[status as keyof typeof labels]}
      </span>
    );
  };

  const formatDeadline = (deadline: string) => {
    const date = new Date(deadline);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffMs < 0) {
      return <span className="text-red-600 font-medium">Overdue</span>;
    } else if (diffHours < 24) {
      return <span className="text-orange-600 font-medium">Due in {diffHours}h</span>;
    } else if (diffDays < 7) {
      return <span className="text-yellow-600 font-medium">Due in {diffDays}d</span>;
    } else {
      return <span className="text-gray-600">{date.toLocaleDateString()}</span>;
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    if (!confirm('Are you sure you want to delete this task?')) return;

    try {
      const { error } = await supabase
        .from('tasks')
        .update({ is_deleted: true, deleted_at: new Date().toISOString(), deleted_by: user?.id })
        .eq('id', taskId);

      if (error) throw error;
      loadTasks();
    } catch (error) {
      console.error('Error deleting task:', error);
      alert('Failed to delete task');
    }
  };

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Tasks</h1>
            <p className="text-gray-600 mt-1">Manage and track team assignments</p>
          </div>
          <button
            onClick={() => setShowCreateTask(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
          >
            <Plus className="w-5 h-5" />
            New Task
          </button>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white p-4 rounded-lg border border-gray-200">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <CheckCircle2 className="w-6 h-6 text-blue-600" />
              </div>
              <div>
                <p className="text-sm text-gray-600">Total Tasks</p>
                <p className="text-2xl font-bold text-gray-900">{stats.total}</p>
              </div>
            </div>
          </div>

          <div className="bg-white p-4 rounded-lg border border-gray-200">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-yellow-100 rounded-lg">
                <Clock className="w-6 h-6 text-yellow-600" />
              </div>
              <div>
                <p className="text-sm text-gray-600">Pending</p>
                <p className="text-2xl font-bold text-gray-900">{stats.pending}</p>
              </div>
            </div>
          </div>

          <div className="bg-white p-4 rounded-lg border border-gray-200">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-100 rounded-lg">
                <CheckCircle2 className="w-6 h-6 text-green-600" />
              </div>
              <div>
                <p className="text-sm text-gray-600">Completed</p>
                <p className="text-2xl font-bold text-gray-900">{stats.completed}</p>
              </div>
            </div>
          </div>

          <div className="bg-white p-4 rounded-lg border border-gray-200">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-red-100 rounded-lg">
                <AlertCircle className="w-6 h-6 text-red-600" />
              </div>
              <div>
                <p className="text-sm text-gray-600">Overdue</p>
                <p className="text-2xl font-bold text-gray-900">{stats.overdue}</p>
              </div>
            </div>
          </div>
        </div>

        {/* View Tabs and Search */}
        <div className="bg-white rounded-lg border border-gray-200">
          <div className="p-4 border-b border-gray-200">
            <div className="flex flex-col sm:flex-row gap-4 justify-between">
              {/* View Tabs */}
              <div className="flex gap-2 flex-wrap">
                {[
                  { value: 'my-tasks', label: 'My Tasks' },
                  { value: 'pending', label: 'Pending' },
                  { value: 'completed', label: 'Completed' },
                  { value: 'overdue', label: 'Overdue' },
                  { value: 'all', label: 'All Tasks' }
                ].map(view => (
                  <button
                    key={view.value}
                    onClick={() => setFilters({ ...filters, view: view.value as any })}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                      filters.view === view.value
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {view.label}
                  </button>
                ))}
              </div>

              {/* Search and Filter */}
              <div className="flex gap-2">
                <div className="relative flex-1 sm:flex-none sm:w-64">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                  <input
                    type="text"
                    placeholder="Search tasks..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <button
                  onClick={() => setShowFilters(!showFilters)}
                  className={`px-4 py-2 border rounded-lg transition ${
                    showFilters ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  <Filter className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Filters Panel */}
            {showFilters && (
              <div className="mt-4 pt-4 border-t border-gray-200 grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Status</label>
                  <div className="space-y-2">
                    {['to_do', 'in_progress', 'waiting', 'completed'].map(status => (
                      <label key={status} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={filters.status.includes(status)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setFilters({ ...filters, status: [...filters.status, status] });
                            } else {
                              setFilters({ ...filters, status: filters.status.filter(s => s !== status) });
                            }
                          }}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-sm text-gray-700 capitalize">{status.replace('_', ' ')}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Priority</label>
                  <div className="space-y-2">
                    {['urgent', 'high', 'medium', 'low'].map(priority => (
                      <label key={priority} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={filters.priority.includes(priority)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setFilters({ ...filters, priority: [...filters.priority, priority] });
                            } else {
                              setFilters({ ...filters, priority: filters.priority.filter(p => p !== priority) });
                            }
                          }}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-sm text-gray-700 capitalize">{priority}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="flex items-end">
                  <button
                    onClick={() => setFilters({ ...filters, status: [], priority: [], assignedTo: [] })}
                    className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                  >
                    Clear All Filters
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Task List */}
          <div className="divide-y divide-gray-200">
            {filteredTasks.length === 0 ? (
              <div className="p-12 text-center">
                <CheckCircle2 className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-900 mb-2">No tasks found</h3>
                <p className="text-gray-600 mb-6">
                  {searchQuery || filters.status.length > 0 || filters.priority.length > 0
                    ? 'Try adjusting your filters or search query'
                    : 'Create your first task to get started'}
                </p>
                {!searchQuery && filters.status.length === 0 && (
                  <button
                    onClick={() => setShowCreateTask(true)}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
                  >
                    <Plus className="w-5 h-5" />
                    Create Task
                  </button>
                )}
              </div>
            ) : (
              filteredTasks.map(task => (
                <div
                  key={task.id}
                  className="p-4 hover:bg-gray-50 transition cursor-pointer"
                  onClick={() => {
                    setSelectedTask(task);
                    setShowTaskDetail(true);
                  }}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      {/* Priority Icon */}
                      <div className="mt-1">
                        {getPriorityIcon(task.priority)}
                      </div>

                      {/* Task Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start gap-2">
                          <h3 className="font-medium text-gray-900 truncate">{task.title}</h3>
                          {task.attachment_urls.length > 0 && (
                            <Paperclip className="w-4 h-4 text-gray-400 flex-shrink-0" />
                          )}
                        </div>

                        {task.description && (
                          <p className="text-sm text-gray-600 mt-1 line-clamp-2">{task.description}</p>
                        )}

                        <div className="flex flex-wrap items-center gap-3 mt-2">
                          {getStatusBadge(task.status)}

                          <div className="flex items-center gap-1 text-sm text-gray-600">
                            <Calendar className="w-4 h-4" />
                            {formatDeadline(task.deadline)}
                          </div>

                          {task.comment_count > 0 && (
                            <div className="flex items-center gap-1 text-sm text-gray-600">
                              <MessageSquare className="w-4 h-4" />
                              {task.comment_count}
                            </div>
                          )}

                          {task.inquiry_number && (
                            <div className="flex items-center gap-1 text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded">
                              <ExternalLink className="w-3 h-3" />
                              {task.inquiry_number}
                            </div>
                          )}

                          {task.customer_name && (
                            <div className="flex items-center gap-1 text-xs text-gray-600 bg-gray-100 px-2 py-1 rounded">
                              <User className="w-3 h-3" />
                              {task.customer_name}
                            </div>
                          )}

                          {task.tags.length > 0 && (
                            <div className="flex items-center gap-1 text-xs text-gray-600">
                              <Tag className="w-3 h-3" />
                              {task.tags[0]}
                              {task.tags.length > 1 && ` +${task.tags.length - 1}`}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="relative">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowTaskMenu(showTaskMenu === task.id ? null : task.id);
                        }}
                        className="p-1 hover:bg-gray-100 rounded transition"
                      >
                        <MoreVertical className="w-5 h-5 text-gray-600" />
                      </button>

                      {showTaskMenu === task.id && (
                        <div className="absolute right-0 mt-1 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-10">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedTask(task);
                              setShowTaskDetail(true);
                              setShowTaskMenu(null);
                            }}
                            className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
                          >
                            <Eye className="w-4 h-4" />
                            View Details
                          </button>
                          {(task.created_by === user?.id || profile?.role === 'admin') && (
                            <>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  // Edit functionality
                                  setShowTaskMenu(null);
                                }}
                                className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
                              >
                                <Edit className="w-4 h-4" />
                                Edit Task
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteTask(task.id);
                                  setShowTaskMenu(null);
                                }}
                                className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
                              >
                                <Trash2 className="w-4 h-4" />
                                Delete Task
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Modals */}
      {showCreateTask && (
        <TaskFormModal
          isOpen={showCreateTask}
          onClose={() => setShowCreateTask(false)}
          onSuccess={() => {
            setShowCreateTask(false);
            loadTasks();
          }}
        />
      )}

      {showTaskDetail && selectedTask && (
        <TaskDetailModal
          isOpen={showTaskDetail}
          onClose={() => {
            setShowTaskDetail(false);
            setSelectedTask(null);
          }}
          taskId={selectedTask.id}
          onUpdate={loadTasks}
        />
      )}
    </Layout>
  );
}
