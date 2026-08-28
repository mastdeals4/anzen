import { supabase } from '../lib/supabase';

export interface SystemTask {
  id: string;
  title: string;
  description: string | null;
  deadline: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  auto_priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'to_do' | 'in_progress' | 'waiting' | 'completed';
  task_type: 'manual' | 'system';
  task_mode: 'advisory' | 'enforced';
  task_origin: string | null;
  reference_type: string | null;
  reference_id: string | null;
  auto_assigned_role: 'admin' | 'sales' | 'warehouse' | 'accounts' | null;
  assigned_users: string[];
  customer_id: string | null;
  product_id: string | null;
  proof_required: boolean;
  proof_type: string | null;
  proof_url: string | null;
  dismissed_at: string | null;
  dismissed_by: string | null;
  dismissal_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  completed_by: string | null;

  // Relations
  customers?: { company_name: string };
  products?: { product_name: string };
  created_by_user?: { full_name: string; role: string };
}

export interface SystemTaskEvent {
  id: string;
  event_type: string;
  event_source: string;
  event_data: Record<string, any>;
  entity_type: string | null;
  entity_id: string | null;
  task_id: string | null;
  task_created: boolean;
  created_at: string;
  processed_at: string | null;
  error_message: string | null;
}

export interface SystemTaskSummary {
  total_tasks: number;
  urgent_tasks: number;
  overdue_tasks: number;
  today_tasks: number;
  by_origin: Record<string, number>;
}

export class SystemTaskService {
  /**
   * Get all system tasks with optional filtering
   */
  static async getSystemTasks(filters?: {
    status?: string;
    priority?: string;
    taskType?: 'manual' | 'system' | 'all';
    assignedToMe?: boolean;
  }): Promise<SystemTask[]> {
    let query = supabase
      .from('tasks')
      .select(`
        *,
        customers (company_name),
        products (product_name),
        created_by_user:user_profiles!tasks_created_by_fkey (full_name, role)
      `)
      .eq('is_deleted', false)
      .order('deadline', { ascending: true });

    // Filter by task type
    if (filters?.taskType === 'system') {
      query = query.eq('task_type', 'system');
    } else if (filters?.taskType === 'manual') {
      query = query.eq('task_type', 'manual');
    }

    // Filter by status
    if (filters?.status && filters.status !== 'all') {
      query = query.eq('status', filters.status);
    }

    // Filter by priority
    if (filters?.priority && filters.priority !== 'all') {
      query = query.eq('priority', filters.priority);
    }

    // Filter assigned to current user
    if (filters?.assignedToMe) {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        query = query.contains('assigned_users', [user.id]);
      }
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching system tasks:', error);
      throw error;
    }

    return data || [];
  }

  /**
   * Get system tasks summary statistics
   */
  static async getSystemTasksSummary(userRole?: string): Promise<SystemTaskSummary> {
    const { data, error } = await supabase
      .rpc('get_system_tasks_summary', { user_role: userRole || null });

    if (error) {
      console.error('Error fetching system tasks summary:', error);
      throw error;
    }

    return data?.[0] || {
      total_tasks: 0,
      urgent_tasks: 0,
      overdue_tasks: 0,
      today_tasks: 0,
      by_origin: {}
    };
  }

  /**
   * Dismiss a system task (advisory mode - doesn't block workflow)
   */
  static async dismissSystemTask(taskId: string, reason?: string): Promise<boolean> {
    const { data, error } = await supabase
      .rpc('dismiss_system_task', {
        p_task_id: taskId,
        p_reason: reason || null
      });

    if (error) {
      console.error('Error dismissing system task:', error);
      throw error;
    }

    return data === true;
  }

  /**
   * Get system task events (audit trail)
   */
  static async getSystemTaskEvents(filters?: {
    eventType?: string;
    entityType?: string;
    entityId?: string;
    limit?: number;
  }): Promise<SystemTaskEvent[]> {
    let query = supabase
      .from('system_task_events')
      .select('*')
      .order('created_at', { ascending: false });

    if (filters?.eventType) {
      query = query.eq('event_type', filters.eventType);
    }

    if (filters?.entityType) {
      query = query.eq('entity_type', filters.entityType);
    }

    if (filters?.entityId) {
      query = query.eq('entity_id', filters.entityId);
    }

    if (filters?.limit) {
      query = query.limit(filters.limit);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching system task events:', error);
      throw error;
    }

    return data || [];
  }

  /**
   * Check if a task is overdue
   */
  static isOverdue(deadline: string): boolean {
    return new Date(deadline) < new Date();
  }

  /**
   * Check if a task is due today
   */
  static isDueToday(deadline: string): boolean {
    const today = new Date();
    const taskDate = new Date(deadline);
    return (
      taskDate.getDate() === today.getDate() &&
      taskDate.getMonth() === today.getMonth() &&
      taskDate.getFullYear() === today.getFullYear()
    );
  }

  /**
   * Get priority color for UI
   */
  static getPriorityColor(priority: string): string {
    switch (priority) {
      case 'urgent':
        return 'bg-red-100 text-red-700 border-red-300';
      case 'high':
        return 'bg-orange-100 text-orange-700 border-orange-300';
      case 'medium':
        return 'bg-yellow-100 text-yellow-700 border-yellow-300';
      case 'low':
        return 'bg-blue-100 text-blue-700 border-blue-300';
      default:
        return 'bg-gray-100 text-gray-700 border-gray-300';
    }
  }

  /**
   * Get origin label for display
   */
  static getOriginLabel(origin: string | null): string {
    if (!origin) return 'Manual';

    const labels: Record<string, string> = {
      'sales_order_approved': 'Sales Order Approved',
      'sales_order_shortage': 'Stock Shortage',
      'delivery_challan_created': 'Delivery Created',
      'stock_low_alert': 'Low Stock Alert',
      'import_requirement_created': 'Import Required',
      'purchase_order_created': 'Purchase Order',
      'manual': 'Manual'
    };

    return labels[origin] || origin;
  }

  /**
   * Get task type badge style
   */
  static getTaskTypeBadge(taskType: 'manual' | 'system', taskMode?: 'advisory' | 'enforced'): {
    label: string;
    className: string;
  } {
    if (taskType === 'system') {
      return {
        label: taskMode === 'enforced' ? 'SYSTEM - REQUIRED' : 'SYSTEM',
        className: taskMode === 'enforced'
          ? 'bg-red-600 text-white'
          : 'bg-blue-600 text-white'
      };
    }
    return {
      label: 'MANUAL',
      className: 'bg-gray-500 text-white'
    };
  }

  /**
   * Subscribe to system task changes
   */
  static subscribeToSystemTasks(callback: (payload: any) => void) {
    return supabase
      .channel('system-tasks-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tasks',
          filter: 'task_type=eq.system'
        },
        callback
      )
      .subscribe();
  }

  /**
   * Create a manual task (for backwards compatibility)
   */
  static async createManualTask(taskData: {
    title: string;
    description?: string;
    deadline: string;
    priority?: 'low' | 'medium' | 'high' | 'urgent';
    assigned_users?: string[];
    customer_id?: string;
    product_id?: string;
    inquiry_id?: string;
    tags?: string[];
  }) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Not authenticated');

    const { data, error } = await supabase
      .from('tasks')
      .insert({
        ...taskData,
        task_type: 'manual',
        created_by: user.id,
        status: 'to_do'
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating manual task:', error);
      throw error;
    }

    return data;
  }
}
