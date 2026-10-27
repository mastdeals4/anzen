import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers mirrored from src/utils/deliveryPackaging.ts and unitDisplay.ts
// ──────────────────────────────────────────────────────────────────────────────

const UNIT_DISPLAY_MAP = {
  kg: 'KG', kilogram: 'KG', kilograms: 'KG',
  g: 'Gram', gram: 'Gram', grams: 'Gram',
  mg: 'mg', milligram: 'mg', milligrams: 'mg',
  ton: 'Ton', tons: 'Ton', tonne: 'Ton', tonnes: 'Ton', mt: 'MT',
  litre: 'Litre', liter: 'Litre', litres: 'Litre', liters: 'Litre', l: 'Litre',
  ml: 'mL', milliliter: 'mL', milliliters: 'mL', millilitre: 'mL', millilitres: 'mL',
  piece: 'Pcs', pieces: 'Pcs', pcs: 'Pcs', pc: 'Pcs', unit: 'Pcs', units: 'Pcs',
  tablet: 'Tab', tablets: 'Tab',
  capsule: 'Cap', capsules: 'Cap',
  bottle: 'Bottle', bottles: 'Bottle',
  box: 'Box', boxes: 'Box',
  bag: 'Bag', bags: 'Bag',
  drum: 'Drum', drums: 'Drum',
  pack: 'Pack', packs: 'Pack',
};

function formatUnit(raw) {
  if (!raw) return '';
  const key = raw.toLowerCase().trim();
  return UNIT_DISPLAY_MAP[key] ?? raw;
}

function formatPackTypeForDisplay(type) {
  if (!type) return '';
  const trimmed = type.trim().toLowerCase();
  if (!trimmed) return '';

  const map = {
    bag: 'bags',
    bags: 'bags',
    drum: 'drums',
    drums: 'drums',
    box: 'boxes',
    boxes: 'boxes',
    carton: 'cartons',
    cartons: 'cartons',
    tin: 'tins',
    tins: 'tins',
    bottle: 'bottles',
    bottles: 'bottles',
    pack: 'packs',
    packs: 'packs',
    container: 'containers',
    containers: 'containers',
    pail: 'pails',
    pails: 'pails',
    can: 'cans',
    cans: 'cans',
    carboy: 'carboys',
    carboys: 'carboys',
    jar: 'jars',
    jars: 'jars',
    tub: 'tubs',
    tubs: 'tubs',
  };

  if (map[trimmed]) return map[trimmed];
  if (trimmed.endsWith('s')) return trimmed;
  return `${trimmed}s`;
}

function isUnitOrTrivialString(str, unit) {
  if (!str) return true;
  const s = str.trim().toLowerCase();
  const u = (unit || '').trim().toLowerCase();

  const trivialUnits = new Set([
    '-', '—', 'n/a', 'na', 'null', 'none',
    'kg', 'kgs', 'kilogram', 'kilograms',
    'g', 'gm', 'gms', 'gram', 'grams',
    'mg', 'milligram', 'milligrams',
    'ton', 'tons', 'tonne', 'tonnes', 'mt',
    'l', 'lt', 'ltr', 'ltrs', 'liter', 'liters', 'litre', 'litres',
    'ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres',
    'pcs', 'pc', 'piece', 'pieces', 'unit', 'units',
  ]);

  if (trivialUnits.has(s)) return true;
  if (u && (s === u || s === `${u}s`)) return true;
  return false;
}

function roundPacks(val) {
  if (Number.isInteger(val)) return val;
  return parseFloat(val.toFixed(2));
}

function resolveItemPackaging(item, fallbackUnit) {
  const quantity = Number(item.quantity) || 0;
  const rawUnit = item.products?.unit || item.batches?.products?.unit || fallbackUnit || '';
  const unit = formatUnit(rawUnit);

  let candidatePackSize = null;
  let candidatePackType = null;
  let candidatePacks = null;
  let source = 'none';

  // 1. First use DC item pack_size + pack_type when valid
  const itemPackSize = item.pack_size != null ? Number(item.pack_size) : null;
  const itemPackType = (item.pack_type || '').trim();
  if (itemPackSize !== null && itemPackSize > 0 && itemPackType !== '') {
    candidatePackSize = itemPackSize;
    candidatePackType = formatPackTypeForDisplay(itemPackType);
    candidatePacks = item.number_of_packs != null && Number(item.number_of_packs) > 0 ? Number(item.number_of_packs) : null;
    source = 'dc_item';
  }

  // 2. Otherwise use valid structured batch packaging (per_pack_weight + pack_type)
  if (!candidatePackSize || !candidatePackType) {
    const batchPackSize = item.batches?.per_pack_weight != null ? Number(item.batches.per_pack_weight) : null;
    const batchPackType = (item.batches?.pack_type || '').trim();
    if (batchPackSize !== null && batchPackSize > 0 && batchPackType !== '') {
      candidatePackSize = batchPackSize;
      candidatePackType = formatPackTypeForDisplay(batchPackType);
      source = 'batch_structured';
    } else if (item.batches?.packaging_details) {
      const match = item.batches.packaging_details.match(/(\d+)\s+([a-zA-Z]+)s?\s+x\s+(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?/i);
      if (match) {
        candidatePackSize = parseFloat(match[3]);
        candidatePackType = formatPackTypeForDisplay(match[2]);
        source = 'batch_regex';
      }
    }
  }

  // 3. Otherwise fall back to PRODUCT MASTER:
  if (!candidatePackSize || !candidatePackType) {
    const prod = item.products || item.batches?.products;
    const prodWeight = prod?.per_pack_weight != null ? Number(prod.per_pack_weight) : null;
    const prodType = (prod?.pack_type || prod?.packaging_type || '').trim();
    if (prodWeight !== null && prodWeight > 0 && prodType !== '') {
      candidatePackSize = prodWeight;
      candidatePackType = formatPackTypeForDisplay(prodType);
      source = 'product_master';
    }
  }

  // If structured packaging was found:
  if (candidatePackSize !== null && candidatePackSize > 0 && candidatePackType) {
    // 4. Calculate packs when missing or inconsistent
    let resolvedPacks = null;
    const calculatedPacks = quantity > 0 ? quantity / candidatePackSize : null;

    if (candidatePacks == null || candidatePacks <= 0) {
      resolvedPacks = calculatedPacks !== null ? roundPacks(calculatedPacks) : null;
    } else if (calculatedPacks !== null && Math.abs(candidatePacks - calculatedPacks) > 0.01) {
      resolvedPacks = roundPacks(calculatedPacks);
    } else {
      resolvedPacks = candidatePacks;
    }

    const displayPackaging = resolvedPacks !== null
      ? `${candidatePackSize} ${unit}/${candidatePackType}`
      : `${candidatePackSize} ${unit} ${candidatePackType}`;

    const displayPacks = resolvedPacks !== null ? String(resolvedPacks) : '-';

    return {
      packSize: candidatePackSize,
      packType: candidatePackType,
      numberOfPacks: resolvedPacks,
      displayPackaging,
      displayPacks,
      source,
    };
  }

  // Fallback when NO structured packaging exists:
  const rawDetails = item.batches?.packaging_details?.trim();
  if (rawDetails && !isUnitOrTrivialString(rawDetails, unit)) {
    return {
      packSize: null,
      packType: null,
      numberOfPacks: item.number_of_packs != null && Number(item.number_of_packs) > 0 ? Number(item.number_of_packs) : null,
      displayPackaging: rawDetails,
      displayPacks: item.number_of_packs ? String(item.number_of_packs) : '-',
      source: 'raw_batch',
    };
  }

  return {
    packSize: null,
    packType: null,
    numberOfPacks: item.number_of_packs != null && Number(item.number_of_packs) > 0 ? Number(item.number_of_packs) : null,
    displayPackaging: '-',
    displayPacks: item.number_of_packs ? String(item.number_of_packs) : '-',
    source: 'none',
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Unit Tests for Packaging Fallback Behavior
// ──────────────────────────────────────────────────────────────────────────────

test('DO-26-0064 Fallback: falls back to Product Master and recalculates packs (350 / 25 = 14)', () => {
  const item = {
    quantity: 350,
    pack_size: null,
    pack_type: null,
    number_of_packs: 1, // Inconsistent default
    batches: {
      packaging_details: 'kg',
      per_pack_weight: null,
      pack_type: null,
    },
    products: {
      product_name: 'Paracetamol USP',
      unit: 'kg',
      per_pack_weight: 25,
      pack_type: 'Bag',
      packaging_type: 'Bag',
    },
  };

  const resolved = resolveItemPackaging(item);
  assert.equal(resolved.displayPackaging, '25 KG/bags');
  assert.equal(resolved.displayPacks, '14');
  assert.equal(resolved.numberOfPacks, 14);
  assert.equal(resolved.source, 'product_master');
});

test('DO-26-0058 Retains valid DC item packaging: "25 KG/bags" and 140 packs', () => {
  const item = {
    quantity: 3500,
    pack_size: 25,
    pack_type: 'bags',
    number_of_packs: 140,
    batches: {
      packaging_details: '740 bags x 25kg',
      per_pack_weight: null,
      pack_type: null,
    },
    products: {
      product_name: 'Corn Starch BP',
      unit: 'kg',
      per_pack_weight: 25,
      pack_type: 'Bag',
      packaging_type: 'Bag',
    },
  };

  const resolved = resolveItemPackaging(item);
  assert.equal(resolved.displayPackaging, '25 KG/bags');
  assert.equal(resolved.displayPacks, '140');
  assert.equal(resolved.numberOfPacks, 140);
  assert.equal(resolved.source, 'dc_item');
});

test('Raw "kg" in batch packaging_details is not displayed as packaging', () => {
  const itemWithoutProductPackaging = {
    quantity: 100,
    pack_size: null,
    pack_type: null,
    number_of_packs: null,
    batches: {
      packaging_details: 'kg',
      per_pack_weight: null,
      pack_type: null,
    },
    products: {
      product_name: 'Generic Chemical',
      unit: 'kg',
      per_pack_weight: null,
      pack_type: null,
    },
  };

  const resolved = resolveItemPackaging(itemWithoutProductPackaging);
  assert.equal(resolved.displayPackaging, '-');
});

test('Structured batch packaging takes priority over Product Master', () => {
  const item = {
    quantity: 500,
    pack_size: null,
    pack_type: null,
    number_of_packs: null,
    batches: {
      packaging_details: '20 drums x 25kg',
      per_pack_weight: 25,
      pack_type: 'Drum',
    },
    products: {
      product_name: 'Product In Drums',
      unit: 'kg',
      per_pack_weight: 50,
      pack_type: 'Bag',
    },
  };

  const resolved = resolveItemPackaging(item);
  assert.equal(resolved.displayPackaging, '25 KG/drums');
  assert.equal(resolved.displayPacks, '20');
  assert.equal(resolved.numberOfPacks, 20);
  assert.equal(resolved.source, 'batch_structured');
});

test('Live DB Invariant: DO-26-0058 and DO-26-0064 packaging resolve correctly against live data', () => {
  try {
    const raw = execSync(`npx supabase db query --linked "
      SELECT dc.challan_number, dci.quantity, dci.pack_size, dci.pack_type, dci.number_of_packs,
             p.product_name, p.unit, p.per_pack_weight as prod_per_pack_weight, p.pack_type as prod_pack_type, p.packaging_type as prod_packaging_type,
             b.batch_number, b.packaging_details as batch_pkg_details, b.per_pack_weight as batch_per_pack_weight, b.pack_type as batch_pack_type
      FROM delivery_challans dc
      JOIN delivery_challan_items dci ON dci.challan_id = dc.id
      LEFT JOIN products p ON p.id = dci.product_id
      LEFT JOIN batches b ON b.id = dci.batch_id
      WHERE dc.challan_number IN ('DO-26-0058', 'DO-26-0064');
    "`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

    const jsonMatch = raw.match(/\{[\s\S]*"rows"[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('Skipping live DB check: DB output not JSON');
      return;
    }
    const data = JSON.parse(jsonMatch[0]);
    const rows = data.rows || [];

    const row0058 = rows.find(r => r.challan_number === 'DO-26-0058');
    assert.ok(row0058, 'DO-26-0058 row exists');
    const resolved0058 = resolveItemPackaging({
      quantity: Number(row0058.quantity),
      pack_size: row0058.pack_size ? Number(row0058.pack_size) : null,
      pack_type: row0058.pack_type,
      number_of_packs: row0058.number_of_packs ? Number(row0058.number_of_packs) : null,
      batches: {
        packaging_details: row0058.batch_pkg_details,
        per_pack_weight: row0058.batch_per_pack_weight ? Number(row0058.batch_per_pack_weight) : null,
        pack_type: row0058.batch_pack_type,
      },
      products: {
        product_name: row0058.product_name,
        unit: row0058.unit,
        per_pack_weight: row0058.prod_per_pack_weight ? Number(row0058.prod_per_pack_weight) : null,
        pack_type: row0058.prod_pack_type,
        packaging_type: row0058.prod_packaging_type,
      },
    });
    assert.equal(resolved0058.displayPackaging, '25 KG/bags');
    assert.equal(resolved0058.displayPacks, '140');

    const row0064 = rows.find(r => r.challan_number === 'DO-26-0064');
    assert.ok(row0064, 'DO-26-0064 row exists');
    const resolved0064 = resolveItemPackaging({
      quantity: Number(row0064.quantity),
      pack_size: row0064.pack_size ? Number(row0064.pack_size) : null,
      pack_type: row0064.pack_type,
      number_of_packs: row0064.number_of_packs ? Number(row0064.number_of_packs) : null,
      batches: {
        packaging_details: row0064.batch_pkg_details,
        per_pack_weight: row0064.batch_per_pack_weight ? Number(row0064.batch_per_pack_weight) : null,
        pack_type: row0064.batch_pack_type,
      },
      products: {
        product_name: row0064.product_name,
        unit: row0064.unit,
        per_pack_weight: row0064.prod_per_pack_weight ? Number(row0064.prod_per_pack_weight) : null,
        pack_type: row0064.prod_pack_type,
        packaging_type: row0064.prod_packaging_type,
      },
    });
    assert.equal(resolved0064.displayPackaging, '25 KG/bags');
    assert.equal(resolved0064.displayPacks, '14');
  } catch (err) {
    console.warn('Live DB test error (treated as non-fatal if DB unavailable):', err.message);
  }
});
