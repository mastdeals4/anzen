import {
  EnquiryAssignedTeam,
  EnquiryRequest,
  EnquiryRequestCategory,
  EnquiryRequestStatus,
  EnquiryWaitingFor,
} from './request.types';

/**
 * Lightweight summary of an enquiry request for the main operational grid.
 */
export interface EnquiryRequestGridItem {
  id: string;
  category: EnquiryRequestCategory;
  request_code: string;
  title: string;
  customer_requirement: string;
  status: EnquiryRequestStatus;
  waiting_for: EnquiryWaitingFor | string;
  current_issue: string | null;
  next_action: string | null;
  assigned_to: string | null;
  assigned_team: EnquiryAssignedTeam | null;
  due_at: string | null;
  reminder_level: number;
  created_at: string;
}

/**
 * Summary statistics of all requests for an enquiry.
 */
export interface EnquiryRequestStats {
  total: number;
  open: number;
  inProgress: number;
  blocked: number;
  resolved: number;
  cancelled: number;
  overdue: number;
}

/**
 * Deterministic derived operational summary for an enquiry.
 * Contains no fabricated text.
 */
export interface EnquiryOperationalSummary {
  currentBlocker: string | null;
  waitingFor: EnquiryWaitingFor | string;
  waitingForSummary: string;
  waitingForBreakdown: Record<string, number>;
  nextAction: string | null;
  stats: EnquiryRequestStats;
  primaryOwner: {
    id: string | null;
    name: string | null;
    team: EnquiryAssignedTeam | string | null;
  };
}

/**
 * Customer / contact summary associated with an enquiry.
 */
export interface EnquiryCustomerSummary {
  crmContactId: string | null;
  erpCustomerId: string | null;
  companyName: string;
  contactPerson: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  isErpCustomer: boolean;
}

/**
 * Age computation details for an enquiry.
 */
export interface EnquiryAgeInfo {
  days: number;
  label: string; // e.g. "Today", "1d", "3d", "14d"
  urgency: 'today' | 'recent' | 'attention' | 'ageing';
  referenceDate: string; // YYYY-MM-DD or ISO string used
}

/**
 * Due deadline computation details for an enquiry.
 */
export interface EnquiryDueInfo {
  dueAt: string | null;
  isOverdue: boolean;
  daysUntilDue: number | null;
  dueLabel: string | null; // e.g. "Overdue (-2d)", "Due Today", "+3d"
}

/**
 * Complete read model row for the Enquiry Control Center table.
 * Derived deterministically from crm_inquiries + enquiry_requests + user_profiles + crm_contacts.
 */
export interface EnquiryControlCenterRow {
  id: string;
  inquiryNumber: string;
  inquiryDate: string;
  createdAt: string;
  updatedAt: string;

  // Commercial & Product fields
  productName: string;
  specification: string | null;
  quantity: string | null;
  isMultiProduct: boolean;
  hasItems: boolean;

  // Pipeline & Status fields
  pipelineStatus: string;
  priority: string;
  priceReady: boolean;
  quoteStatus: string | null;
  quoteSentAt: string | null;
  convertedToOrder: string | null;

  // Ownership
  assignedTo: string | null;
  assignedToName: string | null;

  // Customer
  customer: EnquiryCustomerSummary;

  // Operational derivations
  age: EnquiryAgeInfo;
  due: EnquiryDueInfo;
  operationalSummary: EnquiryOperationalSummary;

  // Lightweight request micro-badges
  requests: EnquiryRequestGridItem[];

  // Remarks / notes
  remarks: string | null;
  internalNotes: string | null;
}

/**
 * Query filter parameters for the Control Center query.
 */
export interface EnquiryControlCenterQueryParams {
  page?: number;
  pageSize?: number;
  search?: string;
  pipelineStatus?: 'all' | 'active' | string;
  priority?: string;
  assignedTo?: string;
  waitingFor?: string;
  blockedOnly?: boolean;
  overdueOnly?: boolean;
  priceReadyOnly?: boolean;
  sortBy?: 'inquiry_date' | 'created_at' | 'inquiry_number' | 'priority';
  sortDirection?: 'asc' | 'desc';
}

/**
 * Paginated query result for the Control Center.
 */
export interface EnquiryControlCenterQueryResult {
  rows: EnquiryControlCenterRow[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  countsByPipeline: Record<string, number>;
  countsByWaitingFor: Record<string, number>;
  countsOverdue: number;
  countsBlocked: number;
  countsPriceReady: number;
}
