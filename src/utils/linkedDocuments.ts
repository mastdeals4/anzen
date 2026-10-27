import { supabase } from '../lib/supabase';

export interface LinkedDocRef { id: string; number: string; type: 'so' | 'dc' | 'inv'; }

export interface LinkedDocsBySo { soId: string; sos: LinkedDocRef[]; dcs: LinkedDocRef[]; invs: LinkedDocRef[] }
export interface LinkedDocsByDc { dcId: string; sos: LinkedDocRef[]; dcs: LinkedDocRef[]; invs: LinkedDocRef[] }
export interface LinkedDocsByInv { invId: string; sos: LinkedDocRef[]; dcs: LinkedDocRef[]; invs: LinkedDocRef[] }

export async function fetchLinkedDocumentsBundle() {
  const [soRes, dcRes, invRes, invItemsRes, dcItemsRes] = await Promise.all([
    supabase.from('sales_orders').select('id, so_number'),
    supabase.from('delivery_challans').select('id, challan_number, sales_order_id'),
    supabase.from('sales_invoices').select('id, invoice_number, sales_order_id, linked_challan_ids'),
    supabase.from('sales_invoice_items').select('invoice_id, delivery_challan_item_id'),
    supabase.from('delivery_challan_items').select('id, challan_id')
  ]);
  if (soRes.error) throw soRes.error;
  if (dcRes.error) throw dcRes.error;
  if (invRes.error) throw invRes.error;
  if (invItemsRes.error) throw invItemsRes.error;
  if (dcItemsRes.error) throw dcItemsRes.error;

  const soById = new Map((soRes.data || []).map((s: any) => [s.id, s.so_number]));
  const dcById = new Map((dcRes.data || []).map((d: any) => [d.id, d]));
  const dcItemToDc = new Map((dcItemsRes.data || []).map((d: any) => [d.id, d.challan_id]));
  const dcToSoIds = new Map<string, Set<string>>();

  const addDcSoLink = (dcId: string, soId: string | null | undefined) => {
    if (!dcId || !soId) return;
    if (!dcToSoIds.has(dcId)) dcToSoIds.set(dcId, new Set());
    dcToSoIds.get(dcId)!.add(soId);
  };

  const invToDcIds = new Map<string, Set<string>>();
  (invRes.data || []).forEach((inv: any) => {
    invToDcIds.set(inv.id, new Set(inv.linked_challan_ids || []));
  });
  (invItemsRes.data || []).forEach((it: any) => {
    if (!it.delivery_challan_item_id) return;
    const dcId = dcItemToDc.get(it.delivery_challan_item_id);
    if (!dcId) return;
    if (!invToDcIds.has(it.invoice_id)) invToDcIds.set(it.invoice_id, new Set());
    invToDcIds.get(it.invoice_id)!.add(dcId);
  });

  (dcRes.data || []).forEach((dc: any) => {
    addDcSoLink(dc.id, dc.sales_order_id);
  });
  (invRes.data || []).forEach((inv: any) => {
    if (!inv.sales_order_id) return;
    (invToDcIds.get(inv.id) || new Set<string>()).forEach((dcId) => {
      addDcSoLink(dcId, inv.sales_order_id);
    });
  });

  const soMap = new Map<string, LinkedDocsBySo>();
  (soRes.data || []).forEach((so: any) => soMap.set(so.id, { soId: so.id, sos: [{ id: so.id, number: so.so_number, type: 'so' }], dcs: [], invs: [] }));

  const addDocOnce = (docs: LinkedDocRef[], doc: LinkedDocRef) => {
    if (!docs.some((existing) => existing.id === doc.id && existing.type === doc.type)) docs.push(doc);
  };

  (dcRes.data || []).forEach((dc: any) => {
    (dcToSoIds.get(dc.id) || new Set<string>()).forEach((soId) => {
      if (soMap.has(soId)) addDocOnce(soMap.get(soId)!.dcs, { id: dc.id, number: dc.challan_number, type: 'dc' });
    });
  });
  (invRes.data || []).forEach((inv: any) => {
    const addedToSos = new Set<string>();
    if (inv.sales_order_id && soMap.has(inv.sales_order_id)) {
      addDocOnce(soMap.get(inv.sales_order_id)!.invs, { id: inv.id, number: inv.invoice_number, type: 'inv' });
      addedToSos.add(inv.sales_order_id);
    }
    // Also link invoice to SO through its DCs
    const linkedDcIds = invToDcIds.get(inv.id);
    if (linkedDcIds) {
      linkedDcIds.forEach((dcId) => {
        const dc = dcById.get(dcId);
        if (dc?.sales_order_id && soMap.has(dc.sales_order_id) && !addedToSos.has(dc.sales_order_id)) {
          addDocOnce(soMap.get(dc.sales_order_id)!.invs, { id: inv.id, number: inv.invoice_number, type: 'inv' });
          addedToSos.add(dc.sales_order_id);
        }
        (dcToSoIds.get(dcId) || new Set<string>()).forEach((soId) => {
          if (soMap.has(soId) && !addedToSos.has(soId)) {
            addDocOnce(soMap.get(soId)!.invs, { id: inv.id, number: inv.invoice_number, type: 'inv' });
            addedToSos.add(soId);
          }
        });
      });
    }
  });

  const dcMap = new Map<string, LinkedDocsByDc>();
  (dcRes.data || []).forEach((dc: any) => {
    const invs: LinkedDocRef[] = [];
    (invRes.data || []).forEach((inv: any) => {
      if (invToDcIds.get(inv.id)?.has(dc.id)) invs.push({ id: inv.id, number: inv.invoice_number, type: 'inv' });
    });
    const sos = Array.from(dcToSoIds.get(dc.id) || [])
      .filter((soId) => soById.get(soId))
      .map((soId) => ({ id: soId, number: soById.get(soId)!, type: 'so' as const }));
    dcMap.set(dc.id, { dcId: dc.id, sos, dcs: [], invs });
  });

  const invMap = new Map<string, LinkedDocsByInv>();
  (invRes.data || []).forEach((inv: any) => {
    let sos: LinkedDocRef[] = [];
    if (inv.sales_order_id && soById.get(inv.sales_order_id)) {
      sos = [{ id: inv.sales_order_id, number: soById.get(inv.sales_order_id)!, type: 'so' as const }];
    } else {
      // Trace SO through linked DCs
      const linkedDcIds = invToDcIds.get(inv.id);
      if (linkedDcIds) {
        for (const dcId of linkedDcIds) {
          const dc = dcById.get(dcId);
          if (dc?.sales_order_id && soById.get(dc.sales_order_id)) {
            sos = [{ id: dc.sales_order_id, number: soById.get(dc.sales_order_id)!, type: 'so' as const }];
            break;
          }
        }
      }
    }
    const dcs = Array.from(invToDcIds.get(inv.id) || []).map((id) => ({ id, number: dcById.get(id)?.challan_number || id, type: 'dc' as const }));
    invMap.set(inv.id, { invId: inv.id, sos, dcs, invs: [] });
  });

  return { soMap, dcMap, invMap };
}
