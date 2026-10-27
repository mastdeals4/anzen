-- Preserve Purchase Invoice line identities during edits.
CREATE OR REPLACE FUNCTION public.save_purchase_invoice(p_invoice_id uuid, p_invoice_data jsonb, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  DECLARE
    v_invoice_id        UUID;
    v_je_id             UUID;
    v_je_number         TEXT;
    v_ap_account_id     UUID;
    v_ppn_account_id    UUID;
    v_bm_account_id     UUID;
    v_account_id        UUID;
    v_item              JSONB;
    v_line_number       INTEGER;
    v_invoice_date      DATE;
    v_invoice_number    TEXT;
    v_supplier_id       UUID;
    v_total_amount      NUMERIC(15,2);
    v_tax_amount        NUMERIC(15,2);
    v_stamp_duty_amount NUMERIC(15,2);
    v_created_by        UUID;
    v_item_type         TEXT;
    v_line_total        NUMERIC(15,2);
    v_item_id           UUID;
  BEGIN
    v_created_by        := auth.uid();
    v_invoice_date      := (p_invoice_data->>'invoice_date')::DATE;
    v_invoice_number    := p_invoice_data->>'invoice_number';
    v_total_amount      := (p_invoice_data->>'total_amount')::NUMERIC(15,2);
    v_tax_amount        := COALESCE((p_invoice_data->>'tax_amount')::NUMERIC(15,2), 0);
    v_stamp_duty_amount := COALESCE((p_invoice_data->>'stamp_duty_amount')::NUMERIC(15,2), 0);
    v_supplier_id       := (p_invoice_data->>'supplier_id')::UUID;

    SELECT id INTO v_ap_account_id  FROM chart_of_accounts WHERE code = '2110' LIMIT 1;
    SELECT id INTO v_ppn_account_id FROM chart_of_accounts WHERE code = '1150' LIMIT 1;
    SELECT id INTO v_bm_account_id  FROM chart_of_accounts WHERE code = '6950' LIMIT 1;

    IF v_ap_account_id IS NULL THEN
      RAISE EXCEPTION 'A/P account (code 2110) not found in chart of accounts';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('je_number_' || TO_CHAR(v_invoice_date, 'YYMM')));

    IF p_invoice_id IS NULL THEN
      -- ── CREATE path ──────────────────────────────────────────────────────────

      v_je_number := 'JE-' || TO_CHAR(v_invoice_date, 'YYMM') || '-' || LPAD((
        SELECT COALESCE(MAX(CAST(SUBSTRING(entry_number FROM '(\d+)$') AS INTEGER)), 0) + 1
        FROM journal_entries
        WHERE entry_number LIKE 'JE-' || TO_CHAR(v_invoice_date, 'YYMM') || '-%'
      )::TEXT, 4, '0');

      INSERT INTO journal_entries (
        entry_number, entry_date, source_module, reference_id, reference_number,
        description, total_debit, total_credit, is_posted, posted_by, created_by
      ) VALUES (
        v_je_number, v_invoice_date, 'purchase_invoice', gen_random_uuid(), v_invoice_number,
        'Purchase Invoice: ' || v_invoice_number,
        0, v_total_amount, TRUE, v_created_by, v_created_by
      ) RETURNING id INTO v_je_id;

      -- balance_amount is GENERATED ALWAYS AS (total_amount - paid_amount); omit from INSERT
      INSERT INTO purchase_invoices (
        invoice_number, supplier_id, invoice_date, due_date,
        currency, exchange_rate, subtotal, tax_amount, stamp_duty_amount, total_amount,
        paid_amount, status,
        faktur_pajak_number, notes, document_urls,
        requires_faktur_pajak, purchase_type,
        journal_entry_id, created_by
      ) VALUES (
        v_invoice_number,
        v_supplier_id,
        v_invoice_date,
        NULLIF(p_invoice_data->>'due_date', '')::DATE,
        COALESCE(p_invoice_data->>'currency', 'IDR'),
        COALESCE((p_invoice_data->>'exchange_rate')::NUMERIC, 1),
        COALESCE((p_invoice_data->>'subtotal')::NUMERIC, 0),
        v_tax_amount,
        v_stamp_duty_amount,
        v_total_amount,
        0,
        'unpaid',
        NULLIF(p_invoice_data->>'faktur_pajak_number', ''),
        NULLIF(p_invoice_data->>'notes', ''),
        CASE
          WHEN p_invoice_data -> 'document_urls' IS NOT NULL
            AND jsonb_array_length(p_invoice_data -> 'document_urls') > 0
          THEN ARRAY(SELECT jsonb_array_elements_text(p_invoice_data -> 'document_urls'))
          ELSE NULL
        END,
        COALESCE((p_invoice_data->>'requires_faktur_pajak')::BOOLEAN, FALSE),
        COALESCE(p_invoice_data->>'purchase_type', 'inventory'),
        v_je_id,
        v_created_by
      ) RETURNING id INTO v_invoice_id;

      UPDATE journal_entries SET reference_id = v_invoice_id WHERE id = v_je_id;

    ELSE
      -- ── EDIT path ──────────────────────────────────────────────────────────

      v_invoice_id := p_invoice_id;

      SELECT journal_entry_id INTO v_je_id
      FROM purchase_invoices WHERE id = v_invoice_id;

      -- balance_amount is GENERATED ALWAYS; do not include in UPDATE SET
      UPDATE purchase_invoices SET
        invoice_number        = v_invoice_number,
        supplier_id           = v_supplier_id,
        invoice_date          = v_invoice_date,
        due_date              = NULLIF(p_invoice_data->>'due_date', '')::DATE,
        currency              = COALESCE(p_invoice_data->>'currency', 'IDR'),
        exchange_rate         = COALESCE((p_invoice_data->>'exchange_rate')::NUMERIC, 1),
        subtotal              = COALESCE((p_invoice_data->>'subtotal')::NUMERIC, 0),
        tax_amount            = v_tax_amount,
        stamp_duty_amount     = v_stamp_duty_amount,
        total_amount          = v_total_amount,
        faktur_pajak_number   = NULLIF(p_invoice_data->>'faktur_pajak_number', ''),
        notes                 = NULLIF(p_invoice_data->>'notes', ''),
        document_urls         = CASE
                                  WHEN p_invoice_data -> 'document_urls' IS NOT NULL
                                    AND jsonb_array_length(p_invoice_data -> 'document_urls') > 0
                                  THEN ARRAY(SELECT jsonb_array_elements_text(p_invoice_data -> 'document_urls'))
                                  ELSE NULL
                                END,
        requires_faktur_pajak = COALESCE((p_invoice_data->>'requires_faktur_pajak')::BOOLEAN, FALSE),
        purchase_type         = COALESCE(p_invoice_data->>'purchase_type', 'inventory'),
        updated_at            = NOW()
      WHERE id = v_invoice_id;

      IF EXISTS (SELECT 1 FROM purchase_invoice_items i WHERE i.purchase_invoice_id=v_invoice_id AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) x WHERE NULLIF(x->>'id','')::uuid=i.id) AND (EXISTS (SELECT 1 FROM purchase_invoice_receiving_allocations a WHERE a.purchase_invoice_item_id=i.id) OR i.batch_id IS NOT NULL)) THEN RAISE EXCEPTION 'Cannot remove invoice line with receiving or inventory history'; END IF;
      DELETE FROM purchase_invoice_items i WHERE i.purchase_invoice_id=v_invoice_id AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) x WHERE NULLIF(x->>'id','')::uuid=i.id);

      IF v_je_id IS NOT NULL THEN
        DELETE FROM journal_entry_lines WHERE journal_entry_id = v_je_id;
        UPDATE journal_entries SET
          entry_date       = v_invoice_date,
          reference_number = v_invoice_number,
          description      = 'Purchase Invoice: ' || v_invoice_number,
          total_debit      = 0,
          total_credit     = v_total_amount
        WHERE id = v_je_id;
      ELSE
        v_je_number := 'JE-' || TO_CHAR(v_invoice_date, 'YYMM') || '-' || LPAD((
          SELECT COALESCE(MAX(CAST(SUBSTRING(entry_number FROM '(\d+)$') AS INTEGER)), 0) + 1
          FROM journal_entries
          WHERE entry_number LIKE 'JE-' || TO_CHAR(v_invoice_date, 'YYMM') || '-%'
        )::TEXT, 4, '0');

        INSERT INTO journal_entries (
          entry_number, entry_date, source_module, reference_id, reference_number,
          description, total_debit, total_credit, is_posted, posted_by, created_by
        ) VALUES (
          v_je_number, v_invoice_date, 'purchase_invoice', v_invoice_id, v_invoice_number,
          'Purchase Invoice: ' || v_invoice_number,
          0, v_total_amount, TRUE, v_created_by, v_created_by
        ) RETURNING id INTO v_je_id;

        UPDATE purchase_invoices SET journal_entry_id = v_je_id WHERE id = v_invoice_id;
      END IF;
    END IF;

    -- ── Insert items and build JE debit lines ─────────────────────────────────
    v_line_number := 1;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      v_item_type  := v_item->>'item_type';
      v_line_total := COALESCE((v_item->>'line_total')::NUMERIC(15,2), 0);

      v_item_id := NULLIF(v_item->>'id', '')::UUID;
      IF v_item_id IS NOT NULL AND EXISTS (SELECT 1 FROM purchase_invoice_items WHERE id=v_item_id AND purchase_invoice_id=v_invoice_id) THEN
        UPDATE purchase_invoice_items SET item_type=v_item_type, product_id=NULLIF(v_item->>'product_id','')::UUID, description=v_item->>'description', quantity=COALESCE((v_item->>'quantity')::NUMERIC,1), unit=v_item->>'unit', unit_price=COALESCE((v_item->>'unit_price')::NUMERIC,0), discount_percent=(v_item->>'discount_percent')::NUMERIC, line_total=v_line_total, tax_amount=(v_item->>'tax_amount')::NUMERIC, expense_account_id=NULLIF(v_item->>'expense_account_id','')::UUID, asset_account_id=NULLIF(v_item->>'asset_account_id','')::UUID, purchase_order_item_id=NULLIF(v_item->>'purchase_order_item_id','')::UUID, receiving_make_id=NULLIF(v_item->>'receiving_make_id','')::UUID, receiving_batch_number=NULLIF(v_item->>'receiving_batch_number',''), receiving_expiry_date=NULLIF(v_item->>'receiving_expiry_date','')::date, receiving_import_container_id=NULLIF(v_item->>'receiving_import_container_id','')::UUID, receiving_notes=NULLIF(v_item->>'receiving_notes','') WHERE id=v_item_id;
      ELSE
      INSERT INTO purchase_invoice_items (
        purchase_invoice_id, item_type, product_id, description,
        quantity, unit, unit_price, discount_percent, line_total,
        tax_amount, expense_account_id, asset_account_id
      ) VALUES (
        v_invoice_id,
        v_item_type,
        NULLIF(v_item->>'product_id', '')::UUID,
        v_item->>'description',
        COALESCE((v_item->>'quantity')::NUMERIC, 1),
        v_item->>'unit',
        COALESCE((v_item->>'unit_price')::NUMERIC, 0),
        (v_item->>'discount_percent')::NUMERIC,
        v_line_total,
        (v_item->>'tax_amount')::NUMERIC,
        NULLIF(v_item->>'expense_account_id', '')::UUID,
        NULLIF(v_item->>'asset_account_id',   '')::UUID
      );

      END IF;
      IF v_item_type = 'inventory' THEN
        SELECT id INTO v_account_id FROM chart_of_accounts WHERE code = '1130' LIMIT 1;
      ELSIF v_item_type = 'fixed_asset' THEN
        v_account_id := NULLIF(v_item->>'asset_account_id', '')::UUID;
        IF v_account_id IS NULL THEN
          SELECT id INTO v_account_id FROM chart_of_accounts WHERE code = '1200' LIMIT 1;
        END IF;
      ELSE
        v_account_id := NULLIF(v_item->>'expense_account_id', '')::UUID;
        IF v_account_id IS NULL THEN
          SELECT id INTO v_account_id FROM chart_of_accounts WHERE code = '5100' LIMIT 1;
        END IF;
      END IF;

      IF v_account_id IS NOT NULL AND v_line_total <> 0 THEN
        INSERT INTO journal_entry_lines (
          journal_entry_id, line_number, account_id, description,
          debit, credit, supplier_id
        ) VALUES (
          v_je_id, v_line_number, v_account_id,
          COALESCE(LEFT(v_item->>'description', 100), 'Purchase Item'),
          v_line_total, 0, v_supplier_id
        );
        v_line_number := v_line_number + 1;
      END IF;
    END LOOP;

    -- PPN Input debit line (DR 1150)
    IF v_tax_amount > 0 AND v_ppn_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (
        journal_entry_id, line_number, account_id, description,
        debit, credit, supplier_id
      ) VALUES (
        v_je_id, v_line_number, v_ppn_account_id,
        'PPN Input - ' || v_invoice_number,
        v_tax_amount, 0, v_supplier_id
      );
      v_line_number := v_line_number + 1;
    END IF;

    -- Stamp Duty debit line (DR 6950 Bea Meterai Expense)
    IF v_stamp_duty_amount > 0 AND v_bm_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (
        journal_entry_id, line_number, account_id, description,
        debit, credit, supplier_id
      ) VALUES (
        v_je_id, v_line_number, v_bm_account_id,
        'Bea Meterai - ' || v_invoice_number,
        v_stamp_duty_amount, 0, v_supplier_id
      );
      v_line_number := v_line_number + 1;
    END IF;

    -- A/P credit line (total_amount = subtotal + ppn + stamp_duty)
    INSERT INTO journal_entry_lines (
      journal_entry_id, line_number, account_id, description,
      debit, credit, supplier_id
    ) VALUES (
      v_je_id, v_line_number, v_ap_account_id,
      'A/P - ' || v_invoice_number,
      0, v_total_amount, v_supplier_id
    );

    -- Reconcile JE totals from actual inserted lines
    UPDATE journal_entries SET
      total_debit  = (SELECT COALESCE(SUM(debit),  0) FROM journal_entry_lines WHERE journal_entry_id = v_je_id),
      total_credit = (SELECT COALESCE(SUM(credit), 0) FROM journal_entry_lines WHERE journal_entry_id = v_je_id)
    WHERE id = v_je_id;

    RETURN jsonb_build_object(
      'invoice_id',       v_invoice_id,
      'journal_entry_id', v_je_id
    );
  END;
  $function$;

GRANT EXECUTE ON FUNCTION public.save_purchase_invoice(uuid,jsonb,jsonb) TO authenticated;
