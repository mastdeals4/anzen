import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireRole, writeSecurityAudit } from "../_shared/security.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const authResult = await requireRole(req, supabaseUrl, serviceKey, ["admin"], corsHeaders);
    if (!authResult.ok) return authResult.response;

    const db = authResult.adminClient;
    await writeSecurityAudit(db, authResult.auth, "fix_stock_reservations_started", {
      function_name: "fix-stock-reservations",
      method: req.method,
    });

    const results: string[] = [];

    results.push('Storage bucket privacy unchanged: this repair no longer creates buckets or forces public=true');

    // Step 1: Fix DC approval trigger to use available stock (current - reserved + SO reservation)
    const dcTriggerSQL = `
      CREATE OR REPLACE FUNCTION trg_dc_approval_validate_stock()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $func$
      DECLARE
        v_item RECORD;
        v_available_stock numeric;
        v_so_reserved numeric;
      BEGIN
        IF NEW.approval_status = 'approved' AND (OLD.approval_status IS NULL OR OLD.approval_status != 'approved') THEN
          FOR v_item IN
            SELECT dci.*, p.product_name, p.unit, b.batch_number, b.current_stock, b.reserved_stock
            FROM delivery_challan_items dci
            JOIN products p ON dci.product_id = p.id
            JOIN batches b ON dci.batch_id = b.id
            WHERE dci.challan_id = NEW.id
          LOOP
            SELECT COALESCE(SUM(sr.reserved_quantity), 0)
            INTO v_so_reserved
            FROM stock_reservations sr
            WHERE sr.batch_id = v_item.batch_id
              AND sr.sales_order_id = NEW.sales_order_id
              AND sr.is_released = false;

            v_available_stock := v_item.current_stock
              - COALESCE(v_item.reserved_stock, 0)
              + v_so_reserved;

            IF v_available_stock < v_item.quantity THEN
              RAISE EXCEPTION 'Insufficient stock for batch %!

Product: %
Batch: %
Available: % %
Requested: % %

Please reduce quantity or select a different batch.',
                v_item.batch_number,
                v_item.product_name,
                v_item.batch_number,
                v_available_stock,
                COALESCE(v_item.unit, 'units'),
                v_item.quantity,
                COALESCE(v_item.unit, 'units');
            END IF;
          END LOOP;
        END IF;
        RETURN NEW;
      END;
      $func$;
    `;

    const dcTriggerResp = await fetch(`${supabaseUrl}/rest/v1/rpc/`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': 'Bearer ' + serviceKey,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      }
    });

    // Use postgres directly via the db client workaround
    // Insert a dummy record to trigger a plpgsql function that runs our DDL
    // Actually, let's use the pg REST endpoint
    const pgResp = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_ddl`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': 'Bearer ' + serviceKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ sql: dcTriggerSQL })
    });
    if (pgResp.ok) {
      results.push('DC trigger fixed via exec_ddl');
    } else {
      // Try alternate approach - update via supabase-js
      results.push('exec_ddl not available, DC trigger needs manual fix');
    }

    // Step 2: Re-run reservations for all shortage SOs
    const { data: shortSOs, error: e3 } = await db
      .from('sales_orders')
      .select('id, so_number')
      .eq('status', 'shortage');

    results.push(`Found ${shortSOs?.length || 0} shortage SOs`);
    for (const so of (shortSOs || [])) {
      const { data: res, error: err } = await db.rpc('fn_reserve_stock_for_so_v2', { p_so_id: so.id });
      results.push(`SO ${so.so_number}: ${err ? err.message : JSON.stringify(res?.[0])}`);
    }

    // Step 3: Mark import_requirements as received where stock is sufficient
    const { data: products } = await db.from('product_stock_summary').select('product_id, total_current_stock, product_name');
    let markedReceived = 0;
    for (const p of (products || [])) {
      const { data: reservations } = await db.from('stock_reservations').select('reserved_quantity').eq('product_id', p.product_id).eq('is_released', false);
      const totalReserved = reservations?.reduce((s: number, r: any) => s + Number(r.reserved_quantity), 0) || 0;
      if (p.total_current_stock >= totalReserved) {
        const { data: updated } = await db.from('import_requirements').update({ status: 'received', notes: 'Auto-received: stock sufficient' }).eq('product_id', p.product_id).in('status', ['pending', 'ordered']).select('id');
        if (updated?.length) {
          markedReceived += updated.length;
          results.push(`${p.product_name}: marked ${updated.length} import reqs received`);
        }
      }
    }
    results.push(`Total import reqs marked received: ${markedReceived}`);

    await writeSecurityAudit(db, authResult.auth, "fix_stock_reservations_completed", {
      function_name: "fix-stock-reservations",
      result_count: results.length,
      marked_received_count: markedReceived,
      shortage_so_count: shortSOs?.length || 0,
    });

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
