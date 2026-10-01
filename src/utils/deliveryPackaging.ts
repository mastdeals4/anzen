import { formatUnit } from './unitDisplay';

export interface ChallanItemLike {
  id?: string;
  quantity: number;
  pack_size?: number | null;
  pack_type?: string | null;
  number_of_packs?: number | null;
  products?: {
    product_name?: string;
    product_code?: string;
    unit?: string;
    per_pack_weight?: number | null;
    pack_type?: string | null;
    packaging_type?: string | null;
  } | null;
  batches?: {
    batch_number?: string;
    expiry_date?: string | null;
    packaging_details?: string | null;
    per_pack_weight?: number | null;
    pack_type?: string | null;
    products?: {
      product_name?: string;
      product_code?: string;
      unit?: string;
      per_pack_weight?: number | null;
      pack_type?: string | null;
      packaging_type?: string | null;
    } | null;
  } | null;
}

export interface ResolvedItemPackaging {
  packSize: number | null;
  packType: string | null;
  numberOfPacks: number | null;
  displayPackaging: string;
  displayPacks: string;
  source: 'dc_item' | 'batch_structured' | 'batch_regex' | 'product_master' | 'raw_batch' | 'none';
}

/**
 * Normalizes packaging type strings to clean lowercase plurals (e.g. "Bag" -> "bags", "drum" -> "drums").
 */
export function formatPackTypeForDisplay(type: string | null | undefined): string {
  if (!type) return '';
  const trimmed = type.trim().toLowerCase();
  if (!trimmed) return '';

  const map: Record<string, string> = {
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

/**
 * Checks whether a raw packaging string is merely a unit name (e.g. "kg", "kgs")
 * or placeholder rather than an actual packaging description.
 */
export function isUnitOrTrivialString(str: string | null | undefined, unit?: string | null): boolean {
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

function roundPacks(val: number): number {
  if (Number.isInteger(val)) return val;
  return parseFloat(val.toFixed(2));
}

/**
 * Authoritative packaging and pack count resolver for Delivery Challans.
 *
 * Priority order:
 * 1. DC item pack_size + pack_type when valid.
 * 2. Structured batch packaging (batches.per_pack_weight + batches.pack_type) or parsed batch packaging_details.
 * 3. Product Master (products.per_pack_weight + products.pack_type / products.packaging_type).
 * 4. Calculates numberOfPacks = quantity / per_pack_weight when missing or inconsistent.
 * 5. Falls back to raw batches.packaging_details ONLY if not merely a unit like "kg".
 */
export function resolveItemPackaging(
  item: ChallanItemLike,
  fallbackUnit?: string
): ResolvedItemPackaging {
  const quantity = Number(item.quantity) || 0;
  const rawUnit = item.products?.unit || item.batches?.products?.unit || fallbackUnit || '';
  const unit = formatUnit(rawUnit);

  let candidatePackSize: number | null = null;
  let candidatePackType: string | null = null;
  let candidatePacks: number | null = null;
  let source: ResolvedItemPackaging['source'] = 'none';

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
      // Check if batch packaging_details has a structured pattern e.g. "40 bags x 25kg"
      const match = item.batches.packaging_details.match(/(\d+)\s+([a-zA-Z]+)s?\s+x\s+(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?/i);
      if (match) {
        candidatePackSize = parseFloat(match[3]);
        candidatePackType = formatPackTypeForDisplay(match[2]);
        source = 'batch_regex';
      }
    }
  }

  // 3. Otherwise fall back to PRODUCT MASTER:
  //    - products.per_pack_weight
  //    - products.pack_type / products.packaging_type
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

  // If structured packaging was found (from DC item, batch, or product master):
  if (candidatePackSize !== null && candidatePackSize > 0 && candidatePackType) {
    // 4. Calculate packs when missing or inconsistent:
    //    number_of_packs = quantity / per_pack_weight
    //    Example: 350 / 25 = 14
    let resolvedPacks: number | null = null;
    const calculatedPacks = quantity > 0 ? quantity / candidatePackSize : null;

    if (candidatePacks == null || candidatePacks <= 0) {
      resolvedPacks = calculatedPacks !== null ? roundPacks(calculatedPacks) : null;
    } else if (calculatedPacks !== null && Math.abs(candidatePacks - calculatedPacks) > 0.01) {
      // Inconsistent with quantity / pack_size
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
  // 6. Do NOT use a raw batches.packaging_details = "kg" as the final display
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
