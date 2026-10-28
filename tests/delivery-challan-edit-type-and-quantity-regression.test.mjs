import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

const DB_CONNECTION =
  process.env.DATABASE_URL ||
  'postgresql://postgres.dkrtsqienlhpouohmfki:Kunallunkad%40123@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres';

async function withDbClient(callback) {
  const client = new pg.Client({
    connectionString: DB_CONNECTION,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function setAuthenticatedUser(client, userId) {
  await client.query('SET ROLE authenticated');
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [userId]);
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ]);
}

test('Delivery Challan Edit & Recovery Type Safety and Quantity Regression Suite', async (t) => {
  let adminId;

  await withDbClient(async (client) => {
    const adminRes = await client.query(`SELECT id FROM user_profiles WHERE role = 'admin' AND is_active = true LIMIT 1`);
    assert.ok(adminRes.rows.length > 0, 'Must have at least one active admin user');
    adminId = adminRes.rows[0].id;
  });

  // Test Definition of the corrected RPC in an isolated transaction
  const setupCorrectedRpc = async (client) => {
    await client.query('DROP FUNCTION IF EXISTS public.edit_delivery_challan(uuid, jsonb)');
    await client.query('DROP FUNCTION IF EXISTS public.edit_delivery_challan(uuid, jsonb, jsonb)');

    await client.query(`
      CREATE FUNCTION public.edit_delivery_challan(
        p_challan_id uuid,
        p_new_items jsonb,
        p_header jsonb DEFAULT NULL::jsonb
      )
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path TO 'public', 'pg_temp'
      AS $$
      DECLARE
        v_role               text;
        v_challan            record;
        v_item               jsonb;
        v_count              integer;
        v_product_id         uuid;
        v_batch_id           uuid;
        v_new_qty            numeric;
        v_item_id            uuid;
        v_so_item_id         uuid;
        v_so_id              uuid;
        v_blocking_invoices  text;
        v_kept_ids           uuid[] := ARRAY[]::uuid[];
        v_new_status         text;
        v_parsed_status      public.dc_approval_status := NULL;
        v_so_status          text;
        v_soi_qty            numeric;
        v_soi_del_qty        numeric;
        v_other_pending      numeric;
        v_remaining_qty      numeric;
        v_batch_active       boolean;
        v_batch_not_expired  boolean;
      BEGIN
        SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();
        IF v_role NOT IN ('admin', 'accounts', 'warehouse', 'sales') THEN
          RAISE EXCEPTION 'Permission denied: role % cannot edit delivery challans', v_role;
        END IF;

        SELECT * INTO v_challan FROM public.delivery_challans WHERE id = p_challan_id FOR UPDATE;

        IF NOT FOUND THEN
          RETURN jsonb_build_object('success', false, 'error', 'Delivery challan not found');
        END IF;

        IF v_challan.approval_status = 'approved' THEN
          RETURN jsonb_build_object('success', false, 'error', 'Cannot edit approved delivery challan directly; reverse it or use approved DC edit');
        END IF;

        -- Check if any active (uncancelled) invoice items reference this DC
        IF EXISTS (
          SELECT 1
          FROM public.sales_invoice_items sii
          JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
          JOIN public.sales_invoices si ON si.id = sii.invoice_id
          WHERE dci.challan_id = p_challan_id
            AND NOT (si.notes LIKE '[CANCELLED%' OR LOWER(si.notes) LIKE 'cancelled%')
        ) THEN
          SELECT string_agg(DISTINCT si.invoice_number, ', ')
          INTO v_blocking_invoices
          FROM public.sales_invoice_items sii
          JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
          JOIN public.sales_invoices si ON si.id = sii.invoice_id
          WHERE dci.challan_id = p_challan_id
            AND NOT (si.notes LIKE '[CANCELLED%' OR LOWER(si.notes) LIKE 'cancelled%');

          RETURN jsonb_build_object(
            'success', false,
            'error', 'Delivery Challan already invoiced by active invoice(s) ' || v_blocking_invoices || '; cancel or reverse the invoice(s) first'
          );
        END IF;

        -- Validate header if provided
        IF p_header IS NOT NULL THEN
          IF p_header ? 'approval_status' THEN
            v_new_status := NULLIF(TRIM(p_header->>'approval_status'), '');
            IF v_new_status IS NOT NULL THEN
              IF v_new_status NOT IN ('pending_approval', 'rejected', 'cancelled') THEN
                RETURN jsonb_build_object(
                  'success', false,
                  'error', 'Invalid approval_status: ' || v_new_status || '. Allowed values are pending_approval, rejected, cancelled.'
                );
              END IF;
              v_parsed_status := v_new_status::public.dc_approval_status;
            END IF;
          END IF;

          v_so_id := CASE 
            WHEN p_header ? 'sales_order_id' THEN NULLIF(p_header->>'sales_order_id', '')::uuid 
            ELSE v_challan.sales_order_id 
          END;

          -- Verify parent Sales Order status if linked
          IF v_so_id IS NOT NULL THEN
            SELECT status::text INTO v_so_status FROM public.sales_orders WHERE id = v_so_id;
            IF v_so_status IN ('cancelled', 'rejected') THEN
              RETURN jsonb_build_object(
                'success', false,
                'error', 'Cannot save Delivery Challan: linked Sales Order is ' || v_so_status
              );
            END IF;
          END IF;

          UPDATE public.delivery_challans SET
            customer_id = CASE WHEN p_header ? 'customer_id' THEN COALESCE(NULLIF(p_header->>'customer_id', '')::uuid, customer_id) ELSE customer_id END,
            sales_order_id = v_so_id,
            challan_date = CASE WHEN p_header ? 'challan_date' THEN COALESCE(NULLIF(p_header->>'challan_date', '')::date, challan_date) ELSE challan_date END,
            delivery_address = CASE WHEN p_header ? 'delivery_address' THEN COALESCE(p_header->>'delivery_address', delivery_address) ELSE delivery_address END,
            vehicle_number = CASE WHEN p_header ? 'vehicle_number' THEN NULLIF(p_header->>'vehicle_number', '') ELSE vehicle_number END,
            driver_name = CASE WHEN p_header ? 'driver_name' THEN NULLIF(p_header->>'driver_name', '') ELSE driver_name END,
            notes = CASE WHEN p_header ? 'notes' THEN NULLIF(p_header->>'notes', '') ELSE notes END,
            approval_status = COALESCE(v_parsed_status, approval_status),
            rejection_reason = CASE WHEN v_parsed_status = 'pending_approval'::public.dc_approval_status THEN NULL WHEN p_header ? 'rejection_reason' THEN NULLIF(p_header->>'rejection_reason', '') ELSE rejection_reason END,
            rejected_by = CASE WHEN v_parsed_status = 'pending_approval'::public.dc_approval_status THEN NULL ELSE rejected_by END,
            rejected_at = CASE WHEN v_parsed_status = 'pending_approval'::public.dc_approval_status THEN NULL ELSE rejected_at END,
            approved_at = CASE WHEN v_parsed_status = 'pending_approval'::public.dc_approval_status THEN NULL ELSE approved_at END,
            approved_by = CASE WHEN v_parsed_status = 'pending_approval'::public.dc_approval_status THEN NULL ELSE approved_by END,
            updated_at = NOW()
          WHERE id = p_challan_id;
        ELSE
          v_so_id := v_challan.sales_order_id;
          IF v_so_id IS NOT NULL THEN
            SELECT status::text INTO v_so_status FROM public.sales_orders WHERE id = v_so_id;
            IF v_so_status IN ('cancelled', 'rejected') THEN
              RETURN jsonb_build_object(
                'success', false,
                'error', 'Cannot save Delivery Challan: linked Sales Order is ' || v_so_status
              );
            END IF;
          END IF;
        END IF;

        SELECT count(*) INTO v_count FROM jsonb_array_elements(p_new_items);
        IF v_count = 0 THEN
          RETURN jsonb_build_object('success', false, 'error', 'Cannot save DC with no items');
        END IF;

        PERFORM set_config('app.skip_dc_item_trigger', 'true', true);
        PERFORM set_config('app.sales_invoice_cancel', 'true', true);

        -- Upsert / replace items
        FOR v_item IN SELECT * FROM jsonb_array_elements(p_new_items)
        LOOP
          v_item_id    := NULLIF(v_item->>'id', '')::uuid;
          v_product_id := NULLIF(v_item->>'product_id', '')::uuid;
          v_batch_id   := NULLIF(v_item->>'batch_id', '')::uuid;
          v_new_qty    := NULLIF(v_item->>'quantity', '')::numeric;
          v_so_item_id := NULLIF(v_item->>'sales_order_item_id', '')::uuid;

          IF v_product_id IS NULL OR v_batch_id IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'Each delivery item must have a valid product and batch');
          END IF;

          IF v_new_qty IS NULL OR v_new_qty <= 0 THEN
            RETURN jsonb_build_object('success', false, 'error', 'Item quantity must be greater than zero');
          END IF;

          -- Batch validity check
          SELECT is_active, (expiry_date IS NULL OR expiry_date > CURRENT_DATE)
          INTO v_batch_active, v_batch_not_expired
          FROM public.batches
          WHERE id = v_batch_id AND product_id = v_product_id;

          IF NOT FOUND OR NOT COALESCE(v_batch_active, false) OR NOT COALESCE(v_batch_not_expired, false) THEN
            RETURN jsonb_build_object('success', false, 'error', 'Selected batch is invalid, inactive, or expired');
          END IF;

          -- SO Item quantity constraint
          IF v_so_id IS NOT NULL AND v_so_item_id IS NOT NULL THEN
            SELECT quantity, COALESCE(delivered_quantity, 0)
            INTO v_soi_qty, v_soi_del_qty
            FROM public.sales_order_items
            WHERE id = v_so_item_id AND sales_order_id = v_so_id AND product_id = v_product_id;

            IF NOT FOUND THEN
              RETURN jsonb_build_object('success', false, 'error', 'DC item does not match the linked Sales Order item');
            END IF;

            SELECT COALESCE(sum(dci.quantity), 0) INTO v_other_pending
            FROM public.delivery_challan_items dci
            JOIN public.delivery_challans dc ON dc.id = dci.challan_id
            WHERE dci.sales_order_item_id = v_so_item_id
              AND dc.approval_status = 'pending_approval'
              AND dc.id <> p_challan_id;

            v_remaining_qty := v_soi_qty - v_soi_del_qty;
            IF (v_other_pending + v_new_qty) > (v_remaining_qty + 0.0001) THEN
              RETURN jsonb_build_object(
                'success', false,
                'error', 'Delivery quantity (' || v_new_qty || ') exceeds remaining Sales Order quantity (' || (v_remaining_qty - v_other_pending) || ')'
              );
            END IF;
          END IF;

          IF v_item_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.delivery_challan_items WHERE id = v_item_id AND challan_id = p_challan_id) THEN
            UPDATE public.delivery_challan_items SET
              product_id = v_product_id,
              batch_id = v_batch_id,
              sales_order_item_id = v_so_item_id,
              quantity = v_new_qty,
              pack_size = NULLIF(v_item->>'pack_size', '')::numeric,
              pack_type = NULLIF(v_item->>'pack_type', ''),
              number_of_packs = NULLIF(v_item->>'number_of_packs', '')::integer
            WHERE id = v_item_id;

            v_kept_ids := array_append(v_kept_ids, v_item_id);
          ELSE
            v_item_id := COALESCE(v_item_id, gen_random_uuid());
            INSERT INTO public.delivery_challan_items (
              id, challan_id, product_id, batch_id, sales_order_item_id, quantity,
              pack_size, pack_type, number_of_packs
            ) VALUES (
              v_item_id, p_challan_id, v_product_id, v_batch_id, v_so_item_id, v_new_qty,
              NULLIF(v_item->>'pack_size', '')::numeric,
              NULLIF(v_item->>'pack_type', ''),
              NULLIF(v_item->>'number_of_packs', '')::integer
            );
            v_kept_ids := array_append(v_kept_ids, v_item_id);
          END IF;
        END LOOP;

        -- Remove any DC items that were not in the updated item list
        DELETE FROM public.delivery_challan_items
        WHERE challan_id = p_challan_id
          AND id <> ALL(v_kept_ids);

        PERFORM set_config('app.skip_dc_item_trigger', 'false', true);
        PERFORM set_config('app.sales_invoice_cancel', 'false', true);

        RETURN jsonb_build_object('success', true, 'message', 'Delivery challan updated successfully');

      EXCEPTION
        WHEN foreign_key_violation THEN
          PERFORM set_config('app.skip_dc_item_trigger', 'false', true);
          PERFORM set_config('app.sales_invoice_cancel', 'false', true);
          RETURN jsonb_build_object('success', false, 'error', 'Invalid product or batch selection: ' || SQLERRM);
        WHEN OTHERS THEN
          PERFORM set_config('app.skip_dc_item_trigger', 'false', true);
          PERFORM set_config('app.sales_invoice_cancel', 'false', true);
          RETURN jsonb_build_object('success', false, 'error', SQLERRM);
      END;
      $$;
    `);

    await client.query('GRANT EXECUTE ON FUNCTION public.edit_delivery_challan(uuid, jsonb, jsonb) TO authenticated');
  };

  await t.test('1. Reproduction of Type Error in Existing Live Function', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setAuthenticatedUser(client, adminId);

        // Call the current unpatched function with header containing text approval_status
        const res = await client.query(`
          SELECT edit_delivery_challan(
            $1::uuid,
            $2::jsonb,
            $3::jsonb
          ) as result
        `, [
          'abda70d6-cede-4a14-bc47-1adea0729f6f',
          JSON.stringify([{
            id: 'baadf206-f75f-4109-89e3-2a20f836351f',
            product_id: 'f9ca763f-47c0-4bfa-b2a0-1905152458c6',
            batch_id: 'f767785c-1d74-4b03-b7be-1e6cd6b8282f',
            sales_order_item_id: '2a1def7d-a77f-4873-b2c9-aeefc26d6689',
            quantity: 20
          }]),
          JSON.stringify({
            customer_id: 'b8f9dc5e-2cdf-4527-8960-186bb2a30913',
            approval_status: 'pending_approval'
          })
        ]);

        const result = res.rows[0].result;
        assert.equal(result.success, false);
        assert.match(
          result.error,
          /COALESCE types text and dc_approval_status cannot be matched/,
          'Must reproduce the exact COALESCE type error reported by user'
        );
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('2. Successful Save with approval_status = pending_approval for DO-26-0073', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupCorrectedRpc(client);
        await setAuthenticatedUser(client, adminId);

        const res = await client.query(`
          SELECT edit_delivery_challan(
            $1::uuid,
            $2::jsonb,
            $3::jsonb
          ) as result
        `, [
          'abda70d6-cede-4a14-bc47-1adea0729f6f',
          JSON.stringify([{
            id: 'baadf206-f75f-4109-89e3-2a20f836351f',
            product_id: 'f9ca763f-47c0-4bfa-b2a0-1905152458c6',
            batch_id: 'f767785c-1d74-4b03-b7be-1e6cd6b8282f',
            sales_order_item_id: '2a1def7d-a77f-4873-b2c9-aeefc26d6689',
            quantity: 20
          }]),
          JSON.stringify({
            customer_id: 'b8f9dc5e-2cdf-4527-8960-186bb2a30913',
            sales_order_id: '655fd213-ffb4-4b4c-95cb-acb10e5dbe0d',
            challan_date: '2026-10-27',
            delivery_address: 'Jl. Industri No. 1',
            approval_status: 'pending_approval'
          })
        ]);

        const result = res.rows[0].result;
        assert.equal(result.success, true, 'Save must succeed: ' + JSON.stringify(result));
        assert.equal(result.message, 'Delivery challan updated successfully');

        // Verify persisted state in DB
        const dcCheck = await client.query(`SELECT approval_status, delivery_address FROM delivery_challans WHERE id = 'abda70d6-cede-4a14-bc47-1adea0729f6f'`);
        assert.equal(dcCheck.rows[0].approval_status, 'pending_approval');
        assert.equal(dcCheck.rows[0].delivery_address, 'Jl. Industri No. 1');
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('3. Successful Save when header does NOT include approval_status', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupCorrectedRpc(client);
        await setAuthenticatedUser(client, adminId);

        const res = await client.query(`
          SELECT edit_delivery_challan(
            $1::uuid,
            $2::jsonb,
            $3::jsonb
          ) as result
        `, [
          'abda70d6-cede-4a14-bc47-1adea0729f6f',
          JSON.stringify([{
            id: 'baadf206-f75f-4109-89e3-2a20f836351f',
            product_id: 'f9ca763f-47c0-4bfa-b2a0-1905152458c6',
            batch_id: 'f767785c-1d74-4b03-b7be-1e6cd6b8282f',
            sales_order_item_id: '2a1def7d-a77f-4873-b2c9-aeefc26d6689',
            quantity: 20
          }]),
          JSON.stringify({
            delivery_address: 'Updated Warehouse Address'
          })
        ]);

        const result = res.rows[0].result;
        assert.equal(result.success, true);

        const dcCheck = await client.query(`SELECT approval_status, delivery_address FROM delivery_challans WHERE id = 'abda70d6-cede-4a14-bc47-1adea0729f6f'`);
        assert.equal(dcCheck.rows[0].delivery_address, 'Updated Warehouse Address');
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('4. Successful Save with empty or null optional fields', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupCorrectedRpc(client);
        await setAuthenticatedUser(client, adminId);

        const res = await client.query(`
          SELECT edit_delivery_challan(
            $1::uuid,
            $2::jsonb,
            $3::jsonb
          ) as result
        `, [
          'abda70d6-cede-4a14-bc47-1adea0729f6f',
          JSON.stringify([{
            id: 'baadf206-f75f-4109-89e3-2a20f836351f',
            product_id: 'f9ca763f-47c0-4bfa-b2a0-1905152458c6',
            batch_id: 'f767785c-1d74-4b03-b7be-1e6cd6b8282f',
            sales_order_item_id: '2a1def7d-a77f-4873-b2c9-aeefc26d6689',
            quantity: 20,
            pack_size: '',
            pack_type: '',
            number_of_packs: ''
          }]),
          JSON.stringify({
            vehicle_number: '',
            driver_name: '',
            notes: ''
          })
        ]);

        const result = res.rows[0].result;
        assert.equal(result.success, true);

        const dcCheck = await client.query(`SELECT vehicle_number, driver_name, notes FROM delivery_challans WHERE id = 'abda70d6-cede-4a14-bc47-1adea0729f6f'`);
        assert.equal(dcCheck.rows[0].vehicle_number, null);
        assert.equal(dcCheck.rows[0].driver_name, null);
        assert.equal(dcCheck.rows[0].notes, null);
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('5. Reject invalid approval status values (approved or arbitrary string)', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupCorrectedRpc(client);
        await setAuthenticatedUser(client, adminId);

        // Attempting approval_status = 'approved' directly via edit
        const resApproved = await client.query(`
          SELECT edit_delivery_challan(
            $1::uuid,
            $2::jsonb,
            $3::jsonb
          ) as result
        `, [
          'abda70d6-cede-4a14-bc47-1adea0729f6f',
          JSON.stringify([{
            product_id: 'f9ca763f-47c0-4bfa-b2a0-1905152458c6',
            batch_id: 'f767785c-1d74-4b03-b7be-1e6cd6b8282f',
            quantity: 20
          }]),
          JSON.stringify({ approval_status: 'approved' })
        ]);
        assert.equal(resApproved.rows[0].result.success, false);
        assert.match(resApproved.rows[0].result.error, /Invalid approval_status: approved/);

        // Attempting arbitrary invalid string
        const resGarbage = await client.query(`
          SELECT edit_delivery_challan(
            $1::uuid,
            $2::jsonb,
            $3::jsonb
          ) as result
        `, [
          'abda70d6-cede-4a14-bc47-1adea0729f6f',
          JSON.stringify([{
            product_id: 'f9ca763f-47c0-4bfa-b2a0-1905152458c6',
            batch_id: 'f767785c-1d74-4b03-b7be-1e6cd6b8282f',
            quantity: 20
          }]),
          JSON.stringify({ approval_status: 'arbitrary_status' })
        ]);
        assert.equal(resGarbage.rows[0].result.success, false);
        assert.match(resGarbage.rows[0].result.error, /Invalid approval_status: arbitrary_status/);
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('6. Reject quantities greater than Sales Order remaining deliverable quantity', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupCorrectedRpc(client);
        await setAuthenticatedUser(client, adminId);

        // SO-2026-0087 item has quantity 30 kg remaining. Entering 50 kg must be rejected with helpful message.
        const res = await client.query(`
          SELECT edit_delivery_challan(
            $1::uuid,
            $2::jsonb,
            $3::jsonb
          ) as result
        `, [
          'abda70d6-cede-4a14-bc47-1adea0729f6f',
          JSON.stringify([{
            id: 'baadf206-f75f-4109-89e3-2a20f836351f',
            product_id: 'f9ca763f-47c0-4bfa-b2a0-1905152458c6',
            batch_id: 'f767785c-1d74-4b03-b7be-1e6cd6b8282f',
            sales_order_item_id: '2a1def7d-a77f-4873-b2c9-aeefc26d6689',
            quantity: 50
          }]),
          JSON.stringify({
            sales_order_id: '655fd213-ffb4-4b4c-95cb-acb10e5dbe0d'
          })
        ]);

        const result = res.rows[0].result;
        assert.equal(result.success, false);
        assert.match(result.error, /Delivery quantity \(50\) exceeds remaining Sales Order quantity \(30/);
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('7. Reject modifications when parent Sales Order is cancelled or rejected', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupCorrectedRpc(client);
        await setAuthenticatedUser(client, adminId);

        // Set linked SO to cancelled
        await client.query(`UPDATE sales_orders SET status = 'cancelled' WHERE id = '655fd213-ffb4-4b4c-95cb-acb10e5dbe0d'`);

        const res = await client.query(`
          SELECT edit_delivery_challan(
            $1::uuid,
            $2::jsonb,
            $3::jsonb
          ) as result
        `, [
          'abda70d6-cede-4a14-bc47-1adea0729f6f',
          JSON.stringify([{
            id: 'baadf206-f75f-4109-89e3-2a20f836351f',
            product_id: 'f9ca763f-47c0-4bfa-b2a0-1905152458c6',
            batch_id: 'f767785c-1d74-4b03-b7be-1e6cd6b8282f',
            sales_order_item_id: '2a1def7d-a77f-4873-b2c9-aeefc26d6689',
            quantity: 20
          }]),
          JSON.stringify({
            sales_order_id: '655fd213-ffb4-4b4c-95cb-acb10e5dbe0d'
          })
        ]);

        const result = res.rows[0].result;
        assert.equal(result.success, false);
        assert.match(result.error, /linked Sales Order is cancelled/);
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('8. Cancelled invoices do not block legitimate recovery', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupCorrectedRpc(client);
        await setAuthenticatedUser(client, adminId);

        // In production, invoice SAPJ-26-072 is cancelled with [CANCELLED...] in notes.
        // Confirm it does NOT block saving DO-26-0073.
        const res = await client.query(`
          SELECT edit_delivery_challan(
            $1::uuid,
            $2::jsonb,
            $3::jsonb
          ) as result
        `, [
          'abda70d6-cede-4a14-bc47-1adea0729f6f',
          JSON.stringify([{
            id: 'baadf206-f75f-4109-89e3-2a20f836351f',
            product_id: 'f9ca763f-47c0-4bfa-b2a0-1905152458c6',
            batch_id: 'f767785c-1d74-4b03-b7be-1e6cd6b8282f',
            sales_order_item_id: '2a1def7d-a77f-4873-b2c9-aeefc26d6689',
            quantity: 20
          }]),
          JSON.stringify({
            approval_status: 'pending_approval'
          })
        ]);

        assert.equal(res.rows[0].result.success, true);
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('9. Active (uncancelled) invoice blocks unsafe changes', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupCorrectedRpc(client);
        await setAuthenticatedUser(client, adminId);

        // Temporarily clear cancellation note to simulate an active invoice
        await client.query(`
          UPDATE sales_invoices
          SET notes = 'Commercial active invoice'
          WHERE id = '9878345f-b286-4a0e-83fe-de487c95e94f'
        `);

        const res = await client.query(`
          SELECT edit_delivery_challan(
            $1::uuid,
            $2::jsonb,
            $3::jsonb
          ) as result
        `, [
          'abda70d6-cede-4a14-bc47-1adea0729f6f',
          JSON.stringify([{
            id: 'baadf206-f75f-4109-89e3-2a20f836351f',
            product_id: 'f9ca763f-47c0-4bfa-b2a0-1905152458c6',
            batch_id: 'f767785c-1d74-4b03-b7be-1e6cd6b8282f',
            quantity: 20
          }]),
          JSON.stringify({ delivery_address: 'New Address' })
        ]);

        assert.equal(res.rows[0].result.success, false);
        assert.match(res.rows[0].result.error, /Delivery Challan already invoiced by active invoice\(s\) SAPJ-26-072/);
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('10. Two-argument signature works seamlessly without ambiguity', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupCorrectedRpc(client);
        await setAuthenticatedUser(client, adminId);

        // Calling with 2 arguments
        const res = await client.query(`
          SELECT edit_delivery_challan(
            $1::uuid,
            $2::jsonb
          ) as result
        `, [
          'abda70d6-cede-4a14-bc47-1adea0729f6f',
          JSON.stringify([{
            id: 'baadf206-f75f-4109-89e3-2a20f836351f',
            product_id: 'f9ca763f-47c0-4bfa-b2a0-1905152458c6',
            batch_id: 'f767785c-1d74-4b03-b7be-1e6cd6b8282f',
            sales_order_item_id: '2a1def7d-a77f-4873-b2c9-aeefc26d6689',
            quantity: 20
          }])
        ]);

        assert.equal(res.rows[0].result.success, true);
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('11. Inventory and GL isolation: Save operation does NOT create inventory movements or journal entries', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupCorrectedRpc(client);
        await setAuthenticatedUser(client, adminId);

        const txCountBefore = await client.query(`SELECT count(*) FROM inventory_transactions WHERE reference_id = 'abda70d6-cede-4a14-bc47-1adea0729f6f'`);
        const jeCountBefore = await client.query(`SELECT count(*) FROM journal_entries WHERE description LIKE '%DO-26-0073%'`);

        // Execute save
        await client.query(`
          SELECT edit_delivery_challan(
            $1::uuid,
            $2::jsonb,
            $3::jsonb
          )
        `, [
          'abda70d6-cede-4a14-bc47-1adea0729f6f',
          JSON.stringify([{
            id: 'baadf206-f75f-4109-89e3-2a20f836351f',
            product_id: 'f9ca763f-47c0-4bfa-b2a0-1905152458c6',
            batch_id: 'f767785c-1d74-4b03-b7be-1e6cd6b8282f',
            sales_order_item_id: '2a1def7d-a77f-4873-b2c9-aeefc26d6689',
            quantity: 20
          }]),
          JSON.stringify({
            approval_status: 'pending_approval'
          })
        ]);

        const txCountAfter = await client.query(`SELECT count(*) FROM inventory_transactions WHERE reference_id = 'abda70d6-cede-4a14-bc47-1adea0729f6f'`);
        const jeCountAfter = await client.query(`SELECT count(*) FROM journal_entries WHERE description LIKE '%DO-26-0073%'`);

        assert.equal(Number(txCountAfter.rows[0].count), Number(txCountBefore.rows[0].count), 'Inventory movements must remain unchanged on save');
        assert.equal(Number(jeCountAfter.rows[0].count), Number(jeCountBefore.rows[0].count), 'Journal entries must remain unchanged on save');
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });
});
