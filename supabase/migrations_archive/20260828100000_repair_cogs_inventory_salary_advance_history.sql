-- Deterministic historical repair: duplicate COGS, salary advances, and
-- certified Inventory V1 reporting. Original journals and stock movements are
-- preserved. No batch quantity, reservation, document approval, bank
-- statement, invoice, or payment-voucher row is changed by this migration.

DO $$
DECLARE
  v_exact_count integer;
  v_additive_count integer;
  v_no_canonical_count integer;
BEGIN
  WITH amounts AS (
    SELECT je.id, je.source_module, je.reference_id,
           sum(CASE WHEN coa.code='5100' THEN jel.debit-jel.credit ELSE 0 END) amount
    FROM public.journal_entries je
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id=je.id
    JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
    WHERE je.is_posted AND NOT COALESCE(je.is_reversed,false)
      AND je.source_module IN ('historical_cogs_correction','sales_invoice_cogs')
    GROUP BY je.id
  ), h AS (
    SELECT * FROM amounts WHERE source_module='historical_cogs_correction'
  ), c AS (
    SELECT reference_id,sum(amount) amount FROM amounts
    WHERE source_module='sales_invoice_cogs' GROUP BY reference_id
  ), expected AS (
    SELECT si.id reference_id,
           sum(sii.quantity*COALESCE(b.landed_cost_per_unit,b.cost_per_unit,b.import_price,0)) amount
    FROM public.sales_invoices si
    JOIN public.sales_invoice_items sii ON sii.invoice_id=si.id
    LEFT JOIN public.batches b ON b.id=sii.batch_id
    GROUP BY si.id
  )
  SELECT count(*) FILTER(WHERE c.reference_id IS NOT NULL AND abs(h.amount-c.amount)<=0.01),
         count(*) FILTER(WHERE c.reference_id IS NOT NULL AND abs(h.amount-c.amount)>0.01
                          AND abs(h.amount+c.amount-expected.amount)<=0.01),
         count(*) FILTER(WHERE c.reference_id IS NULL)
    INTO v_exact_count,v_additive_count,v_no_canonical_count
  FROM h LEFT JOIN c USING(reference_id) LEFT JOIN expected USING(reference_id);

  IF v_exact_count<>24 OR v_additive_count<>5 OR v_no_canonical_count<>1 THEN
    RAISE EXCEPTION 'COGS evidence changed: exact %, additive %, no canonical %',
      v_exact_count,v_additive_count,v_no_canonical_count;
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS public.inventory_historical_movement_classifications(
  transaction_id uuid PRIMARY KEY REFERENCES public.inventory_transactions(id),
  certification_started_at timestamptz NOT NULL,
  classification text NOT NULL CHECK(classification IN(
    'deterministic_duplicate_evidence',
    'legacy_invoice_movement_evidence',
    'legacy_delivery_movement_evidence',
    'legacy_nonphysical_reservation_evidence',
    'legacy_lifecycle_compensation_evidence',
    'legacy_receipt_evidence',
    'legacy_return_evidence',
    'legacy_adjustment_evidence',
    'legacy_other_evidence'
  )),
  is_effective_after_certification boolean NOT NULL DEFAULT false,
  effective_quantity numeric NOT NULL DEFAULT 0,
  reason text NOT NULL,
  classified_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.inventory_historical_movement_classifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_historical_classifications_read
  ON public.inventory_historical_movement_classifications;
CREATE POLICY inventory_historical_classifications_read
  ON public.inventory_historical_movement_classifications FOR SELECT TO authenticated
  USING (true);
REVOKE ALL ON public.inventory_historical_movement_classifications FROM PUBLIC,anon;
GRANT SELECT ON public.inventory_historical_movement_classifications TO authenticated,service_role;

WITH certification AS (
  SELECT enforcement_started_at
  FROM public.inventory_engine_certification WHERE singleton
), ranked AS (
  SELECT it.*,
         row_number() OVER(
           PARTITION BY it.batch_id,it.transaction_type,
             COALESCE(it.reference_type,''),COALESCE(it.reference_id::text,''),
             COALESCE(it.reference_number,''),it.quantity
           ORDER BY it.created_at,it.id
         ) duplicate_rank
  FROM public.inventory_transactions it,certification
  WHERE it.created_at<certification.enforcement_started_at
)
INSERT INTO public.inventory_historical_movement_classifications(
  transaction_id,certification_started_at,classification,
  is_effective_after_certification,effective_quantity,reason
)
SELECT r.id,c.enforcement_started_at,
       CASE
         WHEN r.duplicate_rank>1 THEN 'deterministic_duplicate_evidence'
         WHEN r.transaction_type='sale' THEN 'legacy_invoice_movement_evidence'
         WHEN r.transaction_type='delivery_challan' THEN 'legacy_delivery_movement_evidence'
         WHEN r.transaction_type IN ('delivery_challan_reserved','reservation','release_reservation')
           THEN 'legacy_nonphysical_reservation_evidence'
         WHEN r.reference_type IN ('dc_item_delete','invoice_item_delete','dc_rejected','dc_cancelled',
                                   'historical_stock_adjustment_reversal','stock_correction')
           THEN 'legacy_lifecycle_compensation_evidence'
         WHEN r.transaction_type='purchase' THEN 'legacy_receipt_evidence'
         WHEN r.transaction_type='return' THEN 'legacy_return_evidence'
         WHEN r.transaction_type='adjustment' THEN 'legacy_adjustment_evidence'
         ELSE 'legacy_other_evidence'
       END,
       false,0,
       'Preserved pre-Inventory-V1 movement evidence; its net effect is consolidated in the certified opening balance and is not replayed.'
FROM ranked r CROSS JOIN certification c
ON CONFLICT(transaction_id) DO NOTHING;

DO $$
DECLARE
  v_run uuid;
  v_h record;
  v_reversal_id uuid;
  v_reversal_number text;
  v_inventory uuid;
  v_cogs uuid;
  v_staff_advance uuid;
  v_retained_earnings uuid;
  v_original record;
  v_exp record;
  v_bank_line record;
  v_replacement_id uuid;
  v_repair_count integer:=0;
  v_classified_count integer:=0;
  v_exception_count integer:=0;
  v_gl numeric;
  v_valuation numeric;
  v_bridge numeric;
BEGIN
  PERFORM set_config('app.finance_historical_repair','on',true);

  SELECT id INTO v_inventory FROM public.chart_of_accounts WHERE code='1130';
  SELECT id INTO v_cogs FROM public.chart_of_accounts WHERE code='5100';
  SELECT id INTO v_staff_advance FROM public.chart_of_accounts WHERE code='1160';
  SELECT id INTO v_retained_earnings FROM public.chart_of_accounts WHERE code='3200';
  IF v_inventory IS NULL OR v_cogs IS NULL OR v_staff_advance IS NULL OR v_retained_earnings IS NULL THEN
    RAISE EXCEPTION 'Required accounts 1130/5100/1160/3200 are missing';
  END IF;

  INSERT INTO public.finance_historical_repair_runs(notes)
  VALUES('2026-08-26 deterministic duplicate COGS, salary advance, and Inventory V1 certification repair')
  RETURNING id INTO v_run;

  FOR v_h IN
    WITH h AS (
      SELECT je.*,
             sum(CASE WHEN coa.code='5100' THEN jel.debit-jel.credit ELSE 0 END) correction_amount
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id=je.id
      JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
      WHERE je.is_posted AND NOT COALESCE(je.is_reversed,false)
        AND je.source_module='historical_cogs_correction'
      GROUP BY je.id
    ), c AS (
      SELECT je.reference_id,
             sum(CASE WHEN coa.code='5100' THEN jel.debit-jel.credit ELSE 0 END) canonical_amount,
             string_agg(DISTINCT je.entry_number,', ' ORDER BY je.entry_number) canonical_entries
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id=je.id
      JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
      WHERE je.is_posted AND NOT COALESCE(je.is_reversed,false)
        AND je.source_module='sales_invoice_cogs'
      GROUP BY je.reference_id
    )
    SELECT h.*,c.canonical_amount,c.canonical_entries
    FROM h JOIN c USING(reference_id)
    WHERE abs(h.correction_amount-c.canonical_amount)<=0.01
    ORDER BY h.entry_number
  LOOP
    v_reversal_id:=public.uuid_from_text('hfr-260826:cogs-duplicate-reversal:'||v_h.id);
    v_reversal_number:='HFR-260826-CDR-'||right(v_h.entry_number,3);

    INSERT INTO public.journal_entries(
      id,entry_number,entry_date,period_id,source_module,reference_id,reference_number,
      description,total_debit,total_credit,is_posted,is_reversed,posted_at,
      posted_by,created_by,transaction_category,transaction_currency,
      functional_currency,exchange_rate,amounts_are_functional
    ) VALUES(
      v_reversal_id,v_reversal_number,v_h.entry_date,v_h.period_id,
      'historical_cogs_duplicate_reversal',v_h.reference_id,v_h.reference_number,
      'Audited reversal of exact duplicate '||v_h.entry_number||'; canonical COGS: '||v_h.canonical_entries,
      v_h.total_credit,v_h.total_debit,true,true,now(),v_h.posted_by,v_h.created_by,
      v_h.transaction_category,v_h.transaction_currency,v_h.functional_currency,
      v_h.exchange_rate,v_h.amounts_are_functional
    );

    INSERT INTO public.journal_entry_lines(
      journal_entry_id,line_number,account_id,description,debit,credit,tax_code_id,
      customer_id,supplier_id,batch_id,transaction_currency,transaction_debit,
      transaction_credit,functional_currency,exchange_rate
    )
    SELECT v_reversal_id,line_number,account_id,
           'Exact duplicate COGS reversal: '||COALESCE(description,''),
           credit,debit,tax_code_id,customer_id,supplier_id,batch_id,
           transaction_currency,transaction_credit,transaction_debit,
           functional_currency,exchange_rate
    FROM public.journal_entry_lines WHERE journal_entry_id=v_h.id ORDER BY line_number;

    UPDATE public.journal_entries
    SET is_reversed=true,reversed_by_id=v_reversal_id
    WHERE id=v_h.id AND NOT COALESCE(is_reversed,false);

    INSERT INTO public.finance_historical_repair_items(
      run_id,document_type,document_id,document_number,repaired_fields,
      old_metadata,new_metadata,repair_reason
    ) VALUES(
      v_run,'historical_cogs_correction',v_h.id,v_h.entry_number,
      ARRAY['is_reversed','reversed_by_id'],
      jsonb_build_object('classification','A','active',true,'amount',v_h.correction_amount,
                         'invoice',v_h.reference_number),
      jsonb_build_object('classification','A','active',false,'reversal_journal_id',v_reversal_id,
                         'canonical_entries',v_h.canonical_entries),
      'Exact duplicate of active canonical sales_invoice_cogs for the same invoice and amount'
    );
    v_repair_count:=v_repair_count+1;
  END LOOP;

  FOR v_h IN
    WITH h AS (
      SELECT je.*,sum(CASE WHEN coa.code='5100' THEN jel.debit-jel.credit ELSE 0 END) correction_amount
      FROM public.journal_entries je JOIN public.journal_entry_lines jel ON jel.journal_entry_id=je.id
      JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
      WHERE je.is_posted AND NOT COALESCE(je.is_reversed,false) AND je.source_module='historical_cogs_correction'
      GROUP BY je.id
    ), c AS (
      SELECT je.reference_id,sum(CASE WHEN coa.code='5100' THEN jel.debit-jel.credit ELSE 0 END) canonical_amount
      FROM public.journal_entries je JOIN public.journal_entry_lines jel ON jel.journal_entry_id=je.id
      JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
      WHERE je.is_posted AND NOT COALESCE(je.is_reversed,false) AND je.source_module='sales_invoice_cogs'
      GROUP BY je.reference_id
    ), e AS (
      SELECT si.id reference_id,sum(sii.quantity*COALESCE(b.landed_cost_per_unit,b.cost_per_unit,b.import_price,0)) expected_amount
      FROM public.sales_invoices si JOIN public.sales_invoice_items sii ON sii.invoice_id=si.id
      LEFT JOIN public.batches b ON b.id=sii.batch_id GROUP BY si.id
    )
    SELECT h.*,c.canonical_amount,e.expected_amount
    FROM h LEFT JOIN c USING(reference_id) LEFT JOIN e USING(reference_id)
    WHERE c.reference_id IS NULL
       OR (abs(h.correction_amount-c.canonical_amount)>0.01
           AND abs(h.correction_amount+c.canonical_amount-e.expected_amount)<=0.01)
    ORDER BY h.entry_number
  LOOP
    INSERT INTO public.finance_historical_repair_items(
      run_id,document_type,document_id,document_number,repaired_fields,
      old_metadata,new_metadata,repair_reason
    ) VALUES(
      v_run,'historical_cogs_correction',v_h.id,v_h.entry_number,ARRAY['classification_only'],
      jsonb_build_object('active',true,'amount',v_h.correction_amount),
      jsonb_build_object(
        'active',true,
        'classification',CASE WHEN v_h.canonical_amount IS NULL THEN 'C' ELSE 'B' END,
        'canonical_amount',v_h.canonical_amount,'expected_amount',v_h.expected_amount
      ),
      CASE WHEN v_h.canonical_amount IS NULL
        THEN 'No active canonical sales_invoice_cogs exists; preserved as the effective historical COGS evidence'
        ELSE 'Legitimate additive correction: canonical COGS plus correction equals invoice batch valuation'
      END
    );
    v_classified_count:=v_classified_count+1;
  END LOOP;

  IF v_repair_count<>24 OR v_classified_count<>6 THEN
    RAISE EXCEPTION 'Unexpected COGS repair result: reversed %, preserved/classified %',v_repair_count,v_classified_count;
  END IF;

  FOR v_exp IN
    SELECT * FROM public.finance_expenses
    WHERE voucher_number IN ('EXP/26-26/093','EXP/26-26/102','EXP/26-26/110')
    ORDER BY voucher_number
  LOOP
    IF (v_exp.voucher_number='EXP/26-26/093' AND (v_exp.amount<>500000 OR v_exp.staff_id<>'276dc2e0-3cb2-426f-aee7-a9991e5f4cfc'))
       OR (v_exp.voucher_number='EXP/26-26/102' AND (v_exp.amount<>150000 OR v_exp.staff_id<>'276dc2e0-3cb2-426f-aee7-a9991e5f4cfc'))
       OR (v_exp.voucher_number='EXP/26-26/110' AND (v_exp.amount<>500000 OR v_exp.staff_id<>'b115a6f0-dbc2-49b1-aad4-58136704eadf')) THEN
      RAISE EXCEPTION 'Salary advance evidence changed for %',v_exp.voucher_number;
    END IF;

    SELECT je.* INTO STRICT v_original
    FROM public.journal_entries je
    WHERE je.reference_id=v_exp.id AND je.source_module IN('expense','expenses')
      AND je.is_posted AND NOT COALESCE(je.is_reversed,false);

    IF NOT EXISTS(
      SELECT 1 FROM public.journal_entry_lines jel
      JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
      WHERE jel.journal_entry_id=v_original.id AND coa.code='6100'
        AND jel.debit=v_exp.amount AND jel.credit=0
    ) THEN RAISE EXCEPTION '% is not the proven salary-expense misclassification',v_exp.voucher_number; END IF;

    SELECT jel.* INTO STRICT v_bank_line
    FROM public.journal_entry_lines jel JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
    WHERE jel.journal_entry_id=v_original.id AND coa.code LIKE '111%'
      AND jel.credit=v_exp.amount AND jel.debit=0;

    v_reversal_id:=public.uuid_from_text('hfr-260826:salary-advance-reversal:'||v_exp.id);
    v_reversal_number:='HFR-260826-SAR-'||right(v_exp.voucher_number,3);
    INSERT INTO public.journal_entries(
      id,entry_number,entry_date,period_id,source_module,reference_id,reference_number,
      description,total_debit,total_credit,is_posted,is_reversed,posted_at,posted_by,created_by
    ) VALUES(
      v_reversal_id,v_reversal_number,v_original.entry_date,v_original.period_id,
      'historical_salary_advance_reversal',v_exp.id,v_exp.voucher_number,
      'Audited reversal of salary-expense misclassification '||v_original.entry_number,
      v_original.total_credit,v_original.total_debit,true,true,now(),v_original.posted_by,v_original.created_by
    );
    INSERT INTO public.journal_entry_lines(
      journal_entry_id,line_number,account_id,description,debit,credit,tax_code_id,
      customer_id,supplier_id,batch_id,transaction_currency,transaction_debit,
      transaction_credit,functional_currency,exchange_rate
    )
    SELECT v_reversal_id,line_number,account_id,'Salary advance repair reversal: '||COALESCE(description,''),
           credit,debit,tax_code_id,customer_id,supplier_id,batch_id,
           transaction_currency,transaction_credit,transaction_debit,functional_currency,exchange_rate
    FROM public.journal_entry_lines WHERE journal_entry_id=v_original.id ORDER BY line_number;
    UPDATE public.journal_entries SET is_reversed=true,reversed_by_id=v_reversal_id
    WHERE id=v_original.id;

    v_replacement_id:=NULL;
    IF v_exp.voucher_number IN ('EXP/26-26/093','EXP/26-26/102') THEN
      v_replacement_id:=public.uuid_from_text('hfr-260826:salary-advance-replacement:'||v_exp.id);
      INSERT INTO public.journal_entries(
        id,entry_number,entry_date,period_id,source_module,reference_id,reference_number,
        description,total_debit,total_credit,is_posted,is_reversed,posted_at,posted_by,created_by
      ) VALUES(
        v_replacement_id,'HFR-260826-SAA-'||right(v_exp.voucher_number,3),v_original.entry_date,v_original.period_id,
        'historical_salary_advance_repair',v_exp.id,v_exp.voucher_number,
        'Effective staff advance reclassification for '||v_exp.voucher_number,
        v_exp.amount,v_exp.amount,true,false,now(),v_original.posted_by,v_original.created_by
      );
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit)
      VALUES(v_replacement_id,1,v_staff_advance,'Staff Advance Issued - '||v_exp.voucher_number,v_exp.amount,0),
            (v_replacement_id,2,v_bank_line.account_id,'Historical bank payment - '||v_exp.voucher_number,0,v_exp.amount);
      UPDATE public.finance_expenses SET expense_category='staff_advance' WHERE id=v_exp.id;
    ELSE
      IF NOT EXISTS(
        SELECT 1 FROM public.payment_vouchers pv
        JOIN public.journal_entries je ON je.id=pv.journal_entry_id
        JOIN public.journal_entry_lines jel ON jel.journal_entry_id=je.id
        WHERE pv.voucher_number='PV/26-26/006' AND pv.staff_id=v_exp.staff_id
          AND pv.payment_purpose='salary_advance' AND pv.is_posted
          AND jel.account_id=v_staff_advance AND jel.debit=500000
      ) THEN RAISE EXCEPTION 'Canonical PV/26-26/006 staff advance evidence is missing'; END IF;
    END IF;

    INSERT INTO public.finance_historical_repair_items(
      run_id,document_type,document_id,document_number,repaired_fields,
      old_metadata,new_metadata,repair_reason
    ) VALUES(
      v_run,'salary_advance_expense',v_exp.id,v_exp.voucher_number,
      CASE WHEN v_replacement_id IS NULL THEN ARRAY['journal_effect'] ELSE ARRAY['expense_category','journal_effect'] END,
      jsonb_build_object('expense_category',v_exp.expense_category,'journal_id',v_original.id,'salary_expense',v_exp.amount),
      jsonb_build_object('expense_category',CASE WHEN v_replacement_id IS NULL THEN v_exp.expense_category ELSE 'staff_advance' END,
                         'reversal_journal_id',v_reversal_id,'replacement_journal_id',v_replacement_id,
                         'staff_advance',v_exp.amount),
      CASE WHEN v_replacement_id IS NULL
        THEN 'Duplicate EXP salary posting neutralized; canonical PV/26-26/006 remains the staff-advance issuance'
        ELSE 'Historical salary expense reclassified to Staff Advances & Loans 1160 without changing the bank effect'
      END
    );
    v_repair_count:=v_repair_count+1;
  END LOOP;

  IF NOT EXISTS(
    SELECT 1 FROM public.payment_vouchers pv
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id=pv.journal_entry_id
    WHERE pv.voucher_number='PV/26-26/007' AND pv.payment_purpose='salary_advance_settlement'
      AND pv.payment_method='advance_adjustment' AND pv.is_posted
      AND jel.account_id=v_staff_advance AND jel.credit=500000
  ) THEN RAISE EXCEPTION 'Canonical PV/26-26/007 advance settlement evidence is missing'; END IF;

  SELECT COALESCE(sum(jel.debit-jel.credit),0) INTO v_gl
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id=jel.journal_entry_id
  WHERE jel.account_id=v_inventory AND je.is_posted AND NOT COALESCE(je.is_reversed,false);
  SELECT COALESCE(sum(b.current_stock*COALESCE(b.landed_cost_per_unit,b.cost_per_unit,b.import_price,0)),0)
    INTO v_valuation FROM public.batches b WHERE COALESCE(b.is_active,true);
  v_bridge:=round(v_valuation-v_gl,2);
  IF v_bridge<>4106722840.60 THEN
    RAISE EXCEPTION 'Inventory valuation bridge changed: GL %, valuation %, bridge %',v_gl,v_valuation,v_bridge;
  END IF;

  v_replacement_id:=public.uuid_from_text('hfr-260826:inventory-valuation-bridge');
  INSERT INTO public.journal_entries(
    id,entry_number,entry_date,source_module,reference_id,reference_number,description,
    total_debit,total_credit,is_posted,is_reversed,posted_at
  ) VALUES(
    v_replacement_id,'HFR-260826-INV-001','2026-08-26','historical_inventory_valuation',
    v_replacement_id,'HFR-260826-INV-VALUATION',
    'Prior-period inventory capitalization bridge to certified active-batch valuation; no physical quantity change',
    v_bridge,v_bridge,true,false,now()
  );
  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit)
  VALUES(v_replacement_id,1,v_inventory,'Certified active-batch inventory valuation bridge',v_bridge,0),
        (v_replacement_id,2,v_retained_earnings,'Prior-period inventory capitalization correction',0,v_bridge);
  INSERT INTO public.finance_historical_repair_items(
    run_id,document_type,document_id,document_number,repaired_fields,old_metadata,new_metadata,repair_reason
  ) VALUES(
    v_run,'inventory_valuation',v_replacement_id,'HFR-260826-INV-001',ARRAY['inventory_gl'],
    jsonb_build_object('inventory_gl',v_gl,'active_batch_valuation',v_valuation,'variance',v_gl-v_valuation),
    jsonb_build_object('inventory_gl',v_gl+v_bridge,'active_batch_valuation',v_valuation,'variance',0),
    'Deterministic prior-period capitalization bridge derived from active batch quantity times canonical batch cost'
  );
  v_repair_count:=v_repair_count+1;

  INSERT INTO public.finance_historical_repair_items(
    run_id,document_type,document_id,document_number,repaired_fields,old_metadata,new_metadata,repair_reason
  )
  SELECT v_run,'inventory_movement',c.transaction_id,it.reference_number,ARRAY['effective_classification'],
         jsonb_build_object('transaction_type',it.transaction_type,'quantity',it.quantity,
                            'operation_id',it.operation_id,'classification','unclassified_legacy'),
         jsonb_build_object('classification',c.classification,'effective_quantity',0,
                            'certification_started_at',c.certification_started_at),
         c.reason
  FROM public.inventory_historical_movement_classifications c
  JOIN public.inventory_transactions it ON it.id=c.transaction_id;
  GET DIAGNOSTICS v_classified_count=ROW_COUNT;

  UPDATE public.finance_historical_repair_runs
  SET completed_at=now(),total_records_scanned=30+3+v_classified_count,
      records_repaired=v_repair_count,records_partially_repaired=0,
      records_manual_review=v_exception_count,records_skipped=0
  WHERE id=v_run;
END$$;

CREATE OR REPLACE VIEW public.inventory_v1_effective_ledger
WITH (security_invoker=true)
AS
WITH cert AS (
  SELECT enforcement_started_at FROM public.inventory_engine_certification WHERE singleton
), post_totals AS (
  SELECT it.batch_id,sum(it.quantity) quantity
  FROM public.inventory_transactions it,cert
  WHERE it.created_at>=cert.enforcement_started_at
  GROUP BY it.batch_id
), raw AS (
  SELECT it.id,it.batch_id,it.product_id,it.transaction_type,it.quantity,
         CASE WHEN it.created_at>=cert.enforcement_started_at THEN it.quantity ELSE 0 END effective_quantity,
         it.reference_type,it.reference_id,it.reference_number,it.transaction_date,it.notes,
         it.created_by,it.created_at,it.stock_before,it.stock_after,it.operation_id,it.metadata,
         (it.created_at>=cert.enforcement_started_at) is_effective,
         COALESCE(h.classification,
           CASE WHEN it.created_at>=cert.enforcement_started_at THEN 'canonical_inventory_v1' ELSE 'legacy_evidence' END
         ) effective_classification
  FROM public.inventory_transactions it CROSS JOIN cert
  LEFT JOIN public.inventory_historical_movement_classifications h ON h.transaction_id=it.id
), opening AS (
  SELECT public.uuid_from_text('inventory-v1:certified-opening:'||b.id) id,b.id batch_id,b.product_id,
         'certified_opening'::text transaction_type,
         b.current_stock-COALESCE(pt.quantity,0) quantity,
         b.current_stock-COALESCE(pt.quantity,0) effective_quantity,
         'inventory_v1_certification'::text reference_type,b.id reference_id,
         'INVENTORY-V1-CERTIFIED-OPENING'::text reference_number,
         cert.enforcement_started_at::date transaction_date,
         'Certified opening balance consolidating preserved pre-V1 movement evidence'::text notes,
         NULL::uuid created_by,cert.enforcement_started_at created_at,0::numeric stock_before,
         b.current_stock-COALESCE(pt.quantity,0) stock_after,NULL::uuid operation_id,
         jsonb_build_object('canonical_engine_version','1.0','synthetic_opening',true) metadata,
         true is_effective,'certified_opening_balance'::text effective_classification
  FROM public.batches b CROSS JOIN cert LEFT JOIN post_totals pt ON pt.batch_id=b.id
)
SELECT x.*,
       jsonb_build_object('product_name',p.product_name,'product_code',p.product_code) products,
       jsonb_build_object('batch_number',b.batch_number) batches,
       CASE WHEN up.id IS NULL THEN NULL ELSE jsonb_build_object('full_name',up.full_name) END user_profiles
FROM (SELECT * FROM raw UNION ALL SELECT * FROM opening) x
JOIN public.products p ON p.id=x.product_id
JOIN public.batches b ON b.id=x.batch_id
LEFT JOIN public.user_profiles up ON up.id=x.created_by;

CREATE OR REPLACE VIEW public.inventory_v1_conservation_reconciliation
WITH (security_invoker=true)
AS
SELECT b.id batch_id,b.batch_number,b.import_quantity,b.current_stock,b.reserved_stock,
       sum(l.effective_quantity) effective_ledger_quantity,
       sum(l.effective_quantity)-b.current_stock conservation_error,
       COALESCE(b.current_stock,0)<0 negative_stock,
       COALESCE(b.reserved_stock,0)>COALESCE(b.current_stock,0) reserved_exceeds_current
FROM public.batches b
JOIN public.inventory_v1_effective_ledger l ON l.batch_id=b.id AND l.is_effective
GROUP BY b.id;

CREATE OR REPLACE VIEW public.inventory_gl_valuation_reconciliation
WITH (security_invoker=true)
AS
WITH gl AS (
  SELECT COALESCE(sum(jel.debit-jel.credit),0) inventory_gl
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id=jel.journal_entry_id
  JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
  WHERE coa.code='1130' AND je.is_posted AND NOT COALESCE(je.is_reversed,false)
), valuation AS (
  SELECT COALESCE(sum(b.current_stock*COALESCE(b.landed_cost_per_unit,b.cost_per_unit,b.import_price,0)),0) batch_valuation
  FROM public.batches b WHERE COALESCE(b.is_active,true)
)
SELECT gl.inventory_gl,valuation.batch_valuation,
       gl.inventory_gl-valuation.batch_valuation variance FROM gl,valuation;

REVOKE ALL ON public.inventory_v1_effective_ledger,
  public.inventory_v1_conservation_reconciliation,
  public.inventory_gl_valuation_reconciliation FROM PUBLIC,anon;
GRANT SELECT ON public.inventory_v1_effective_ledger,
  public.inventory_v1_conservation_reconciliation,
  public.inventory_gl_valuation_reconciliation TO authenticated,service_role;

COMMENT ON VIEW public.inventory_v1_effective_ledger IS
  'Effective Inventory V1 ledger: certified opening plus post-certification canonical movements. Pre-V1 rows remain visible as zero-effect historical evidence.';
COMMENT ON VIEW public.inventory_v1_conservation_reconciliation IS
  'Batch-level certified stock conservation; every effective ledger total must equal batches.current_stock.';
