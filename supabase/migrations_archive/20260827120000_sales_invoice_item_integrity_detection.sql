/* Detect financially populated invoices whose product table is empty. This
   is intentionally a reporting view so legacy records are not mutated or
   blocked; creation code rejects the condition before saving. */
CREATE OR REPLACE VIEW public.sales_invoice_item_integrity AS
SELECT si.id AS invoice_id,
       si.invoice_number,
       si.customer_id,
       si.sales_order_id,
       si.linked_challan_ids,
       si.subtotal,
       si.tax_amount,
       si.total_amount,
       COUNT(sii.id)::integer AS item_count,
       CASE WHEN COALESCE(si.total_amount,0) > 0 AND COUNT(sii.id)=0
            THEN 'missing_product_rows' ELSE 'ok' END AS integrity_status
FROM public.sales_invoices si
LEFT JOIN public.sales_invoice_items sii ON sii.invoice_id=si.id
GROUP BY si.id, si.invoice_number, si.customer_id, si.sales_order_id,
         si.linked_challan_ids, si.subtotal, si.tax_amount, si.total_amount;
GRANT SELECT ON public.sales_invoice_item_integrity TO authenticated,service_role;
