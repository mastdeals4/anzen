import { supabase } from '../../lib/supabase';
import {
  EnquiryControlCenterQueryParams,
  EnquiryControlCenterQueryResult,
  EnquiryControlCenterRow,
  EnquiryCustomerSummary,
  EnquiryRequestGridItem,
} from '../../types/enquiry/controlCenter.types';
import {
  deriveEnquiryAge,
  deriveEnquiryDueInfo,
  deriveOperationalSummary,
} from './enquiryControlCenterResolvers';

export class EnquiryControlCenterService {
  /**
   * Fetches paginated enquiries with lightweight request summaries and deterministic
   * operational state (blocker, waiting party, next action, age, due info).
   *
   * Adheres to:
   *  - Zero duplicate tables (reads directly from crm_inquiries + enquiry_requests)
   *  - Respects existing Supabase RLS and user authentication
   *  - Never fabricates blockers, waiting parties, or next actions
   *  - Gracefully handles historical enquiries with zero enquiry_requests
   */
  static async getControlCenterEnquiries(
    params: EnquiryControlCenterQueryParams = {}
  ): Promise<EnquiryControlCenterQueryResult> {
    const {
      page = 1,
      pageSize = 25,
      search,
      pipelineStatus = 'active',
      priority,
      assignedTo,
      waitingFor,
      blockedOnly = false,
      overdueOnly = false,
      priceReadyOnly = false,
      sortBy = 'created_at',
      sortDirection = 'desc',
    } = params;

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    // Build the query
    let query = supabase
      .from('crm_inquiries')
      .select(
        `
        id,
        inquiry_number,
        inquiry_date,
        company_name,
        contact_person,
        contact_email,
        contact_phone,
        product_name,
        specification,
        quantity,
        status,
        pipeline_status,
        priority,
        price_ready,
        quote_status,
        quote_sent_at,
        converted_to_order,
        assigned_to,
        crm_contact_id,
        customer_id,
        is_multi_product,
        has_items,
        remarks,
        internal_notes,
        created_at,
        updated_at,
        user_profiles!assigned_to(id, full_name),
        crm_contacts!crm_contact_id(id, company_name, contact_person, email, phone),
        enquiry_requests(
          id,
          category,
          request_code,
          title,
          customer_requirement,
          status,
          waiting_for,
          current_issue,
          next_action,
          assigned_to,
          assigned_team,
          due_at,
          reminder_level,
          created_at
        )
      `,
        { count: 'exact' }
      );

    // Filter pipeline status
    if (pipelineStatus === 'active') {
      query = query.neq('pipeline_status', 'lost');
    } else if (pipelineStatus && pipelineStatus !== 'all') {
      query = query.eq('pipeline_status', pipelineStatus);
    }

    // Filter priority
    if (priority) {
      query = query.eq('priority', priority);
    }

    // Filter owner
    if (assignedTo) {
      query = query.eq('assigned_to', assignedTo);
    }

    // Filter price ready
    if (priceReadyOnly) {
      query = query.eq('price_ready', true);
    }

    // Search pattern
    if (search && search.trim()) {
      const cleanSearch = search.trim();
      query = query.or(
        `inquiry_number.ilike.%${cleanSearch}%,company_name.ilike.%${cleanSearch}%,product_name.ilike.%${cleanSearch}%`
      );
    }

    // Sorting
    query = query.order(sortBy, { ascending: sortDirection === 'asc' });

    // Pagination
    query = query.range(from, to);

    const { data, count, error } = await query;

    if (error) {
      console.error('[EnquiryControlCenterService] Query error:', error);
      throw error;
    }

    const nowMs = Date.now();
    const rawRows = data || [];

    // Map each raw enquiry to an EnquiryControlCenterRow
    let mappedRows: EnquiryControlCenterRow[] = rawRows.map((row: any) => {
      const requests: EnquiryRequestGridItem[] = (row.enquiry_requests || []).map((r: any) => ({
        id: r.id,
        category: r.category,
        request_code: r.request_code,
        title: r.title,
        customer_requirement: r.customer_requirement,
        status: r.status,
        waiting_for: r.waiting_for,
        current_issue: r.current_issue || null,
        next_action: r.next_action || null,
        assigned_to: r.assigned_to || null,
        assigned_team: r.assigned_team || null,
        due_at: r.due_at || null,
        reminder_level: r.reminder_level ?? 0,
        created_at: r.created_at,
      }));

      // Contact details resolution (prefer crm_contacts, fallback to row fields)
      const crmContact = row.crm_contacts;

      const customer: EnquiryCustomerSummary = {
        crmContactId: row.crm_contact_id || null,
        erpCustomerId: row.customer_id || null,
        companyName:
          crmContact?.company_name || row.company_name || 'Unknown Company',
        contactPerson: crmContact?.contact_person || row.contact_person || null,
        contactEmail: crmContact?.email || row.contact_email || null,
        contactPhone: crmContact?.phone || row.contact_phone || null,
        isErpCustomer: !!row.customer_id,
      };

      const assignedToName = row.user_profiles?.full_name || null;

      // Deterministic operational derivations
      const age = deriveEnquiryAge(row.inquiry_date, row.created_at, nowMs);
      const due = deriveEnquiryDueInfo(requests, nowMs);
      const operationalSummary = deriveOperationalSummary(
        row.assigned_to || null,
        assignedToName,
        requests,
        nowMs
      );

      return {
        id: row.id,
        inquiryNumber: row.inquiry_number,
        inquiryDate: row.inquiry_date || row.created_at?.split('T')[0] || '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        productName: row.product_name || '',
        specification: row.specification || null,
        quantity: row.quantity || null,
        isMultiProduct: Boolean(row.is_multi_product),
        hasItems: Boolean(row.has_items),
        pipelineStatus: row.pipeline_status || row.status || 'new',
        priority: row.priority || 'medium',
        priceReady: Boolean(row.price_ready),
        quoteStatus: row.quote_status || null,
        quoteSentAt: row.quote_sent_at || null,
        convertedToOrder: row.converted_to_order || null,
        assignedTo: row.assigned_to || null,
        assignedToName,
        customer,
        age,
        due,
        operationalSummary,
        requests,
        remarks: row.remarks || null,
        internalNotes: row.internal_notes || null,
      };
    });

    // Optional post-filters (if user requested specific request-derived filters)
    if (waitingFor) {
      mappedRows = mappedRows.filter(
        r => r.operationalSummary.waitingFor.toUpperCase() === waitingFor.toUpperCase()
      );
    }

    if (blockedOnly) {
      mappedRows = mappedRows.filter(r => r.operationalSummary.stats.blocked > 0);
    }

    if (overdueOnly) {
      mappedRows = mappedRows.filter(r => r.due.isOverdue);
    }

    // Compute quick filter counts across the loaded set
    const countsByPipeline: Record<string, number> = {};
    const countsByWaitingFor: Record<string, number> = {};
    let countsOverdue = 0;
    let countsBlocked = 0;
    let countsPriceReady = 0;

    for (const r of mappedRows) {
      const pStage = r.pipelineStatus;
      countsByPipeline[pStage] = (countsByPipeline[pStage] || 0) + 1;

      const wFor = r.operationalSummary.waitingFor;
      countsByWaitingFor[wFor] = (countsByWaitingFor[wFor] || 0) + 1;

      if (r.due.isOverdue) countsOverdue++;
      if (r.operationalSummary.stats.blocked > 0) countsBlocked++;
      if (r.priceReady) countsPriceReady++;
    }

    const totalCount = count ?? mappedRows.length;
    const totalPages = Math.ceil(totalCount / pageSize);

    return {
      rows: mappedRows,
      totalCount,
      page,
      pageSize,
      totalPages,
      countsByPipeline,
      countsByWaitingFor,
      countsOverdue,
      countsBlocked,
      countsPriceReady,
    };
  }

  /**
   * Fetches a single enquiry by ID with its complete Control Center read model.
   */
  static async getControlCenterEnquiryById(
    inquiryId: string
  ): Promise<EnquiryControlCenterRow | null> {
    if (!inquiryId) return null;

    const { data, error } = await supabase
      .from('crm_inquiries')
      .select(
        `
        id,
        inquiry_number,
        inquiry_date,
        company_name,
        contact_person,
        contact_email,
        contact_phone,
        product_name,
        specification,
        quantity,
        status,
        pipeline_status,
        priority,
        price_ready,
        quote_status,
        quote_sent_at,
        converted_to_order,
        assigned_to,
        crm_contact_id,
        customer_id,
        is_multi_product,
        has_items,
        remarks,
        internal_notes,
        created_at,
        updated_at,
        user_profiles!assigned_to(id, full_name),
        crm_contacts!crm_contact_id(id, company_name, contact_person, email, phone),
        enquiry_requests(
          id,
          category,
          request_code,
          title,
          customer_requirement,
          status,
          waiting_for,
          current_issue,
          next_action,
          assigned_to,
          assigned_team,
          due_at,
          reminder_level,
          created_at
        )
      `
      )
      .eq('id', inquiryId)
      .maybeSingle();

    if (error) {
      console.error('[EnquiryControlCenterService] Single query error:', error);
      throw error;
    }

    if (!data) return null;

    const nowMs = Date.now();
    const row = data as any;

    const requests: EnquiryRequestGridItem[] = (row.enquiry_requests || []).map((r: any) => ({
      id: r.id,
      category: r.category,
      request_code: r.request_code,
      title: r.title,
      customer_requirement: r.customer_requirement,
      status: r.status,
      waiting_for: r.waiting_for,
      current_issue: r.current_issue || null,
      next_action: r.next_action || null,
      assigned_to: r.assigned_to || null,
      assigned_team: r.assigned_team || null,
      due_at: r.due_at || null,
      reminder_level: r.reminder_level ?? 0,
      created_at: r.created_at,
    }));

    const crmContact = row.crm_contacts;

    const customer: EnquiryCustomerSummary = {
      crmContactId: row.crm_contact_id || null,
      erpCustomerId: row.customer_id || null,
      companyName:
        crmContact?.company_name || row.company_name || 'Unknown Company',
      contactPerson: crmContact?.contact_person || row.contact_person || null,
      contactEmail: crmContact?.email || row.contact_email || null,
      contactPhone: crmContact?.phone || row.contact_phone || null,
      isErpCustomer: !!row.customer_id,
    };

    const assignedToName = row.user_profiles?.full_name || null;
    const age = deriveEnquiryAge(row.inquiry_date, row.created_at, nowMs);
    const due = deriveEnquiryDueInfo(requests, nowMs);
    const operationalSummary = deriveOperationalSummary(
      row.assigned_to || null,
      assignedToName,
      requests,
      nowMs
    );

    return {
      id: row.id,
      inquiryNumber: row.inquiry_number,
      inquiryDate: row.inquiry_date || row.created_at?.split('T')[0] || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      productName: row.product_name || '',
      specification: row.specification || null,
      quantity: row.quantity || null,
      isMultiProduct: Boolean(row.is_multi_product),
      hasItems: Boolean(row.has_items),
      pipelineStatus: row.pipeline_status || row.status || 'new',
      priority: row.priority || 'medium',
      priceReady: Boolean(row.price_ready),
      quoteStatus: row.quote_status || null,
      quoteSentAt: row.quote_sent_at || null,
      convertedToOrder: row.converted_to_order || null,
      assignedTo: row.assigned_to || null,
      assignedToName,
      customer,
      age,
      due,
      operationalSummary,
      requests,
      remarks: row.remarks || null,
      internalNotes: row.internal_notes || null,
    };
  }
}
