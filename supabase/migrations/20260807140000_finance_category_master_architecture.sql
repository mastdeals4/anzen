-- Finance Master completion: one canonical, configurable category-to-COA source.
-- Existing transaction keys remain stable; administrators manage labels, hierarchy,
-- tax behaviour and the mandatory posting account from Expense Categories master.

BEGIN;

CREATE TABLE IF NOT EXISTS public.expense_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_key text NOT NULL UNIQUE,
  name text NOT NULL,
  parent_id uuid REFERENCES public.expense_categories(id) ON DELETE RESTRICT,
  category_type text NOT NULL DEFAULT 'operations',
  tax_behavior text NOT NULL DEFAULT 'standard',
  description text,
  coa_account_id uuid NOT NULL REFERENCES public.chart_of_accounts(id) ON DELETE RESTRICT,
  requires_container boolean NOT NULL DEFAULT false,
  allows_account_override boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  icon text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expense_categories_key_format CHECK (category_key ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT expense_categories_type CHECK (category_type IN ('import','sales','staff','operations','admin','assets'))
);

CREATE INDEX IF NOT EXISTS expense_categories_active_sort_idx
  ON public.expense_categories (is_active, sort_order, name);
CREATE INDEX IF NOT EXISTS expense_categories_parent_idx ON public.expense_categories(parent_id);

ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can manage expense categories" ON public.expense_categories;
CREATE POLICY "Authenticated users can manage expense categories"
  ON public.expense_categories FOR ALL TO authenticated
  USING (NOT public.is_read_only_user())
  WITH CHECK (NOT public.is_read_only_user());

CREATE OR REPLACE FUNCTION public.validate_expense_category_master()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account record;
BEGIN
  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'An expense category cannot be its own parent';
  END IF;

  SELECT is_active, is_header INTO v_account
  FROM public.chart_of_accounts
  WHERE id = NEW.coa_account_id;

  IF NOT FOUND OR NOT v_account.is_active OR v_account.is_header THEN
    RAISE EXCEPTION 'Expense category % must use an active posting Chart of Account', NEW.category_key;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_expense_category_master ON public.expense_categories;
CREATE TRIGGER trg_validate_expense_category_master
BEFORE INSERT OR UPDATE OF coa_account_id, parent_id, category_key ON public.expense_categories
FOR EACH ROW EXECUTE FUNCTION public.validate_expense_category_master();

-- Seed all currently supported keys from the existing resolver before replacing it.
-- No COA code is embedded: IDs are taken from the live canonical resolver.
WITH seeds(category_key, name, category_type, tax_behavior, requires_container, allows_account_override, sort_order) AS (
  VALUES
    ('pib_import','PIB Import (BM + PPN + PPh)','import','pib_import',true,false,10),
    ('duty_customs','Duty & Customs (BM)','import','import_duty',true,false,20),
    ('ppn_import','PPN Import','import','input_vat',true,false,30),
    ('pph_import','PPh Import','import','advance_income_tax',true,false,40),
    ('freight_import','Freight (Import)','import','landed_cost',true,false,50),
    ('clearing_forwarding','Clearing & Forwarding','import','landed_cost',true,false,60),
    ('port_charges','Port Charges','import','landed_cost',true,false,70),
    ('container_handling','Container Handling','import','landed_cost',true,false,80),
    ('transport_import','Transportation (Import)','import','landed_cost',true,false,90),
    ('loading_import','Loading / Unloading (Import)','import','landed_cost',true,false,100),
    ('bpom_ski_fees','BPOM / SKI Fees','import','landed_cost',true,false,110),
    ('other_import','Other (Import)','import','landed_cost',true,false,120),
    ('delivery_sales','Delivery / Dispatch (Sales)','sales','standard',false,false,210),
    ('loading_sales','Loading / Unloading (Sales)','sales','standard',false,false,220),
    ('other_sales','Other (Sales)','sales','standard',false,false,230),
    ('salary','Salary','staff','salary',false,false,310),
    ('staff_overtime','Staff Overtime','staff','salary',false,false,320),
    ('staff_welfare','Staff Welfare / Allowances','staff','standard',false,false,330),
    ('non_permanent_employee_fee','Non-Permanent Employee Fee (PPh 21)','staff','withholding',false,false,340),
    ('travel_conveyance','Travel & Conveyance','staff','standard',false,false,350),
    ('staff_advance','Staff Advance','staff','advance',false,false,360),
    ('warehouse_rent','Warehouse Rent','operations','standard',false,false,410),
    ('utilities','Utilities','operations','standard',false,false,420),
    ('bank_charges','Bank Charges','operations','standard',false,false,430),
    ('office_admin','Office & Admin','admin','standard',false,false,510),
    ('office_shifting_renovation','Office Shifting & Renovation','admin','standard',false,false,520),
    ('other','Other','admin','standard',false,false,530),
    ('fixed_asset','Fixed Asset','assets','asset_purchase',false,true,540),
    ('import_broker','Customs Broker Invoice','import','broker_invoice',true,false,550),
    ('professional_services','Professional Services','admin','standard',false,false,560),
    ('marketing_advertising','Marketing & Advertising','sales','standard',false,false,570),
    ('office_supplies','Office Supplies','admin','standard',false,false,580),
    ('electricity','Electricity','operations','standard',false,false,590),
    ('water','Water','operations','standard',false,false,600),
    ('internet_phone','Telephone & Internet','operations','standard',false,false,610),
    ('fuel','Fuel','operations','standard',false,false,620),
    ('vehicle_maintenance','Vehicle Maintenance','operations','standard',false,false,630),
    ('legal_professional','Legal & Professional','admin','standard',false,false,640),
    ('consulting_fees','Consulting Fees','admin','standard',false,false,650),
    ('accounting_audit','Accounting & Audit','admin','standard',false,false,660),
    ('employee_benefits','Employee Benefits','staff','standard',false,false,670),
    ('office_rent','Office Rent','operations','standard',false,false,680),
    ('rent','Rent Expense','operations','standard',false,false,690),
    ('duty_import','Import Duty','import','import_duty',true,false,700),
    ('duty','Duty','import','import_duty',true,false,710),
    ('freight','Freight','import','landed_cost',true,false,720),
    ('office','Office','admin','standard',false,false,730)
), resolved AS (
  SELECT s.*, COALESCE(
    public.get_expense_account_id(s.category_key),
    CASE WHEN s.category_key = 'pib_import' THEN public.get_expense_account_id('duty_customs') END,
    CASE WHEN s.category_key = 'fixed_asset' THEN (
      SELECT id FROM public.chart_of_accounts
      WHERE account_group = 'Fixed Assets' AND account_type = 'asset' AND NOT is_header AND is_active
      ORDER BY code LIMIT 1
    ) END
  ) AS coa_account_id
  FROM seeds s
)
INSERT INTO public.expense_categories (category_key,name,category_type,tax_behavior,requires_container,allows_account_override,sort_order,coa_account_id)
SELECT category_key,name,category_type,tax_behavior,requires_container,allows_account_override,sort_order,coa_account_id
FROM resolved
WHERE coa_account_id IS NOT NULL
ON CONFLICT (category_key) DO NOTHING;

-- Parent categories use the same master and a valid posting account; existing
-- child rows inherit their own COA and therefore still resolve exactly once.
WITH parent_seeds(category_key,name,category_type,sort_order,child_key) AS (
  VALUES
    ('import_costs','Import Costs','import',1,'duty_customs'),
    ('sales_distribution','Sales & Distribution','sales',2,'delivery_sales'),
    ('staff_costs','Staff Costs','staff',3,'salary'),
    ('operations','Operations','operations',4,'utilities'),
    ('administrative','Administrative','admin',5,'office_admin')
)
INSERT INTO public.expense_categories (category_key,name,category_type,tax_behavior,sort_order,coa_account_id)
SELECT p.category_key,p.name,p.category_type,'parent',p.sort_order,c.coa_account_id
FROM parent_seeds p JOIN public.expense_categories c ON c.category_key=p.child_key
ON CONFLICT (category_key) DO NOTHING;

UPDATE public.expense_categories child
SET parent_id = parent.id
FROM public.expense_categories parent
WHERE parent.category_key = CASE
  WHEN child.category_type='import' THEN 'import_costs'
  WHEN child.category_type='sales' THEN 'sales_distribution'
  WHEN child.category_type='staff' THEN 'staff_costs'
  WHEN child.category_type='operations' THEN 'operations'
  WHEN child.category_type IN ('admin','assets') THEN 'administrative'
END
AND child.category_key NOT IN ('import_costs','sales_distribution','staff_costs','operations','administrative');

-- Retire the obsolete plural key.  The stored value now matches the master.
UPDATE public.petty_cash_transactions
SET expense_category='fixed_asset'
WHERE expense_category='fixed_assets';

-- There is now exactly one resolver. Unknown/inactive categories deliberately
-- return NULL; posting validation below blocks them rather than using 6900/6000.
CREATE OR REPLACE FUNCTION public.get_expense_account_id(p_category text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ec.coa_account_id
  FROM public.expense_categories ec
  JOIN public.chart_of_accounts coa ON coa.id=ec.coa_account_id
  WHERE ec.category_key=p_category
    AND ec.is_active
    AND coa.is_active
    AND NOT coa.is_header
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.validate_expense_category_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.expense_category IS NOT NULL AND public.get_expense_account_id(NEW.expense_category) IS NULL THEN
    RAISE EXCEPTION 'This category has no configured Chart of Account.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_finance_expense_category_assignment ON public.finance_expenses;
CREATE TRIGGER trg_validate_finance_expense_category_assignment
BEFORE INSERT OR UPDATE OF expense_category ON public.finance_expenses
FOR EACH ROW EXECUTE FUNCTION public.validate_expense_category_assignment();

DROP TRIGGER IF EXISTS trg_validate_petty_cash_category_assignment ON public.petty_cash_transactions;
CREATE TRIGGER trg_validate_petty_cash_category_assignment
BEFORE INSERT OR UPDATE OF expense_category ON public.petty_cash_transactions
FOR EACH ROW EXECUTE FUNCTION public.validate_expense_category_assignment();

-- Complete COA hierarchy from the existing account-group master labels.
UPDATE public.chart_of_accounts c
SET parent_id=h.id
FROM public.chart_of_accounts h
WHERE c.parent_id IS NULL AND NOT c.is_header AND h.is_header
  AND h.name=c.account_group AND h.id<>c.id;

UPDATE public.chart_of_accounts c
SET parent_id=h.id
FROM public.chart_of_accounts h
WHERE c.parent_id IS NULL AND c.account_group='COGS' AND h.is_header
  AND h.name='Cost of Goods Sold';

UPDATE public.chart_of_accounts
SET account_group='Current Assets'
WHERE name='PPN Masukan (Input VAT)' AND account_group IS NULL;
UPDATE public.chart_of_accounts
SET account_group='COGS'
WHERE name='BPOM / SKI Registration Fees' AND account_group IS NULL;
UPDATE public.chart_of_accounts
SET account_group='Other Expenses'
WHERE name='Bea Meterai Expense' AND account_group IS NULL;

-- Existing Import Cost Type and Tax Code master columns become complete using
-- the category and COA masters, never a numeric account constant.
UPDATE public.import_cost_types ict
SET account_id=ec.coa_account_id
FROM public.expense_categories ec
WHERE ec.category_key=CASE ict.code
  WHEN 'BM' THEN 'duty_customs' WHEN 'CLEARING' THEN 'clearing_forwarding'
  WHEN 'FREIGHT' THEN 'freight_import' WHEN 'INSURANCE' THEN 'other_import'
  WHEN 'OTHER' THEN 'other_import' WHEN 'PORT' THEN 'port_charges'
  WHEN 'PPH22' THEN 'pph_import' WHEN 'PPN_IMP' THEN 'ppn_import'
  WHEN 'TRUCKING' THEN 'transport_import' END
  AND ict.account_id IS NULL;

UPDATE public.tax_codes tc
SET collection_account_id=coa.id
FROM public.chart_of_accounts coa
WHERE tc.collection_account_id IS NULL AND coa.is_active AND NOT coa.is_header
  AND coa.name=CASE tc.tax_type
    WHEN 'PPN' THEN 'PPN Output (VAT Payable)'
    WHEN 'PPh21' THEN 'PPh 21 Payable'
    WHEN 'PPh22' THEN 'PPh 22 Payable'
    WHEN 'PPh23' THEN 'PPh 23 Payable'
    WHEN 'PPh25' THEN 'PPh 25 Payable'
    WHEN 'PPh4(2)' THEN 'PPh 4(2) Payable' END;

UPDATE public.tax_codes tc
SET payment_account_id=coa.id
FROM public.chart_of_accounts coa
WHERE tc.payment_account_id IS NULL AND coa.is_active AND NOT coa.is_header
  AND coa.name=CASE WHEN tc.tax_type='PPN' THEN 'PPN Masukan (Input VAT)' ELSE
    CASE tc.tax_type
      WHEN 'PPh21' THEN 'PPh 21 Payable' WHEN 'PPh22' THEN 'PPh 22 Payable'
      WHEN 'PPh23' THEN 'PPh 23 Payable' WHEN 'PPh25' THEN 'PPh 25 Payable'
      WHEN 'PPh4(2)' THEN 'PPh 4(2) Payable' END END;

REVOKE ALL ON FUNCTION public.get_expense_account_id(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_expense_account_id(text) TO authenticated;

COMMENT ON TABLE public.expense_categories IS 'Single canonical category master for Expenses, Petty Cash and future expense modules.';
COMMENT ON FUNCTION public.get_expense_account_id(text) IS 'Returns only the active master-configured posting account. Unknown categories have no fallback.';

NOTIFY pgrst, 'reload schema';
COMMIT;
