-- Migration: Sales Return FIFO COGS Lineage, Bidirectional Linkage, and Profitability
-- Purpose: 
--   1. Add credit_note_id to material_returns with bidirectional sync trigger
--   2. Update _post_credit_note_je to use original transaction FIFO COGS layer
--   3. Update get_sales_profitability_summary to deduct approved returns & COGS reversals

-- 1. Add credit_note_id to material_returns
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'material_returns' AND column_name = 'credit_note_id'
  ) THEN
    ALTER TABLE public.material_returns ADD COLUMN credit_note_id uuid REFERENCES public.credit_notes(id) ON DELETE SET NULL;
  ELSE
    ALTER TABLE public.material_returns 
      DROP CONSTRAINT IF EXISTS material_returns_credit_note_id_fkey,
      ADD CONSTRAINT material_returns_credit_note_id_fkey 
        FOREIGN KEY (credit_note_id) REFERENCES public.credit_notes(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 2. Bidirectional sync trigger between credit_notes and material_returns
CREATE OR REPLACE FUNCTION public.sync_credit_note_material_return()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    IF NEW.material_return_id IS NOT NULL THEN
      UPDATE public.material_returns
      SET credit_note_id = NEW.id,
          credit_note_issued = (NEW.status = 'approved'),
          credit_note_number = NEW.credit_note_number,
          credit_note_amount = NEW.total_amount,
          updated_at = now()
      WHERE id = NEW.material_return_id;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.material_return_id IS NOT NULL THEN
      UPDATE public.material_returns
      SET credit_note_id = NULL,
          credit_note_issued = false,
          credit_note_number = NULL,
          credit_note_amount = NULL,
          updated_at = now()
      WHERE id = OLD.material_return_id;
    END IF;
    RETURN OLD;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_credit_note_return ON public.credit_notes;
CREATE TRIGGER trg_sync_credit_note_return
AFTER INSERT OR UPDATE OF status, total_amount, credit_note_number, material_return_id OR DELETE
ON public.credit_notes
FOR EACH ROW
EXECUTE FUNCTION public.sync_credit_note_material_return();

-- 3. Update _post_credit_note_je to reverse COGS using the original sale transaction FIFO cost layer
CREATE OR REPLACE FUNCTION public._post_credit_note_je(p_cn public.credit_notes)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_je_id         uuid;
  v_je_cogs_id    uuid;
  v_je_number     text;
  v_ar_id         uuid;
  v_return_id     uuid;
  v_ppn_id        uuid;
  v_cogs_id       uuid;
  v_inv_id        uuid;
  v_total_cogs    numeric(18,2) := 0;
  v_item          record;
  v_actor         uuid := COALESCE(p_cn.approved_by, p_cn.created_by);
  v_unit_cogs     numeric(18,4);
BEGIN
  SELECT id INTO v_ar_id     FROM chart_of_accounts WHERE code = '1120';
  SELECT id INTO v_return_id FROM chart_of_accounts WHERE code = '4300';
  SELECT id INTO v_ppn_id    FROM chart_of_accounts WHERE code = '2130';
  SELECT id INTO v_cogs_id   FROM chart_of_accounts WHERE code = '5100';
  SELECT id INTO v_inv_id    FROM chart_of_accounts WHERE code = '1130';

  IF v_ar_id IS NULL OR v_return_id IS NULL THEN
    RAISE EXCEPTION 'Credit Note JE: missing required accounts (1120 A/R or 4300 Sales Returns) in Chart of Accounts';
  END IF;

  -- ── Revenue-reversal JE ──
  v_je_number := public.next_journal_entry_number();

  INSERT INTO journal_entries
    (entry_number, entry_date, source_module, reference_id, reference_number,
     description, total_debit, total_credit, is_posted, posted_by, created_by)
  VALUES
    (v_je_number, p_cn.credit_note_date, 'credit_note', p_cn.id, p_cn.credit_note_number,
     'Credit Note reversal — ' || p_cn.credit_note_number,
     p_cn.total_amount, p_cn.total_amount, true, v_actor, v_actor)
  RETURNING id INTO v_je_id;

  -- Dr Sales Return (subtotal — contra revenue)
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, 1, v_return_id,
          'Sales Return - ' || p_cn.credit_note_number,
          p_cn.subtotal, 0, p_cn.customer_id);

  -- Dr Output PPN (reduces tax liability)
  IF COALESCE(p_cn.tax_amount, 0) > 0 AND v_ppn_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
    VALUES (v_je_id, 2, v_ppn_id,
            'Output PPN reversal - ' || p_cn.credit_note_number,
            p_cn.tax_amount, 0, p_cn.customer_id);
  END IF;

  -- Cr A/R (reduces customer receivable)
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, 3, v_ar_id,
          'A/R reversal - ' || p_cn.credit_note_number,
          0, p_cn.total_amount, p_cn.customer_id);

  -- ── COGS-reversal JE (Dr Inventory, Cr COGS) ──
  -- Uses ORIGINAL SALE transaction FIFO cost layer from sales_invoice_items wherever available
  IF v_cogs_id IS NOT NULL AND v_inv_id IS NOT NULL THEN
    FOR v_item IN
      SELECT cni.quantity, cni.batch_id, cni.product_id
        FROM credit_note_items cni
       WHERE cni.credit_note_id = p_cn.id
    LOOP
      v_unit_cogs := NULL;

      -- 1. Check original sales invoice line for exact historical FIFO cogs_unit_cost
      IF p_cn.original_invoice_id IS NOT NULL THEN
        SELECT sii.cogs_unit_cost INTO v_unit_cogs
          FROM public.sales_invoice_items sii
         WHERE sii.invoice_id = p_cn.original_invoice_id
           AND (sii.batch_id = v_item.batch_id OR (v_item.batch_id IS NULL AND sii.product_id = v_item.product_id))
           AND sii.cogs_unit_cost IS NOT NULL AND sii.cogs_unit_cost > 0
         ORDER BY sii.created_at
         LIMIT 1;
      END IF;

      -- 2. Fallback to batch landed cost, then cost_per_unit if original transaction cost not found
      IF v_unit_cogs IS NULL OR v_unit_cogs <= 0 THEN
        SELECT COALESCE(b.landed_cost_per_unit, b.cost_per_unit, 0) INTO v_unit_cogs
          FROM public.batches b
         WHERE b.id = v_item.batch_id;
      END IF;

      v_total_cogs := v_total_cogs + ROUND(v_item.quantity * COALESCE(v_unit_cogs, 0), 2);
    END LOOP;

    IF v_total_cogs > 0 THEN
      v_je_number := public.next_journal_entry_number();
      INSERT INTO journal_entries
        (entry_number, entry_date, source_module, reference_id, reference_number,
         description, total_debit, total_credit, is_posted, posted_by, created_by)
      VALUES
        (v_je_number, p_cn.credit_note_date, 'credit_note_cogs', p_cn.id, p_cn.credit_note_number,
         'Historical FIFO COGS reversal for Credit Note ' || p_cn.credit_note_number,
         v_total_cogs, v_total_cogs, true, v_actor, v_actor)
      RETURNING id INTO v_je_cogs_id;

      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit)
      VALUES (v_je_cogs_id, 1, v_inv_id,
              'Inventory restock - ' || p_cn.credit_note_number,
              v_total_cogs, 0);

      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
      VALUES (v_je_cogs_id, 2, v_cogs_id,
              'COGS reversal - ' || p_cn.credit_note_number,
              0, v_total_cogs, p_cn.customer_id);
    END IF;
  END IF;

  RETURN v_je_id;
END;
$$;

-- 4. Update get_sales_profitability_summary to reflect approved returns & COGS reversals
CREATE OR REPLACE FUNCTION public.get_sales_profitability_summary(
  p_start_date date,
  p_end_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  WITH lines AS (
    SELECT
      ar.*,
      si.invoice_date,
      si.invoice_number,
      si.customer_id,
      COALESCE(c.company_name, 'Unknown Customer') AS customer_name,
      si.sales_order_id,
      so.so_number,
      sii.unit_price,
      ROUND(sii.quantity * sii.unit_price, 2) AS line_gross_sales,
      p.product_name,
      COALESCE(p.product_code, '') AS product_code,
      COALESCE(p.unit, 'kg') AS product_unit,
      b.batch_number,
      COALESCE(b.landed_cost_per_unit, b.cost_per_unit) AS batch_unit_cost,
      COALESCE(le.sales_expense, 0) AS line_sales_expense,
      dci.challan_id AS dc_id,
      dc.challan_number AS dc_number
    FROM public.get_authoritative_sales_line_cogs(p_start_date, p_end_date) ar
    JOIN public.sales_invoice_items sii ON sii.id = ar.line_id
    JOIN public.sales_invoices si ON si.id = ar.invoice_id
    JOIN public.products p ON p.id = ar.product_id
    LEFT JOIN public.customers c ON c.id = si.customer_id
    LEFT JOIN public.sales_orders so ON so.id = si.sales_order_id
    LEFT JOIN public.batches b ON b.id = ar.batch_id
    LEFT JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
    LEFT JOIN public.delivery_challans dc ON dc.id = dci.challan_id
    LEFT JOIN public.get_sales_profitability_line_expenses(p_start_date, p_end_date) le ON le.line_id = ar.line_id
  ),
  returns AS (
    SELECT 
      COALESCE(SUM(cn.subtotal), 0) AS total_return_revenue,
      COALESCE(SUM(cogs_reversal.total_cogs), 0) AS total_return_cogs
    FROM public.credit_notes cn
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(jel.credit), 0) AS total_cogs
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id AND coa.code = '5100'
      WHERE je.source_module = 'credit_note_cogs'
        AND je.reference_id = cn.id
        AND je.is_posted = true
    ) cogs_reversal ON true
    WHERE cn.status = 'approved'
      AND cn.credit_note_date BETWEEN p_start_date AND p_end_date
  ),
  unallocated AS (
    SELECT COALESCE(SUM(fe.amount), 0) AS amount
    FROM public.finance_expenses fe
    WHERE (
        fe.expense_category IN ('delivery_sales', 'loading_sales', 'marketing_advertising', 'other_sales')
        OR EXISTS (
          SELECT 1 FROM public.expense_categories ec
          WHERE ec.category_key = fe.expense_category
            AND ec.category_type = 'sales'
        )
      )
      AND fe.approval_status = 'approved'
      AND fe.expense_date BETWEEN p_start_date AND p_end_date
      AND (fe.delivery_challan_id IS NULL OR NOT EXISTS (SELECT 1 FROM lines l WHERE l.dc_id = fe.delivery_challan_id))
  ),
  prod AS (
    SELECT
      product_id,
      MAX(product_name) AS product_name,
      MAX(product_code) AS product_code,
      MAX(product_unit) AS product_unit,
      COALESCE((SELECT SUM(b.current_stock) FROM public.batches b WHERE b.product_id = l.product_id AND b.is_active), 0) AS current_stock,
      SUM(quantity) AS sold_qty,
      SUM(line_gross_sales) AS gross_sales,
      SUM(authoritative_cogs) AS product_cost,
      SUM(line_sales_expense) AS sales_expense,
      ROUND(SUM(line_gross_sales) / NULLIF(SUM(quantity), 0), 2) AS avg_selling_price,
      ROUND(SUM(line_sales_expense) / NULLIF(SUM(quantity), 0), 2) AS sales_expense_per_unit,
      ROUND((SUM(line_gross_sales) - SUM(line_sales_expense)) / NULLIF(SUM(quantity), 0), 2) AS net_selling_price_per_unit,
      COALESCE(
        ROUND(SUM(authoritative_cogs) / NULLIF(SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN quantity ELSE 0 END), 0), 2),
        ROUND(SUM(quantity * batch_unit_cost) / NULLIF(SUM(quantity), 0), 2)
      ) AS avg_landed_cost,
      ROUND(SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN line_gross_sales - authoritative_cogs ELSE 0 END), 2) AS gross_profit,
      ROUND(SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN line_gross_sales - authoritative_cogs - line_sales_expense ELSE 0 END), 2) AS profit_after_sales_expense,
      ROUND(
        SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN line_gross_sales - authoritative_cogs - line_sales_expense ELSE 0 END)
        / NULLIF(SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN quantity ELSE 0 END), 0),
        2
      ) AS profit_per_unit,
      CASE
        WHEN SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN line_gross_sales ELSE 0 END) = 0 THEN NULL
        ELSE ROUND(
          SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN line_gross_sales - authoritative_cogs - line_sales_expense ELSE 0 END)
          / SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN line_gross_sales ELSE 0 END) * 100,
          2
        )
      END AS profit_margin_pct,
      COUNT(authoritative_cogs) AS costed_lines,
      COUNT(*) AS total_lines,
      COUNT(authoritative_cogs) < COUNT(*) AS has_unreported_cost
    FROM lines l
    GROUP BY product_id
  ),
  inv AS (
    SELECT
      invoice_id,
      MAX(invoice_date) AS invoice_date,
      MAX(posted_invoice_cogs) AS product_cost,
      SUM(line_gross_sales) AS gross_sales,
      SUM(quantity) AS total_qty_sold,
      SUM(line_sales_expense) AS sales_expenses
    FROM lines
    GROUP BY invoice_id
  ),
  months AS (
    SELECT
      DATE_TRUNC('month', invoice_date)::date AS month_start,
      TO_CHAR(DATE_TRUNC('month', invoice_date), 'Mon YYYY') AS month_label,
      SUM(gross_sales) AS gross_sales,
      SUM(product_cost) AS product_cost,
      SUM(sales_expenses) AS sales_expenses,
      SUM(total_qty_sold) AS total_qty_sold,
      COUNT(*) AS order_count
    FROM inv
    GROUP BY 1, 2
  ),
  company AS (
    SELECT
      COALESCE(SUM(gross_sales), 0) AS gross_sales,
      COALESCE(SUM(product_cost), 0) AS product_cost,
      COALESCE(SUM(sales_expenses), 0) + (SELECT amount FROM unallocated) AS sales_expenses,
      (SELECT amount FROM unallocated) AS unallocated_sales_expenses,
      COALESCE(SUM(total_qty_sold), 0) AS total_qty_sold,
      COUNT(*) AS order_count,
      (SELECT COUNT(DISTINCT product_id) FROM lines) AS product_count,
      (SELECT total_return_revenue FROM returns) AS sales_returns,
      (SELECT total_return_cogs FROM returns) AS return_cogs
    FROM inv
  )
  SELECT jsonb_build_object(
    'company', jsonb_build_object(
      'gross_sales', c.gross_sales,
      'sales_returns', c.sales_returns,
      'net_sales', c.gross_sales - c.sales_returns,
      'product_cost', c.product_cost,
      'return_cogs', c.return_cogs,
      'net_product_cost', c.product_cost - c.return_cogs,
      'sales_expenses', c.sales_expenses,
      'unallocated_sales_expenses', c.unallocated_sales_expenses,
      'gross_profit', (c.gross_sales - c.sales_returns) - (c.product_cost - c.return_cogs),
      'profit_after_sales_expenses', (c.gross_sales - c.sales_returns) - (c.product_cost - c.return_cogs) - c.sales_expenses,
      'profit_margin_pct', CASE WHEN (c.gross_sales - c.sales_returns) = 0 THEN NULL 
        ELSE ROUND(((c.gross_sales - c.sales_returns) - (c.product_cost - c.return_cogs) - c.sales_expenses) / (c.gross_sales - c.sales_returns) * 100, 2) END,
      'total_qty_sold', c.total_qty_sold,
      'order_count', c.order_count,
      'product_count', c.product_count
    ),
    'products', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.product_name) FROM prod p), '[]'::jsonb),
    'monthly', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'month_label', m.month_label,
          'month_start', m.month_start,
          'gross_sales', m.gross_sales,
          'product_cost', m.product_cost,
          'sales_expenses', m.sales_expenses,
          'gross_profit', m.gross_sales - m.product_cost,
          'profit_after_sales_expenses', m.gross_sales - m.product_cost - m.sales_expenses,
          'profit_margin_pct', CASE WHEN m.gross_sales = 0 THEN NULL ELSE ROUND((m.gross_sales - m.product_cost - m.sales_expenses) / m.gross_sales * 100, 2) END,
          'total_qty_sold', m.total_qty_sold,
          'order_count', m.order_count
        ) ORDER BY m.month_start
      ) FROM months m
    ), '[]'::jsonb)
  ) INTO v_result
  FROM company c;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_sales_profitability_summary(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_sales_profitability_summary(date, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_sales_profitability_summary(date, date) TO authenticated, service_role;
