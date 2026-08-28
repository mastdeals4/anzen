import { supabase } from '../lib/supabase';

export type FinanceCurrency = 'IDR' | 'USD';

export interface FinanceExpensePayload {
  expense_date: string;
  expense_category: string;
  amount: number;
  description?: string | null;
  document_urls?: string[];
  transaction_currency: FinanceCurrency;
  functional_currency?: 'IDR';
  exchange_rate: number;
  payment_method?: string | null;
  bank_account_id?: string | null;
  payment_reference?: string | null;
  approval_status?: string;
  created_by?: string;
  [key: string]: unknown;
}

export interface ReceiptPayload {
  voucher_date: string;
  customer_id: string;
  payment_method: string;
  bank_account_id?: string | null;
  reference_number?: string | null;
  amount: number;
  description?: string | null;
  transaction_currency: FinanceCurrency;
  exchange_rate: number;
  created_by?: string;
}

export interface ReceiptAllocation {
  sales_invoice_id?: string | null;
  sales_order_id?: string | null;
  amount: number;
}

export interface PaymentPayload {
  voucher_date: string;
  supplier_id?: string | null;
  staff_id?: string | null;
  payment_method: string;
  payment_purpose?: 'general' | 'salary_advance' | 'salary_advance_settlement';
  bank_account_id?: string | null;
  reference_number?: string | null;
  amount: number;
  invoice_currency?: FinanceCurrency;
  invoice_amount?: number;
  payment_amount?: number;
  bank_currency?: FinanceCurrency;
  converted_amount?: number;
  actual_bank_debit?: number;
  pph_amount?: number;
  pph_code_id?: string | null;
  description?: string | null;
  document_urls?: string[];
  payment_currency: FinanceCurrency;
  exchange_rate: number;
  bank_amount?: number | null;
  bank_charge?: number;
  created_by?: string;
}

export interface JournalLineCommand {
  account_id: string;
  description?: string | null;
  debit: number;
  credit: number;
}

export interface FinanceLoanPayload {
  loan_date: string;
  counterparty_name: string;
  counterparty_type: 'bank' | 'person' | 'staff' | 'company';
  principal_amount: number;
  bank_account_id: string;
  liability_kind: 'bank';
  transaction_currency: FinanceCurrency;
  exchange_rate: number;
  description?: string | null;
  created_by?: string;
}

export interface FinanceLoanRepaymentPayload {
  loan_id: string;
  transaction_date: string;
  principal_amount: number;
  interest_amount: number;
  bank_account_id: string;
  transaction_currency: FinanceCurrency;
  exchange_rate: number;
  description?: string | null;
  created_by?: string;
}

export interface CapitalContributionPayload {
  voucher_date: string;
  bank_account_id: string;
  amount: number;
  transaction_currency: FinanceCurrency;
  exchange_rate: number;
  description?: string | null;
  created_by?: string;
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data as T;
}

/** Shared existing USD→IDR resolver used when a normal USD document does not
 * carry a transaction-specific conversion rate. Fund Transfers continue to
 * supply their own business rate. */
export const getReportingUsdRate = async (): Promise<number> => {
  const rate = await rpc<number>('get_reporting_usd_rate', {});
  if (!Number.isFinite(rate) || rate <= 1) throw new Error('Unable to resolve a valid USD-to-IDR rate');
  return rate;
};

export const saveFinanceExpense = (expenseId: string | null, payload: FinanceExpensePayload) =>
  rpc<string>('save_finance_expense', { p_expense_id: expenseId, p_payload: payload });

export const saveAndLinkFinanceExpense = (
  expenseId: string | null,
  payload: FinanceExpensePayload,
  bankStatementLineId: string,
  allocationAmount?: number,
  approvedBy?: string | null,
  applySalaryAdvances = false,
) => rpc<string>('save_and_link_finance_expense_atomic', {
  p_expense_id: expenseId,
  p_payload: payload,
  p_bank_statement_line_id: bankStatementLineId,
  p_allocation_amount: allocationAmount ?? null,
  p_approved_by: approvedBy || null,
  p_apply_salary_advances: applySalaryAdvances,
});

export const editApprovedFinanceExpense = (
  expenseId: string,
  payload: FinanceExpensePayload,
  bankStatementLineId?: string | null,
  allocationAmount?: number,
) => rpc<string>('edit_approved_finance_expense_atomic', {
  p_expense_id: expenseId,
  p_payload: payload,
  p_bank_statement_line_id: bankStatementLineId || null,
  p_allocation_amount: allocationAmount ?? null,
});

export const approveFinanceExpense = (expenseId: string, approvedBy?: string | null) =>
  rpc<string>('approve_finance_expense', { p_expense_id: expenseId, p_approved_by: approvedBy || null });

export const saveReceiptVoucher = (
  receiptId: string | null,
  payload: ReceiptPayload,
  allocations: ReceiptAllocation[],
) => rpc<string>('save_receipt_voucher_with_allocations', {
  p_receipt_id: receiptId,
  p_payload: payload,
  p_allocations: allocations,
});

export const savePaymentVoucher = (
  voucherId: string | null,
  payload: PaymentPayload,
  allocations: Record<string, unknown>[],
) => rpc<{ id: string; voucher_number: string }>('save_payment_voucher_with_purpose', {
  p_voucher_id: voucherId,
  p_payload: payload,
  p_allocations: allocations,
  p_payment_purpose: payload.payment_purpose || 'general',
});

export const saveFinanceJournal = (
  entryId: string | null,
  entryDate: string,
  description: string | null,
  lines: JournalLineCommand[],
  transactionCurrency: FinanceCurrency,
  exchangeRate: number,
) => rpc<string>('save_finance_journal', {
  p_entry_id: entryId,
  p_entry_date: entryDate,
  p_description: description,
  p_lines: lines,
  p_transaction_currency: transactionCurrency,
  p_exchange_rate: exchangeRate,
});

export const saveFinanceLoan = (payload: FinanceLoanPayload, bankStatementLineId?: string | null) =>
  rpc<{ id: string; loan_number: string; journal_entry_id: string }>('save_finance_loan', {
    p_payload: payload,
    p_bank_statement_line_id: bankStatementLineId || null,
  });

export const saveFinanceLoanRepayment = (
  payload: FinanceLoanRepaymentPayload,
  bankStatementLineId?: string | null,
) => rpc<{ id: string; transaction_number: string; journal_entry_id: string }>('save_finance_loan_repayment', {
  p_payload: payload,
  p_bank_statement_line_id: bankStatementLineId || null,
});

export const saveCapitalContribution = (
  payload: CapitalContributionPayload,
  bankStatementLineId?: string | null,
) => rpc<{ id: string; voucher_number: string; journal_entry_id: string }>('save_finance_capital_contribution', {
  p_payload: payload,
  p_bank_statement_line_id: bankStatementLineId || null,
});

export const saveBankLinkedFinanceJournal = (
  bankStatementLineId: string,
  description: string,
  counterAccountCode: string,
  bankSide: 'debit' | 'credit',
  transactionCurrency: FinanceCurrency,
  exchangeRate: number,
) => rpc<{ document_id: string; journal_entry_id: string }>('save_bank_linked_finance_journal', {
  p_bank_line_id: bankStatementLineId,
  p_description: description,
  p_counter_account_code: counterAccountCode,
  p_bank_side: bankSide,
  p_transaction_currency: transactionCurrency,
  p_exchange_rate: exchangeRate,
});

export const linkBankStatementLine = (
  bankLineId: string,
  documentType: 'expense' | 'receipt' | 'payment' | 'fund_transfer' | 'petty_cash' | 'tax_payment' | 'journal',
  documentId: string,
  paymentKind: 'supplier' | 'pph23' = 'supplier',
  allocationAmount?: number,
) => {
  const payload = {
    p_bank_line_id: bankLineId,
    p_document_type: documentType,
    p_document_id: documentId,
    p_payment_kind: paymentKind,
    ...(allocationAmount === undefined ? {} : { p_allocation_amount: allocationAmount }),
  };
  return rpc<{
  allocation_amount: number;
  bank_total: number;
  bank_allocated: number;
  bank_remaining: number;
  document_total: number;
  document_allocated: number;
  document_remaining: number;
  }>('link_bank_statement_line', payload);
};

export const unlinkBankStatementAllocation = (allocationId: string) =>
  rpc<{ success: boolean; bank_line_id: string; allocation_id: string }>('unmatch_bank_statement_allocation', {
    p_allocation_id: allocationId,
  });

export const unlinkBankStatementLine = (bankLineId: string) =>
  rpc<{ success: boolean; bank_line_id: string }>('unmatch_bank_line', {
    p_bank_line_id: bankLineId,
  });

export const unlinkFinanceExpenseBankLink = (expenseId: string, reason?: string) =>
  rpc<{ success: boolean; expense_id: string; released_allocations: number }>(
    'unlink_finance_expense_bank_atomic',
    {
      p_expense_id: expenseId,
      p_reason: reason || 'Bank statement link removed by user',
    },
  );
