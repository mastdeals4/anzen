/*
  Re-apply purchase invoice journal trigger/function to remote with a fresh migration timestamp.
  Requirements:
  - BEFORE INSERT OR UPDATE trigger on public.purchase_invoices
  - No UPDATE on public.purchase_invoices inside trigger
  - NEW.journal_entry_id := v_je_id
  - Item debit uses net amount: GREATEST(COALESCE(v_item.line_total,0)-COALESCE(v_item.tax_amount,0),0)
*/

CREATE OR REPLACE FUNCTION public.post_purchase_invoice_journal()
RETURNS TRIGGER AS $$
DECLARE
  v_je_id UUID;
  v_line_num INT := 1;
  v_ap_account_id UUID;
  v_ppn_account_id UUID;
  v_inventory_account_id UUID;
  v_total_item_net NUMERIC := 0;
  v_has_items BOOLEAN := FALSE;
  v_item RECORD;
BEGIN
  -- Skip draft invoices
  IF NEW.is_draft = TRUE THEN
    RETURN NEW;
  END IF;

  -- Resolve required accounts
  SELECT id INTO v_ap_account_id
  FROM public.chart_of_accounts
  WHERE account_code = '2001'
  LIMIT 1;

  SELECT id INTO v_ppn_account_id
  FROM public.chart_of_accounts
  WHERE account_code = '1206'
  LIMIT 1;

  -- Remove prior journal + lines for this invoice when updating
  IF TG_OP = 'UPDATE' AND OLD.journal_entry_id IS NOT NULL THEN
    DELETE FROM public.journal_entry_lines WHERE journal_entry_id = OLD.journal_entry_id;
    DELETE FROM public.journal_entries WHERE id = OLD.journal_entry_id;
  END IF;

  -- Reuse existing journal when inserting with explicit id, else create new
  IF TG_OP = 'INSERT' AND NEW.journal_entry_id IS NOT NULL THEN
    v_je_id := NEW.journal_entry_id;
  ELSE
    INSERT INTO public.journal_entries (
      entry_number,
      entry_date,
      reference_type,
      reference_id,
      description,
      total_debit,
      total_credit,
      source_module,
      source_type,
      created_by
    )
    VALUES (
      public.generate_journal_entry_number(NEW.invoice_date),
      NEW.invoice_date,
      'purchase_invoice',
      NEW.id,
      'Purchase Invoice - ' || NEW.invoice_number,
      0,
      0,
      'purchase',
      'invoice',
      NEW.created_by
    )
    RETURNING id INTO v_je_id;
  END IF;

  -- Aggregate net item amount from invoice items
  SELECT
    COALESCE(SUM(GREATEST(COALESCE(line_total, 0) - COALESCE(tax_amount, 0), 0)), 0),
    COUNT(*) > 0
  INTO v_total_item_net, v_has_items
  FROM public.purchase_invoice_items
  WHERE purchase_invoice_id = NEW.id;

  -- AP credit = item net + invoice tax
  IF v_ap_account_id IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, description, debit, credit, entity_type, entity_id
    ) VALUES (
      v_je_id, v_line_num,
      v_ap_account_id,
      'Accounts Payable - ' || NEW.invoice_number,
      0,
      CASE WHEN v_has_items THEN v_total_item_net + COALESCE(NEW.tax_amount, 0) ELSE 0 END,
      'supplier', NEW.supplier_id
    );
    v_line_num := v_line_num + 1;
  END IF;

  IF v_has_items THEN
    FOR v_item IN
      SELECT pii.*, p.inventory_account_id
      FROM public.purchase_invoice_items pii
      LEFT JOIN public.products p ON p.id = pii.product_id
      WHERE pii.purchase_invoice_id = NEW.id
      ORDER BY pii.created_at
    LOOP
      v_inventory_account_id := COALESCE(v_item.inventory_account_id, (
        SELECT id FROM public.chart_of_accounts WHERE account_code = '1102' LIMIT 1
      ));

      IF v_inventory_account_id IS NOT NULL THEN
        INSERT INTO public.journal_entry_lines (
          journal_entry_id, line_number, account_id, description, debit, credit, entity_type, entity_id, batch_id
        ) VALUES (
          v_je_id, v_line_num,
          v_inventory_account_id,
          'Inventory - ' || COALESCE(v_item.item_name, 'Item') || ' (' || NEW.invoice_number || ')',
          GREATEST(COALESCE(v_item.line_total,0) - COALESCE(v_item.tax_amount,0),0),
          0,
          'supplier', NEW.supplier_id, v_item.batch_id
        );
        v_line_num := v_line_num + 1;
      END IF;
    END LOOP;

    IF NEW.tax_amount > 0 AND v_ppn_account_id IS NOT NULL THEN
      INSERT INTO public.journal_entry_lines (
        journal_entry_id, line_number, account_id, description, debit, credit, entity_type, entity_id
      ) VALUES (
        v_je_id, v_line_num,
        v_ppn_account_id,
        'PPN Input - ' || NEW.invoice_number,
        NEW.tax_amount, 0, 'supplier', NEW.supplier_id
      );
      v_line_num := v_line_num + 1;
    END IF;
  END IF;

  UPDATE public.journal_entries
  SET
    total_debit = COALESCE((SELECT SUM(debit) FROM public.journal_entry_lines WHERE journal_entry_id = v_je_id), 0),
    total_credit = COALESCE((SELECT SUM(credit) FROM public.journal_entry_lines WHERE journal_entry_id = v_je_id), 0)
  WHERE id = v_je_id;

  NEW.journal_entry_id := v_je_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_post_purchase_invoice ON public.purchase_invoices;
DROP TRIGGER IF EXISTS trg_post_purchase_invoice_journal ON public.purchase_invoices;
CREATE TRIGGER trg_post_purchase_invoice
  BEFORE INSERT OR UPDATE ON public.purchase_invoices
  FOR EACH ROW EXECUTE FUNCTION public.post_purchase_invoice_journal();
