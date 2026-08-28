/*
  Force-deploy purchase invoice journal tax fix in PUBLIC schema.
  This ensures live triggers reference the corrected function body.
*/

CREATE OR REPLACE FUNCTION public.post_purchase_invoice_item_journal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_invoice RECORD;
  v_je_id UUID;
  v_account_id UUID;
  v_max_line INTEGER;
  v_item_net_amount NUMERIC;
BEGIN
  SELECT * INTO v_invoice FROM public.purchase_invoices WHERE id = NEW.purchase_invoice_id;

  IF v_invoice.journal_entry_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_je_id := v_invoice.journal_entry_id;
  v_item_net_amount := GREATEST(COALESCE(NEW.line_total, 0) - COALESCE(NEW.tax_amount, 0), 0);

  IF EXISTS (
    SELECT 1 FROM public.journal_entry_lines
    WHERE journal_entry_id = v_je_id
      AND debit > 0
      AND description LIKE '%' || LEFT(COALESCE(NEW.description, ''), 50) || '%'
      AND debit = v_item_net_amount
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.item_type = 'inventory' THEN
    SELECT id INTO v_account_id FROM public.chart_of_accounts WHERE code = '1130' LIMIT 1;
  ELSIF NEW.item_type = 'fixed_asset' THEN
    v_account_id := NEW.asset_account_id;
    IF v_account_id IS NULL THEN
      SELECT id INTO v_account_id FROM public.chart_of_accounts WHERE code = '1200' LIMIT 1;
    END IF;
  ELSE
    v_account_id := NEW.expense_account_id;
    IF v_account_id IS NULL THEN
      SELECT id INTO v_account_id FROM public.chart_of_accounts WHERE code = '5100' LIMIT 1;
    END IF;
  END IF;

  IF v_account_id IS NULL OR v_item_net_amount <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(MAX(line_number), 0) INTO v_max_line
  FROM public.journal_entry_lines WHERE journal_entry_id = v_je_id;

  INSERT INTO public.journal_entry_lines (
    journal_entry_id, line_number, account_id, description,
    debit, credit, supplier_id, batch_id
  ) VALUES (
    v_je_id, v_max_line + 1, v_account_id,
    COALESCE(LEFT(NEW.description, 100), 'Purchase Item'),
    v_item_net_amount, 0, v_invoice.supplier_id, NEW.batch_id
  );

  UPDATE public.journal_entries
  SET total_debit = (SELECT COALESCE(SUM(debit), 0) FROM public.journal_entry_lines WHERE journal_entry_id = v_je_id)
  WHERE id = v_je_id;

  RETURN NEW;
END;
$$;

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
  v_header_total NUMERIC := 0;
BEGIN
  IF NEW.journal_entry_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.journal_entry_id IS NULL
     AND NEW.status IN ('unpaid', 'partial', 'paid')) THEN

    SELECT id INTO v_ap_account_id FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1;
    SELECT id INTO v_ppn_account_id FROM public.chart_of_accounts WHERE code = '1150' LIMIT 1;

    IF v_ap_account_id IS NULL THEN RETURN NEW; END IF;

    SELECT EXISTS(SELECT 1 FROM public.purchase_invoice_items WHERE purchase_invoice_id = NEW.id)
    INTO v_has_items;

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

    v_header_total := v_total_item_net + COALESCE(NEW.tax_amount, 0);

    INSERT INTO public.journal_entries (
      entry_number, entry_date, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, posted_by, created_by
    ) VALUES (
      v_je_number, NEW.invoice_date, 'purchase_invoice', NEW.id, NEW.invoice_number,
      'Purchase Invoice: ' || NEW.invoice_number,
      v_header_total,
      v_header_total, true, NEW.created_by, NEW.created_by
    ) RETURNING id INTO v_je_id;

    IF v_has_items THEN
      FOR v_item IN
        SELECT * FROM public.purchase_invoice_items
        WHERE purchase_invoice_id = NEW.id
        ORDER BY id
      LOOP
        v_account_id := NULL;

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
            GREATEST(COALESCE(v_item.line_total, 0) - COALESCE(v_item.tax_amount, 0), 0),
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
      0, v_header_total, NEW.supplier_id
    );

    NEW.journal_entry_id := v_je_id;
  END IF;

  RETURN NEW;
END;
$$;

-- Rebind triggers explicitly to public functions.
DROP TRIGGER IF EXISTS trg_post_purchase_invoice_journal ON public.purchase_invoices;
DROP TRIGGER IF EXISTS trg_post_purchase_invoice ON public.purchase_invoices;

CREATE TRIGGER trg_post_purchase_invoice
BEFORE INSERT OR UPDATE ON public.purchase_invoices
FOR EACH ROW EXECUTE FUNCTION public.post_purchase_invoice_journal();

DROP TRIGGER IF EXISTS trg_post_purchase_invoice_item_journal ON public.purchase_invoice_items;
CREATE TRIGGER trg_post_purchase_invoice_item_journal
  AFTER INSERT ON public.purchase_invoice_items
  FOR EACH ROW EXECUTE FUNCTION public.post_purchase_invoice_item_journal();
