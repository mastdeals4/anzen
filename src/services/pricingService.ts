export type FCLPackingType = 'mixed' | 'bags_25kg' | 'bags_50kg' | 'drums_25kg' | 'drums_50kg';
export type FreightType = 'percent' | 'usd_per_kg' | 'usd_per_container';
export type PurchaseCurrency = 'USD' | 'INR';

export interface FCLCapacity {
  mixed: number;
  bags_25kg: number;
  bags_50kg: number;
  drums_25kg: number;
  drums_50kg: number;
}

export interface PricingConfig {
  fcl: {
    '20ft': { clearance: number; capacity: FCLCapacity };
    '40ft': { clearance: number; capacity: FCLCapacity };
  };
  lcl: {
    min_chargeable: number;
    clearance_base: number;
    clearance_base_limit_cbm: number;
    clearance_additional_per_cbm: number;
    trucking_2t: number;
    trucking_4t: number;
    trucking_above_4t: number;
    generic_charge: number;
    packaging: {
      mixed: { weight: number; cbm: number };
      '25kg_drum': { weight: number; cbm: number };
      '50kg_drum': { weight: number; cbm: number };
      '25kg_bag': { weight: number; cbm: number };
      '50kg_bag': { weight: number; cbm: number };
    };
  };
  air: {
    clearance_base: number;
    clearance_min_weight: number;
    clearance_per_kg_after: number;
    trucking_500: number;
    trucking_above_500: number;
    generic_charge: number;
  };
  general: {
    fx_mode: 'auto' | 'manual';
    fx_buffer_percent: number;
    manual_fx_rate: number;
    inr_usd_mode: 'auto' | 'manual';
    inr_usd_manual_rate: number;
    inr_usd_buffer: number;
    inr_usd_cached_rate: number;
    inr_usd_cached_at: number;
  };
}

export interface FCLInput {
  purchase_currency: PurchaseCurrency;
  purchase_price: number;
  inr_price: number;
  india_margin_percent: number;
  indonesia_margin_percent: number;
  freight_type: FreightType;
  freight_value: number;
  insurance_percent: number;
  duty_percent: number;
  container_type: '20ft' | '40ft';
  packing_type: FCLPackingType;
  selling_quantity: number;
}

export type LCLPackingType = 'mixed' | '25kg_drum' | '50kg_drum' | '25kg_bag' | '50kg_bag';

export interface LCLInput {
  purchase_currency: PurchaseCurrency;
  purchase_price: number;
  inr_price: number;
  product_qty: number;
  total_shipment_qty: number;
  packing_type: LCLPackingType;
  india_margin_percent: number;
  indonesia_margin_percent: number;
  freight_type: FreightType;
  freight_value: number;
  insurance_percent: number;
  duty_percent: number;
  additional_cost_percent: number;
}

export interface AirInput {
  purchase_currency: PurchaseCurrency;
  purchase_price: number;
  inr_price: number;
  weight: number;
  india_margin_percent: number;
  indonesia_margin_percent: number;
  freight_type: FreightType;
  freight_value: number;
  insurance_percent: number;
  duty_percent: number;
}

export interface CalcResult {
  purchase_price_usd: number;
  inr_to_usd_rate: number;
  landed_cost_per_kg_usd: number;
  final_price_per_kg_usd: number;
  final_price_per_kg_idr: number;
  total_quote_usd: number;
  total_quote_idr: number;
  applied_fx_rate: number;
  breakdown: Record<string, number>;
  is_zero: boolean;
  zero_reason?: string;
}

let fxCache: { rate: number; ts: number } | null = null;
const CACHE_TTL = 60 * 60 * 1000;

async function fetchLiveIDR(): Promise<number> {
  try {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
    const data = await res.json();
    const rate = data?.rates?.IDR;
    if (typeof rate === 'number' && rate > 0) return rate;
    throw new Error('No IDR rate');
  } catch {
    return 16000;
  }
}

export async function applyFX(config: PricingConfig): Promise<number> {
  if (config.general.fx_mode === 'manual') {
    const r = config.general.manual_fx_rate || 16000;
    return Math.ceil(r / 10) * 10;
  }

  const now = Date.now();
  if (fxCache && now - fxCache.ts < CACHE_TTL) {
    return fxCache.rate;
  }

  const live = await fetchLiveIDR();
  const buffered = live * (1 + config.general.fx_buffer_percent / 100);
  const final = Math.ceil(buffered / 10) * 10;
  fxCache = { rate: final, ts: now };
  return final;
}

export function getEffectiveINRRate(config: PricingConfig): number {
  const MIN_RATE = 1;

  if (config.general.inr_usd_mode === 'manual') {
    return Math.max(MIN_RATE, config.general.inr_usd_manual_rate || 91);
  }

  const cached = config.general.inr_usd_cached_rate || 0;
  const buffer = config.general.inr_usd_buffer || 0;
  const calculated = cached > 0 ? cached - buffer : (config.general.inr_usd_manual_rate || 91) - buffer;

  return Math.max(MIN_RATE, calculated);
}

export async function fetchLiveINRRate(): Promise<number> {
  const APIS = [
    async () => {
      const res = await fetch('https://open.er-api.com/v6/latest/USD');
      const data = await res.json();
      const rate = data?.rates?.INR;
      if (typeof rate === 'number' && rate > 0) return rate;
      throw new Error('No INR rate');
    },
    async () => {
      const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
      const data = await res.json();
      const rate = data?.rates?.INR;
      if (typeof rate === 'number' && rate > 0) return rate;
      throw new Error('No INR rate');
    },
    async () => {
      const res = await fetch('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json');
      const data = await res.json();
      const rate = data?.usd?.inr;
      if (typeof rate === 'number' && rate > 0) return rate;
      throw new Error('No INR rate');
    },
  ];

  for (const api of APIS) {
    try {
      return await api();
    } catch {
      continue;
    }
  }
  return 84;
}

function getFreightCost(freightType: FreightType, freightValue: number, productValue: number, qty: number): number {
  if (freightType === 'percent') return productValue * freightValue / 100;
  if (freightType === 'usd_per_kg') return freightValue * qty;
  if (freightType === 'usd_per_container') return freightValue;
  return 0;
}

function zeroResult(fxRate: number, reason: string): CalcResult {
  return {
    purchase_price_usd: 0,
    inr_to_usd_rate: 0,
    landed_cost_per_kg_usd: 0,
    final_price_per_kg_usd: 0,
    final_price_per_kg_idr: 0,
    total_quote_usd: 0,
    total_quote_idr: 0,
    applied_fx_rate: fxRate,
    breakdown: {},
    is_zero: true,
    zero_reason: reason,
  };
}

export function calculateFCL(input: FCLInput, config: PricingConfig, fxRate: number): CalcResult {
  const inrRate = getEffectiveINRRate(config);

  let purchase_price_usd = input.purchase_price;
  if (input.purchase_currency === 'INR') {
    if (!input.inr_price || input.inr_price <= 0) {
      return zeroResult(fxRate, 'Enter INR purchase price');
    }
    if (!inrRate || inrRate <= 0) {
      return zeroResult(fxRate, 'Configure INR/USD rate in Settings');
    }
    purchase_price_usd = input.inr_price / inrRate;
  } else if (!input.purchase_price || input.purchase_price <= 0) {
    return zeroResult(fxRate, 'Enter purchase price');
  }

  if (!input.selling_quantity || input.selling_quantity <= 0) {
    return zeroResult(fxRate, 'Enter selling quantity (kg)');
  }

  const capacity = config.fcl[input.container_type]?.capacity?.[input.packing_type] ?? 0;
  if (!capacity || capacity <= 0) {
    return zeroResult(fxRate, `Capacity not set for ${input.container_type} + ${input.packing_type} — configure in Settings`);
  }

  const loaded_qty = capacity;

  const full_product_value = purchase_price_usd * loaded_qty;
  const india_margin = full_product_value * input.india_margin_percent / 100;
  const freight = getFreightCost(input.freight_type, input.freight_value, full_product_value, loaded_qty);
  const insurance = full_product_value * input.insurance_percent / 100;
  const subtotal = full_product_value + india_margin + freight + insurance;
  const duties = subtotal * input.duty_percent / 100;
  const clearance = config.fcl[input.container_type].clearance;

  const total_landed = subtotal + duties + clearance;
  const landed_per_kg = total_landed / loaded_qty;
  const final_price_per_kg = landed_per_kg * (1 + input.indonesia_margin_percent / 100);
  const total_quote = final_price_per_kg * input.selling_quantity;

  return {
    purchase_price_usd,
    inr_to_usd_rate: input.purchase_currency === 'INR' ? inrRate : 0,
    landed_cost_per_kg_usd: landed_per_kg,
    final_price_per_kg_usd: final_price_per_kg,
    final_price_per_kg_idr: final_price_per_kg * fxRate,
    total_quote_usd: total_quote,
    total_quote_idr: total_quote * fxRate,
    applied_fx_rate: fxRate,
    breakdown: {
      capacity_kg: capacity,
      loaded_qty,
      purchase_price_usd,
      full_product_value,
      india_margin,
      freight,
      insurance,
      subtotal,
      duties,
      clearance,
      total_landed,
      landed_per_kg,
    },
    is_zero: false,
  };
}

export function calculateLCL(input: LCLInput, config: PricingConfig, fxRate: number): CalcResult {
  const inrRate = getEffectiveINRRate(config);

  let purchase_price_usd = input.purchase_price;
  if (input.purchase_currency === 'INR') {
    if (!input.inr_price || input.inr_price <= 0) {
      return zeroResult(fxRate, 'Enter INR purchase price');
    }
    if (!inrRate || inrRate <= 0) {
      return zeroResult(fxRate, 'Configure INR/USD rate in Settings');
    }
    purchase_price_usd = input.inr_price / inrRate;
  } else if (!input.purchase_price || input.purchase_price <= 0) {
    return zeroResult(fxRate, 'Enter purchase price (USD/kg)');
  }

  if (!input.total_shipment_qty || input.total_shipment_qty <= 0) {
    return zeroResult(fxRate, 'Enter total shipment quantity (kg)');
  }
  if (!input.product_qty || input.product_qty <= 0) {
    return zeroResult(fxRate, 'Enter product quantity (kg)');
  }
  if (input.product_qty > input.total_shipment_qty) {
    return zeroResult(fxRate, 'Product qty cannot exceed total shipment qty');
  }

  const pkg = config.lcl.packaging[input.packing_type];
  if (!pkg || !pkg.weight || pkg.weight <= 0) {
    return zeroResult(fxRate, 'Packaging config missing — check Settings');
  }

  const shipment_units = Math.ceil(input.total_shipment_qty / pkg.weight);
  const shipment_cbm = shipment_units * pkg.cbm;
  const chargeable_cbm = Math.max(shipment_cbm, config.lcl.min_chargeable);

  const base_limit = config.lcl.clearance_base_limit_cbm || 5;
  const clearance =
    chargeable_cbm <= base_limit
      ? config.lcl.clearance_base
      : config.lcl.clearance_base + (chargeable_cbm - base_limit) * config.lcl.clearance_additional_per_cbm;

  const shipment_ton = input.total_shipment_qty / 1000;
  const trucking =
    shipment_ton <= 2
      ? config.lcl.trucking_2t
      : shipment_ton <= 4
        ? config.lcl.trucking_4t
        : config.lcl.trucking_above_4t;

  const generic_charge = config.lcl.generic_charge || 0;

  const allocation_ratio = input.product_qty / input.total_shipment_qty;
  const allocated_clearance = clearance * allocation_ratio;
  const allocated_trucking = trucking * allocation_ratio;
  const allocated_generic = generic_charge * allocation_ratio;

  const product_value = purchase_price_usd * input.product_qty;
  const india_margin = product_value * input.india_margin_percent / 100;
  const freight = getFreightCost(input.freight_type, input.freight_value, product_value, input.product_qty);
  const insurance = product_value * input.insurance_percent / 100;

  let subtotal = product_value + freight + india_margin + insurance
    + allocated_clearance + allocated_trucking + allocated_generic;

  const additional_cost = subtotal * input.additional_cost_percent / 100;
  subtotal += additional_cost;

  const duties = subtotal * input.duty_percent / 100;

  const total_landed = subtotal + duties;
  const landed_per_kg = total_landed / input.product_qty;
  const final_price_per_kg = landed_per_kg * (1 + input.indonesia_margin_percent / 100);
  const total_quote = final_price_per_kg * input.product_qty;

  return {
    purchase_price_usd,
    inr_to_usd_rate: input.purchase_currency === 'INR' ? inrRate : 0,
    landed_cost_per_kg_usd: landed_per_kg,
    final_price_per_kg_usd: final_price_per_kg,
    final_price_per_kg_idr: final_price_per_kg * fxRate,
    total_quote_usd: total_quote,
    total_quote_idr: total_quote * fxRate,
    applied_fx_rate: fxRate,
    breakdown: {
      product_qty: input.product_qty,
      total_shipment_qty: input.total_shipment_qty,
      shipment_units,
      shipment_cbm,
      chargeable_cbm,
      shipment_tons: shipment_ton,
      allocation_ratio,
      purchase_price_usd,
      product_value,
      india_margin,
      freight,
      insurance,
      clearance_full: clearance,
      allocated_clearance,
      trucking_full: trucking,
      allocated_trucking,
      generic_full: generic_charge,
      allocated_generic,
      additional_cost,
      subtotal,
      duties,
      total_landed,
      landed_per_kg,
    },
    is_zero: false,
  };
}

export function calculateAir(input: AirInput, config: PricingConfig, fxRate: number): CalcResult {
  const inrRate = getEffectiveINRRate(config);

  let purchase_price_usd = input.purchase_price;
  if (input.purchase_currency === 'INR') {
    if (!input.inr_price || input.inr_price <= 0) {
      return zeroResult(fxRate, 'Enter INR purchase price');
    }
    if (!inrRate || inrRate <= 0) {
      return zeroResult(fxRate, 'Configure INR/USD rate in Settings');
    }
    purchase_price_usd = input.inr_price / inrRate;
  } else if (!input.purchase_price || input.purchase_price <= 0) {
    return zeroResult(fxRate, 'Enter purchase price');
  }

  if (!input.weight || input.weight <= 0) {
    return zeroResult(fxRate, 'Enter shipment weight (kg)');
  }

  const clearance_min_weight = config.air.clearance_min_weight || 100;
  const clearance =
    input.weight <= clearance_min_weight
      ? config.air.clearance_base
      : config.air.clearance_base + (input.weight - clearance_min_weight) * config.air.clearance_per_kg_after;

  const trucking =
    input.weight <= 500
      ? config.air.trucking_500
      : config.air.trucking_above_500;

  const generic_charge = config.air.generic_charge || 0;

  const product_value = purchase_price_usd * input.weight;
  const india_margin = product_value * input.india_margin_percent / 100;
  const freight = getFreightCost(input.freight_type, input.freight_value, product_value, input.weight);
  const insurance = product_value * input.insurance_percent / 100;

  const total_fixed_charges = clearance + trucking + generic_charge;
  const subtotal = product_value + india_margin + freight + total_fixed_charges + insurance;
  const duties = subtotal * input.duty_percent / 100;

  const total_landed = subtotal + duties;
  const landed_per_kg = total_landed / input.weight;
  const final_price_per_kg = landed_per_kg * (1 + input.indonesia_margin_percent / 100);
  const total_quote = final_price_per_kg * input.weight;

  return {
    purchase_price_usd,
    inr_to_usd_rate: input.purchase_currency === 'INR' ? inrRate : 0,
    landed_cost_per_kg_usd: landed_per_kg,
    final_price_per_kg_usd: final_price_per_kg,
    final_price_per_kg_idr: final_price_per_kg * fxRate,
    total_quote_usd: total_quote,
    total_quote_idr: total_quote * fxRate,
    applied_fx_rate: fxRate,
    breakdown: {
      purchase_price_usd,
      product_value,
      india_margin,
      freight,
      clearance,
      trucking,
      generic_charge,
      insurance,
      subtotal,
      duties,
      total_landed,
      landed_per_kg,
    },
    is_zero: false,
  };
}

export const FCL_PACKING_OPTIONS: { value: FCLPackingType; label: string; unit_weight: number }[] = [
  { value: 'mixed', label: 'Mixed Container', unit_weight: 25 },
  { value: 'bags_25kg', label: 'All 25kg Bags', unit_weight: 25 },
  { value: 'bags_50kg', label: 'All 50kg Bags', unit_weight: 50 },
  { value: 'drums_25kg', label: 'All 25kg Drums', unit_weight: 25 },
  { value: 'drums_50kg', label: 'All 50kg Drums', unit_weight: 50 },
];

export const LCL_PACKING_OPTIONS: { value: LCLPackingType; label: string }[] = [
  { value: 'mixed', label: 'Mixed Lot' },
  { value: '25kg_drum', label: '25kg Drum' },
  { value: '50kg_drum', label: '50kg Drum' },
  { value: '25kg_bag', label: '25kg Bag' },
  { value: '50kg_bag', label: '50kg Bag' },
];
