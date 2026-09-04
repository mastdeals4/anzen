/*
  Fix purchase invoice journal trigger design:
  - Keep trg_post_purchase_invoice as BEFORE INSERT OR UPDATE on public.purchase_invoices
  - Do not UPDATE public.purchase_invoices from inside trigger function
  - Assign NEW.journal_entry_id and RETURN NEW
  - Keep item debit as net of per-line tax
  - Keep invoice PPN as separate debit from NEW.tax_amount
*/

CREATE OR REPLACE FUNCTION public.post_purchase_invoice_journal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_je_id UUID;
  v_je_number TEXT;
  v_ap_account_id UUID;
  v_ppn_account_id UUID;
  v_line_number INTEGER := 1;
  v_item RECORD;
  v_account_id UUID;
  v_has_items BOOLEAN;
  v_total_item_net NUMERIC := 0;
BEGIN
  IF NEW.journal_entry_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.journal_entry_id IS NULL
     AND NEW.status IN ('unpaid', 'partial', 'paid')) THEN

    SELECT id INTO v_ap_account_id FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1;
    SELECT id INTO v_ppn_account_id FROM public.chart_of_accounts WHERE code = '1150' LIMIT 1;

    IF v_ap_account_id IS NULL THEN
      RETURN NEW;
    END IF;

    SELECT EXISTS(
      SELECT 1
      FROM public.purchase_invoice_items
      WHERE purchase_invoice_id = NEW.id
    ) INTO v_has_items;

    IF v_has_items THEN
      SELECT COALESCE(SUM(GREATEST(COALESCE(line_total, 0) - COALESCE(tax_amount, 0), 0)), 0)
      INTO v_total_item_net
      FROM public.purchase_invoice_items
      WHERE purchase_invoice_id = NEW.id;
    END IF;

    v_je_number := 'JE-' || TO_CHAR(NEW.invoice_date, 'YYMM') || '-' || LPAD((
      SELECT COALESCE(MAX(CAST(SUBSTRING(entry_number FROM '(\d+)$') AS INTEGER)), 0) + 1
      FROM public.journal_entries
      WHERE entry_number LIKE 'JE-' || TO_CHAR(NEW.invoice_date, 'YYMM') || '-%'
    )::TEXT, 4, '0');

    INSERT INTO public.journal_entries (
      entry_number, entry_date, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, posted_by, created_by
    ) VALUES (
      v_je_number, NEW.invoice_date, 'purchase_invoice', NEW.id, NEW.invoice_number,
      'Purchase Invoice: ' || NEW.invoice_number,
      CASE WHEN v_has_items THEN v_total_item_net + COALESCE(NEW.tax_amount, 0) ELSE 0 END,
      NEW.total_amount, true, NEW.created_by, NEW.created_by
    ) RETURNING id INTO v_je_id;

    IF v_has_items THEN
      FOR v_item IN
        SELECT * FROM public.purchase_invoice_items
        WHERE purchase_invoice_id = NEW.id
        ORDER BY id
      LOOP
        IF v_item.item_type = 'inventory' THEN
          SELECT id INTO v_account_id FROM public.chart_of_accounts WHERE code = '1130' LIMIT 1;
        ELSIF v_item.item_type = 'fixed_asset' THEN
          v_account_id := v_item.asset_account_id;
          IF v_account_id IS NULL THEN
            SELECT id INTO v_account_id FROM public.chart_of_accounts WHERE code = '1200' LIMIT 1;
          END IF;
        ELSIF v_item.item_type IN ('expense', 'freight', 'duty', 'insurance', 'clearing', 'other') THEN
          v_account_id := v_item.expense_account_id;
          IF v_account_id IS NULL THEN
            SELECT id INTO v_account_id FROM public.chart_of_accounts WHERE code = '5100' LIMIT 1;
          END IF;
        END IF;

        IF v_account_id IS NOT NULL THEN
          INSERT INTO public.journal_entry_lines (
            journal_entry_id, line_number, account_id, description,
            debit, credit, supplier_id, batch_id
          ) VALUES (
            v_je_id, v_line_number, v_account_id,
            COALESCE(LEFT(v_item.description, 100), 'Purchase - ' || NEW.invoice_number),
            GREATEST(COALESCE(v_item.line_total,0) - COALESCE(v_item.tax_amount,0),0),
            0, NEW.supplier_id, v_item.batch_id
          );
          v_line_number := v_line_number + 1;
        END IF;
      END LOOP;

      IF NEW.tax_amount > 0 AND v_ppn_account_id IS NOT NULL THEN
        INSERT INTO public.journal_entry_lines (
          journal_entry_id, line_number, account_id, description,
          debit, credit, supplier_id
        ) VALUES (
          v_je_id, v_line_number, v_ppn_account_id,
          'PPN Input - ' || NEW.invoice_number,
          NEW.tax_amount, 0, NEW.supplier_id
        );
        v_line_number := v_line_number + 1;
      END IF;
    END IF;

    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, description,
      debit, credit, supplier_id
    ) VALUES (
      v_je_id, v_line_number, v_ap_account_id,
      'A/P - ' || NEW.invoice_number,
      0, NEW.total_amount, NEW.supplier_id
    );

    NEW.journal_entry_id := v_je_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_post_purchase_invoice ON public.purchase_invoices;
DROP TRIGGER IF EXISTS trg_post_purchase_invoice_journal ON public.purchase_invoices;
CREATE TRIGGER trg_post_purchase_invoice
  BEFORE INSERT OR UPDATE ON public.purchase_invoices
  FOR EACH ROW EXECUTE FUNCTION public.post_purchase_invoice_journal();
