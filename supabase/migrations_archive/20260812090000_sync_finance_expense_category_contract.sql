/*
  Synchronise finance_expenses.expense_category with the canonical Expense
  Category Master. This replaces only the stale legacy CHECK allow-list.

  The values below are canonical machine-readable category_key values already
  represented by the existing posting-category master. `utilities` remains as
  a legacy-compatible value for historical expense rows; it is not reactivated
  or rewritten by this migration.
*/

ALTER TABLE public.finance_expenses
  DROP CONSTRAINT IF EXISTS finance_expenses_expense_category_check;

ALTER TABLE public.finance_expenses
  ADD CONSTRAINT finance_expenses_expense_category_check
  CHECK (expense_category = ANY (ARRAY[
    'accounting_audit',
    'bank_charges',
    'bpom_ski_fees',
    'clearing_forwarding',
    'consulting_fees',
    'container_handling',
    'delivery_sales',
    'duty',
    'duty_customs',
    'duty_import',
    'electricity',
    'employee_benefits',
    'facility_maintenance',
    'fixed_asset',
    'freight',
    'freight_import',
    'fuel',
    'import_broker',
    'internet_phone',
    'legal_professional',
    'loading_import',
    'loading_sales',
    'marketing_advertising',
    'non_permanent_employee_fee',
    'office',
    'office_admin',
    'office_rent',
    'office_shifting_renovation',
    'office_supplies',
    'other',
    'other_import',
    'other_sales',
    'pib_import',
    'port_charges',
    'pph_import',
    'ppn_import',
    'professional_services',
    'rent',
    'salary',
    'staff_advance',
    'staff_overtime',
    'staff_welfare',
    'transport_import',
    'travel_conveyance',
    'utilities',
    'vehicle_maintenance',
    'warehouse_rent',
    'water'
  ]));
