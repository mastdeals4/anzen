/**
 * Shared unit-display helper.
 *
 * The authoritative inventory/base unit for any batch is derived from
 * `products.unit`.  The stored values in the DB are lowercase short forms
 * (see the Products page unit dropdown).
 *
 * This module provides a single canonical formatter so that every screen
 * renders units consistently.
 */

const UNIT_DISPLAY_MAP: Record<string, string> = {
  // Mass
  kg: 'KG',
  kilogram: 'KG',
  kilograms: 'KG',
  g: 'Gram',
  gram: 'Gram',
  grams: 'Gram',
  mg: 'mg',
  milligram: 'mg',
  milligrams: 'mg',
  ton: 'Ton',
  tons: 'Ton',
  tonne: 'Ton',
  tonnes: 'Ton',
  mt: 'MT',

  // Volume
  litre: 'Litre',
  liter: 'Litre',
  litres: 'Litre',
  liters: 'Litre',
  l: 'Litre',
  ml: 'mL',
  milliliter: 'mL',
  milliliters: 'mL',
  millilitre: 'mL',
  millilitres: 'mL',

  // Discrete
  piece: 'Pcs',
  pieces: 'Pcs',
  pcs: 'Pcs',
  pc: 'Pcs',
  unit: 'Pcs',
  units: 'Pcs',
  tablet: 'Tab',
  tablets: 'Tab',
  capsule: 'Cap',
  capsules: 'Cap',

  // Packaging
  bottle: 'Bottle',
  bottles: 'Bottle',
  box: 'Box',
  boxes: 'Box',
  bag: 'Bag',
  bags: 'Bag',
  drum: 'Drum',
  drums: 'Drum',
  pack: 'Pack',
  packs: 'Pack',
};

/**
 * Format a raw product unit string to its canonical display label.
 *
 * @example
 *   formatUnit('g')       // 'Gram'
 *   formatUnit('kg')      // 'KG'
 *   formatUnit('litre')   // 'Litre'
 *   formatUnit(undefined) // ''
 */
export function formatUnit(raw: string | null | undefined): string {
  if (!raw) return '';
  const key = raw.toLowerCase().trim();
  return UNIT_DISPLAY_MAP[key] ?? raw;
}

/**
 * Return the short abbreviated unit label for compact display contexts
 * (e.g. table cells, badges).
 *
 * @example
 *   abbreviateUnit('g')       // 'g'
 *   abbreviateUnit('kg')      // 'kg'
 *   abbreviateUnit('kilogram')// 'kg'
 *   abbreviateUnit('gram')    // 'g'
 */
const UNIT_ABBREV_MAP: Record<string, string> = {
  kg: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  g: 'g',
  gram: 'g',
  grams: 'g',
  mg: 'mg',
  milligram: 'mg',
  milligrams: 'mg',
  ton: 'ton',
  tons: 'ton',
  tonne: 'ton',
  tonnes: 'ton',
  mt: 'mt',
  litre: 'L',
  liter: 'L',
  litres: 'L',
  liters: 'L',
  l: 'L',
  ml: 'mL',
  milliliter: 'mL',
  milliliters: 'mL',
  millilitre: 'mL',
  millilitres: 'mL',
  piece: 'pcs',
  pieces: 'pcs',
  pcs: 'pcs',
  pc: 'pcs',
  unit: 'pcs',
  units: 'pcs',
  tablet: 'tab',
  tablets: 'tab',
  capsule: 'cap',
  capsules: 'cap',
  bottle: 'btl',
  bottles: 'btl',
  box: 'box',
  boxes: 'box',
  bag: 'bag',
  bags: 'bag',
  drum: 'drm',
  drums: 'drm',
  pack: 'pack',
  packs: 'pack',
};

export function abbreviateUnit(raw: string | null | undefined): string {
  if (!raw) return '';
  const key = raw.toLowerCase().trim();
  return UNIT_ABBREV_MAP[key] ?? raw;
}

/**
 * Formats or corrects packaging details string (e.g. "1 box x 250kg" -> "1 box x 250g")
 * when a historical batch record has a hardcoded unit that conflicts with the product's base unit.
 */
export function formatPackagingDetails(
  details: string | null | undefined,
  productUnit: string | null | undefined
): string {
  if (!details) return '';
  if (!productUnit) return details;
  const targetAbbr = abbreviateUnit(productUnit);
  if (targetAbbr === 'g') {
    return details.replace(/(\d+(?:\.\d+)?)\s*kg\b/gi, `$1${targetAbbr}`);
  }
  return details;
}

