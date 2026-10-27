export type NotaReturStatus =
  | 'draft'
  | 'ready_for_review'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'cancelled';

export type CoretaxStatus =
  | 'draft'
  | 'ready_for_review'
  | 'submitted'
  | 'approved'
  | 'rejected';

export interface NotaReturItem {
  id?: string;
  nota_retur_id?: string;
  product_id: string;
  batch_id?: string | null;
  material_return_item_id?: string | null;
  product_name?: string | null;
  product_code?: string | null;
  batch_number?: string | null;
  quantity: number;
  unit_price: number;
  dpp_amount: number;
  tax_rate: number;
  ppn_amount: number;
  total_amount: number;
  notes?: string | null;
}

export interface NotaRetur {
  id: string;
  nota_retur_number: string;
  return_date: string;
  customer_id: string;
  customer_name?: string | null;
  customer_npwp?: string | null;
  customer_address?: string | null;
  seller_name?: string | null;
  seller_npwp?: string | null;
  seller_address?: string | null;
  sales_invoice_id?: string | null;
  sales_invoice_number?: string | null;
  original_faktur_pajak_number?: string | null;
  original_faktur_pajak_date?: string | null;
  material_return_id?: string | null;
  material_return_number?: string | null;
  credit_note_id?: string | null;
  credit_note_number?: string | null;
  dpp_amount: number;
  ppn_amount: number;
  total_amount: number;
  status: NotaReturStatus;
  coretax_reference_number?: string | null;
  coretax_submission_date?: string | null;
  coretax_status?: CoretaxStatus | null;
  coretax_response_notes?: string | null;
  tax_period_id?: string | null;
  notes?: string | null;
  created_by?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  created_at?: string;
  updated_at?: string;
  items?: NotaReturItem[];
  customers?: {
    company_name: string;
    npwp?: string | null;
    address?: string | null;
  } | null;
  sales_invoices?: {
    invoice_number: string;
    invoice_date?: string;
    total_amount?: number;
    faktur_pajak_number?: string | null;
  } | null;
  material_returns?: {
    return_number: string;
    return_date: string;
    status: string;
  } | null;
  credit_notes?: {
    credit_note_number: string;
    credit_note_date: string;
    status: string;
  } | null;
}
