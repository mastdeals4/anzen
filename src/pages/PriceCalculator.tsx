import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { Layout } from '../components/Layout';
import {
  Calculator, Settings as SettingsIcon, DollarSign,
  ChevronDown, ChevronUp, Info, AlertTriangle, RefreshCw, TrendingDown, Database,
} from 'lucide-react';
import { ImportInfo } from '../components/ImportInfo';
import { MoneyInput } from '../components/MoneyInput';
import {
  PricingConfig, FCLPackingType, FCLCapacity, CalcResult, LCLPackingType,
  FreightType, PurchaseCurrency,
  applyFX, calculateFCL, calculateLCL, calculateAir, FCL_PACKING_OPTIONS, LCL_PACKING_OPTIONS,
  getEffectiveINRRate, fetchLiveINRRate,
} from '../services/pricingService';
import { usdToWords, idrToWords } from '../utils/numberToWords';

const DEFAULT_FCL_CAPACITY: FCLCapacity = {
  mixed: 12000,
  bags_25kg: 19000,
  bags_50kg: 19000,
  drums_25kg: 7500,
  drums_50kg: 10000,
};

const DEFAULT_CONFIG: PricingConfig = {
  fcl: {
    '20ft': { clearance: 500, capacity: { ...DEFAULT_FCL_CAPACITY } },
    '40ft': { clearance: 800, capacity: { mixed: 25000, bags_25kg: 26000, bags_50kg: 26000, drums_25kg: 15000, drums_50kg: 20000 } },
  },
  lcl: {
    min_chargeable: 1,
    clearance_base: 250,
    clearance_base_limit_cbm: 5,
    clearance_additional_per_cbm: 30,
    trucking_2t: 150,
    trucking_4t: 250,
    trucking_above_4t: 350,
    generic_charge: 500,
    packaging: {
      mixed: { weight: 25, cbm: 0.032 },
      '25kg_drum': { weight: 25, cbm: 0.035 },
      '50kg_drum': { weight: 50, cbm: 0.060 },
      '25kg_bag': { weight: 25, cbm: 0.028 },
      '50kg_bag': { weight: 50, cbm: 0.055 },
    },
  },
  air: {
    clearance_base: 350,
    clearance_min_weight: 100,
    clearance_per_kg_after: 3.5,
    trucking_500: 150,
    trucking_above_500: 250,
    generic_charge: 500,
  },
  general: {
    fx_mode: 'auto',
    fx_buffer_percent: 1,
    manual_fx_rate: 16000,
    inr_usd_mode: 'manual',
    inr_usd_manual_rate: 91,
    inr_usd_buffer: 1,
    inr_usd_cached_rate: 0,
    inr_usd_cached_at: 0,
  },
};

function loadSavedInputs() {
  try {
    const raw = localStorage.getItem('pc_inputs_v3');
    if (raw) return JSON.parse(raw);
  } catch { /* Ignore malformed or unavailable local storage. */ }
  return {
    fcl: {
      purchase_currency: 'USD' as PurchaseCurrency,
      purchase_price: '', inr_price: '',
      india_margin_percent: '', indonesia_margin_percent: '',
      freight_type: 'usd_per_kg' as FreightType, freight_value: '0.05',
      insurance_percent: '', duty_percent: '4',
      container_type: '20ft', packing_type: 'bags_25kg' as FCLPackingType,
      selling_quantity: '',
      apply_insurance: false,
    },
    lcl: {
      purchase_currency: 'USD' as PurchaseCurrency,
      purchase_price: '', inr_price: '',
      product_qty: '', total_shipment_qty: '',
      packing_type: 'mixed' as LCLPackingType,
      india_margin_percent: '', indonesia_margin_percent: '',
      freight_type: 'usd_per_kg' as FreightType, freight_value: '0.05',
      insurance_percent: '', duty_percent: '4',
      additional_cost_percent: '', apply_insurance: false,
    },
    air: {
      purchase_currency: 'USD' as PurchaseCurrency,
      purchase_price: '', inr_price: '', weight: '',
      india_margin_percent: '', indonesia_margin_percent: '',
      freight_type: 'usd_per_kg' as FreightType, freight_value: '0.05',
      insurance_percent: '', duty_percent: '4',
      apply_insurance: false,
    },
  };
}

function num(v: string | number): number {
  const n = typeof v === 'number' ? v : parseFloat(v as string);
  return isNaN(n) ? 0 : n;
}
function fmt2(v: number): string { return v.toFixed(2); }
function fmt4(v: number): string { return v.toFixed(4); }
function fmtIDR(v: number): string { return v.toLocaleString('id-ID', { maximumFractionDigits: 0 }); }
function fmtCbm(v: number): string { return v.toFixed(3); }

const inputCls = 'w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white';
const labelCls = 'block text-xs font-medium text-gray-500 mb-1';

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col">
      <label className={labelCls}>{label}</label>
      {children}
      {hint && <span className="text-[10px] text-orange-500 mt-0.5 h-3 leading-tight">{hint}</span>}
      {!hint && <span className="h-3" />}
    </div>
  );
}

function PctField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col">
      <label className={labelCls}>{label}</label>
      <div className="flex items-center">
        <input
          type="number" step="any" min="0"
          className="w-full px-2.5 py-1.5 border border-gray-300 rounded-l-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0"
        />
        <span className="px-2 py-1.5 border border-l-0 border-gray-300 rounded-r-md text-xs text-gray-500 bg-gray-50 whitespace-nowrap">%</span>
      </div>
      <span className="h-3" />
    </div>
  );
}

function WordsRow({ text }: { text: string }) {
  if (!text) return null;
  return <div className="text-[10px] text-gray-400 mt-0.5 leading-tight italic">{text}</div>;
}

function InsuranceField({ section, inputs, setInput }: { section: string; inputs: any; setInput: (s: string, f: string, v: any) => void }) {
  const applyIns = inputs[section].apply_insurance !== false;
  return (
    <div className="flex flex-col">
      <label className={labelCls}>Insurance</label>
      <div className="flex items-center gap-2 h-[34px]">
        <button
          type="button"
          onClick={() => setInput(section, 'apply_insurance', !applyIns)}
          className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none ${applyIns ? 'bg-blue-600' : 'bg-gray-300'}`}
        >
          <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${applyIns ? 'translate-x-4' : 'translate-x-0'}`} />
        </button>
        {applyIns ? (
          <div className="flex items-center flex-1">
            <input
              type="number" step="any" min="0"
              className="w-full px-2 py-1.5 border border-gray-300 rounded-l-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
              value={inputs[section].insurance_percent}
              onChange={(e) => setInput(section, 'insurance_percent', e.target.value)}
              placeholder="0"
            />
            <span className="px-2 py-1.5 border border-l-0 border-gray-300 rounded-r-md text-xs text-gray-500 bg-gray-50">%</span>
          </div>
        ) : (
          <span className="text-xs text-gray-400">Off</span>
        )}
      </div>
      <span className="h-3" />
    </div>
  );
}

function FreightField({ section, inputs, setInput, mode }: { section: string; inputs: any; setInput: (s: string, f: string, v: any) => void; mode: 'fcl' | 'lcl' | 'air' }) {
  const freightType: FreightType = inputs[section].freight_type || 'usd_per_kg';
  const freightValue: string = inputs[section].freight_value ?? '0.05';
  const unitLabel = freightType === 'percent' ? '%' : freightType === 'usd_per_kg' ? '$/kg' : '$/cont';
  const placeholder = freightType === 'percent' ? '0' : freightType === 'usd_per_kg' ? '0.05' : '0';

  return (
    <div className="flex flex-col">
      <label className={labelCls}>Freight</label>
      <div className="flex">
        <select
          className="px-2 py-1.5 border border-gray-300 rounded-l-md text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white flex-shrink-0"
          value={freightType}
          onChange={(e) => setInput(section, 'freight_type', e.target.value)}
        >
          <option value="usd_per_kg">$/kg</option>
          <option value="percent">%</option>
          {mode === 'fcl' && <option value="usd_per_container">$/cont</option>}
        </select>
        {freightType === 'percent' ? (
          <input
            type="number" step="any" min="0"
            className="w-full px-2 py-1.5 border border-l-0 border-r-0 border-gray-300 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
            value={freightValue}
            onChange={(e) => setInput(section, 'freight_value', e.target.value)}
            placeholder={placeholder}
          />
        ) : (
          <MoneyInput
            min={0}
            value={num(freightValue)}
            onChange={(amount) => setInput(section, 'freight_value', amount)}
            minimumFractionDigits={2}
            maximumFractionDigits={4}
            className="w-full px-2 py-1.5 border border-l-0 border-r-0 border-gray-300 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
            placeholder={placeholder}
          />
        )}
        <span className="px-2 py-1.5 border border-gray-300 rounded-r-md text-xs text-gray-500 bg-gray-50 whitespace-nowrap flex-shrink-0">{unitLabel}</span>
      </div>
      <span className="h-3" />
    </div>
  );
}

function PurchasePriceField({ section, inputs, setInput, inrRate }: {
  section: string; inputs: any;
  setInput: (s: string, f: string, v: any) => void;
  inrRate: number;
}) {
  const currency: PurchaseCurrency = inputs[section].purchase_currency || 'USD';
  const isINR = currency === 'INR';
  const inrPrice = num(inputs[section].inr_price);
  const derivedUSD = isINR && inrRate > 0 && inrPrice > 0 ? inrPrice / inrRate : 0;

  return (
    <div className="flex flex-col">
      <label className={labelCls}>Purchase Price</label>
      <div className="flex">
        <div className="flex border border-gray-300 rounded-l-md overflow-hidden flex-shrink-0">
          {(['USD', 'INR'] as PurchaseCurrency[]).map(c => (
            <button key={c} type="button"
              onClick={() => setInput(section, 'purchase_currency', c)}
              className={`px-2 py-1.5 text-xs font-semibold transition-colors ${currency === c ? 'bg-blue-600 text-white' : 'bg-gray-50 text-gray-500 hover:bg-gray-100'}`}>
              {c}
            </button>
          ))}
        </div>
        {!isINR ? (
          <>
            <span className="px-2 py-1.5 border-t border-b border-gray-300 text-xs text-gray-400 bg-gray-50 flex-shrink-0">$</span>
            <MoneyInput min={0}
              className="w-full px-2 py-1.5 border border-l-0 border-gray-300 rounded-r-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
              value={num(inputs[section].purchase_price)}
              onChange={(amount) => setInput(section, 'purchase_price', amount)}
              maximumFractionDigits={4}
              placeholder="0.00" />
          </>
        ) : (
          <>
            <span className="px-2 py-1.5 border-t border-b border-gray-300 text-xs bg-orange-50 text-orange-500 flex-shrink-0">₹</span>
            <MoneyInput min={0}
              className="w-full px-2 py-1.5 border border-l-0 border-gray-300 rounded-r-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
              value={num(inputs[section].inr_price)}
              onChange={(amount) => setInput(section, 'inr_price', amount)}
              maximumFractionDigits={4}
              placeholder="INR/kg" />
          </>
        )}
      </div>
      {isINR && derivedUSD > 0 ? (
        <span className="text-[10px] text-orange-500 mt-0.5 h-3 leading-tight">= ${fmt4(derivedUSD)}/kg @ ₹{inrRate}/$</span>
      ) : isINR && inrRate <= 0 ? (
        <span className="text-[10px] text-red-500 mt-0.5 h-3 leading-tight">Set INR/USD rate in Settings</span>
      ) : (
        <span className="h-3" />
      )}
    </div>
  );
}

export function PriceCalculator() {
  const [activeTab, setActiveTab] = useState<'calculator' | 'settings' | 'import_info'>('calculator');
  const [mode, setMode] = useState<'fcl' | 'lcl' | 'air'>('fcl');
  const [inputs, setInputs] = useState<any>(loadSavedInputs);
  const [config, setConfig] = useState<PricingConfig>(DEFAULT_CONFIG);
  const [configId, setConfigId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<CalcResult | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [showAssumptions, setShowAssumptions] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [fetchingINR, setFetchingINR] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase.from('pricing_settings').select('*').maybeSingle();
        let merged: PricingConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
        if (data) {
          const raw = data.config as any;
          if (raw.general) Object.assign(merged.general, raw.general);
          if (raw.fcl) {
            for (const ct of ['20ft', '40ft'] as const) {
              if (raw.fcl[ct]) {
                merged.fcl[ct].clearance = raw.fcl[ct].clearance ?? merged.fcl[ct].clearance;
                if (raw.fcl[ct].capacity) Object.assign(merged.fcl[ct].capacity, raw.fcl[ct].capacity);
              }
            }
          }
          if (raw.lcl) {
            const savedPkg = raw.lcl.packaging;
            Object.assign(merged.lcl, raw.lcl);
            merged.lcl.packaging = { ...DEFAULT_CONFIG.lcl.packaging };
            if (savedPkg) {
              for (const pk of Object.keys(savedPkg)) {
                if (merged.lcl.packaging[pk as keyof typeof merged.lcl.packaging]) {
                  Object.assign(merged.lcl.packaging[pk as keyof typeof merged.lcl.packaging], savedPkg[pk]);
                } else {
                  (merged.lcl.packaging as any)[pk] = savedPkg[pk];
                }
              }
            }
          }
          if (raw.air) Object.assign(merged.air, raw.air);
          setConfigId(data.id);
        }

        const staleMs = 4 * 60 * 60 * 1000;
        const cachedAt = merged.general.inr_usd_cached_at || 0;
        const isStale = Date.now() - cachedAt > staleMs;
        if (merged.general.inr_usd_mode === 'auto' && isStale) {
          try {
            const live = await fetchLiveINRRate();
            merged = JSON.parse(JSON.stringify(merged));
            merged.general.inr_usd_cached_rate = live;
            merged.general.inr_usd_cached_at = Date.now();
          } catch { /* Continue with the last cached exchange rate. */ }
        }

        setConfig(merged);
      } catch (e) { console.error('Failed to load pricing config', e); }
      finally { setLoading(false); }
    })();
  }, []);

  const runCalculation = useCallback(async (ci: any, cc: PricingConfig, cm: string) => {
    setCalculating(true);
    try {
      const fxRate = await applyFX(cc);
      let res: CalcResult;
      if (cm === 'fcl') {
        res = calculateFCL({
          purchase_currency: ci.fcl.purchase_currency || 'USD',
          purchase_price: num(ci.fcl.purchase_price),
          inr_price: num(ci.fcl.inr_price),
          india_margin_percent: num(ci.fcl.india_margin_percent),
          indonesia_margin_percent: num(ci.fcl.indonesia_margin_percent),
          freight_type: ci.fcl.freight_type || 'usd_per_kg',
          freight_value: num(ci.fcl.freight_value),
          insurance_percent: ci.fcl.apply_insurance !== false ? num(ci.fcl.insurance_percent) : 0,
          duty_percent: num(ci.fcl.duty_percent),
          container_type: ci.fcl.container_type,
          packing_type: ci.fcl.packing_type as FCLPackingType,
          selling_quantity: num(ci.fcl.selling_quantity),
        }, cc, fxRate);
      } else if (cm === 'lcl') {
        res = calculateLCL({
          purchase_currency: ci.lcl.purchase_currency || 'USD',
          purchase_price: num(ci.lcl.purchase_price),
          inr_price: num(ci.lcl.inr_price),
          product_qty: num(ci.lcl.product_qty),
          total_shipment_qty: num(ci.lcl.total_shipment_qty),
          packing_type: ci.lcl.packing_type as LCLPackingType,
          india_margin_percent: num(ci.lcl.india_margin_percent),
          indonesia_margin_percent: num(ci.lcl.indonesia_margin_percent),
          freight_type: ci.lcl.freight_type || 'usd_per_kg',
          freight_value: num(ci.lcl.freight_value),
          insurance_percent: ci.lcl.apply_insurance !== false ? num(ci.lcl.insurance_percent) : 0,
          duty_percent: num(ci.lcl.duty_percent),
          additional_cost_percent: num(ci.lcl.additional_cost_percent),
        }, cc, fxRate);
      } else {
        res = calculateAir({
          purchase_currency: ci.air.purchase_currency || 'USD',
          purchase_price: num(ci.air.purchase_price),
          inr_price: num(ci.air.inr_price),
          weight: num(ci.air.weight),
          india_margin_percent: num(ci.air.india_margin_percent),
          indonesia_margin_percent: num(ci.air.indonesia_margin_percent),
          freight_type: ci.air.freight_type || 'usd_per_kg',
          freight_value: num(ci.air.freight_value),
          insurance_percent: ci.air.apply_insurance !== false ? num(ci.air.insurance_percent) : 0,
          duty_percent: num(ci.air.duty_percent),
        }, cc, fxRate);
      }
      setResult(res);
    } catch (e) {
      console.error('Calculation error', e);
    } finally {
      setCalculating(false);
    }
  }, []);

  useEffect(() => {
    if (!loading) {
      localStorage.setItem('pc_inputs_v3', JSON.stringify(inputs));
      runCalculation(inputs, config, mode);
    }
  }, [inputs, config, mode, loading, runCalculation]);

  const setInput = (section: string, field: string, value: any) =>
    setInputs((prev: any) => ({ ...prev, [section]: { ...prev[section], [field]: value } }));

  const updateConfig = (path: string[], value: any) => {
    const next = JSON.parse(JSON.stringify(config)) as any;
    let cur = next;
    for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]];
    cur[path[path.length - 1]] = value;
    setConfig(next as PricingConfig);
  };

  const saveConfig = async () => {
    setSavingConfig(true);
    try {
      if (configId) {
        await supabase.from('pricing_settings').update({ config, updated_at: new Date().toISOString() }).eq('id', configId);
      } else {
        const { data } = await supabase.from('pricing_settings').insert({ config }).select('id').single();
        if (data) setConfigId(data.id);
      }
    } catch (e) { console.error('Save failed', e); }
    finally { setSavingConfig(false); }
  };

  const handleFetchINRRate = async () => {
    setFetchingINR(true);
    try {
      const live = await fetchLiveINRRate();
      setConfig(prev => {
        const next = JSON.parse(JSON.stringify(prev)) as PricingConfig;
        next.general.inr_usd_cached_rate = live;
        next.general.inr_usd_cached_at = Date.now();
        return next;
      });
    } catch (e) {
      console.error('Failed to fetch INR rate', e);
    } finally {
      setFetchingINR(false);
    }
  };

  const inrRate = getEffectiveINRRate(config);

  const selectedPacking = FCL_PACKING_OPTIONS.find(o => o.value === inputs.fcl.packing_type);
  const fclCapacity = config.fcl[inputs.fcl.container_type as '20ft' | '40ft']?.capacity?.[inputs.fcl.packing_type as FCLPackingType] ?? 0;
  const fclUnitWeight = selectedPacking?.unit_weight ?? 25;
  const fclEstUnits = fclCapacity > 0 ? Math.floor(fclCapacity / fclUnitWeight) : 0;

  const lclPkg = config.lcl.packaging[inputs.lcl.packing_type as keyof typeof config.lcl.packaging];
  const lclProductQty = num(inputs.lcl.product_qty);
  const lclTotalShipment = num(inputs.lcl.total_shipment_qty);
  const lclShipmentUnits = lclPkg && lclPkg.weight > 0 && lclTotalShipment > 0 ? Math.ceil(lclTotalShipment / lclPkg.weight) : 0;
  const lclShipmentCbm = lclShipmentUnits * (lclPkg?.cbm ?? 0);
  const lclChargeableCbm = lclTotalShipment > 0 ? Math.max(lclShipmentCbm, config.lcl.min_chargeable) : 0;
  const lclShipmentTon = lclTotalShipment / 1000;
  const lclAllocationRatio = lclTotalShipment > 0 && lclProductQty > 0 ? lclProductQty / lclTotalShipment : 0;

  const airWeight = num(inputs.air.weight);
  const airSlabApplied = airWeight > 0 && airWeight <= config.air.clearance_min_weight;

  const inrCachedAt = config.general.inr_usd_cached_at;
  const inrCachedLabel = inrCachedAt
    ? new Date(inrCachedAt).toLocaleString()
    : 'Never fetched';

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-40">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="max-w-5xl mx-auto">
        <div className="mb-4">
          <h1 className="text-lg font-bold text-gray-900">Price Calculator</h1>
          <p className="text-xs text-gray-400">FCL / LCL / Air import costing · INR / USD · Live FX</p>
        </div>

        <div className="border-b border-gray-200 mb-4 flex overflow-x-auto">
          {([
            { key: 'calculator', label: 'Calculator', icon: <Calculator className="w-3.5 h-3.5" /> },
            { key: 'settings', label: 'Settings', icon: <SettingsIcon className="w-3.5 h-3.5" /> },
            { key: 'import_info', label: 'Import Info', icon: <Database className="w-3.5 h-3.5" /> },
          ] as const).map((tab) => (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${activeTab === tab.key ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        {activeTab === 'calculator' && (
          <div className="space-y-3">
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="flex flex-col gap-3 mb-4">
                <div className="flex items-center justify-between">
                  <div className="flex gap-1.5">
                    {(['fcl', 'lcl', 'air'] as const).map((m) => (
                      <button key={m} onClick={() => setMode(m)}
                        className={`px-4 py-1.5 rounded-md text-sm font-semibold transition-colors ${mode === m ? 'bg-blue-600 text-white shadow-sm' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                        {m.toUpperCase()}
                      </button>
                    ))}
                  </div>
                  <div className="hidden sm:flex items-center gap-1 text-xs text-gray-400 bg-gray-50 border border-gray-200 rounded px-2 py-1">
                    <TrendingDown className="w-3 h-3 text-orange-500" />
                    <span>₹/$ = <strong className="text-gray-700">{inrRate}</strong></span>
                    <button
                      onClick={handleFetchINRRate}
                      disabled={fetchingINR}
                      title="Fetch live INR/USD rate"
                      className="ml-0.5 text-gray-400 hover:text-orange-500 disabled:opacity-40 transition-colors"
                    >
                      <RefreshCw className={`w-3 h-3 ${fetchingINR ? 'animate-spin text-orange-500' : ''}`} />
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex sm:hidden items-center gap-1 text-xs text-gray-400 bg-gray-50 border border-gray-200 rounded px-2 py-1.5 flex-1">
                    <TrendingDown className="w-3 h-3 text-orange-500" />
                    <span>₹/$ = <strong className="text-gray-700">{inrRate}</strong></span>
                    <button
                      onClick={handleFetchINRRate}
                      disabled={fetchingINR}
                      title="Fetch live INR/USD rate"
                      className="ml-0.5 text-gray-400 hover:text-orange-500 disabled:opacity-40 transition-colors"
                    >
                      <RefreshCw className={`w-3 h-3 ${fetchingINR ? 'animate-spin text-orange-500' : ''}`} />
                    </button>
                  </div>
                  <button
                    onClick={() => runCalculation(inputs, config, mode)}
                    disabled={calculating}
                    className="flex items-center justify-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-md hover:bg-blue-700 disabled:opacity-60 transition-colors shadow-sm w-full sm:w-auto"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${calculating ? 'animate-spin' : ''}`} />
                    Calculate Price
                  </button>
                </div>
              </div>

              {mode === 'fcl' && (
                <>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
                    <PurchasePriceField section="fcl" inputs={inputs} setInput={setInput} inrRate={inrRate} />
                    <PctField label="India Margin" value={inputs.fcl.india_margin_percent}
                      onChange={(v) => setInput('fcl', 'india_margin_percent', v)} />
                    <PctField label="Indonesia Margin" value={inputs.fcl.indonesia_margin_percent}
                      onChange={(v) => setInput('fcl', 'indonesia_margin_percent', v)} />
                    <FreightField section="fcl" inputs={inputs} setInput={setInput} mode="fcl" />
                    <InsuranceField section="fcl" inputs={inputs} setInput={setInput} />
                    <PctField label="Import Duty" value={inputs.fcl.duty_percent}
                      onChange={(v) => setInput('fcl', 'duty_percent', v)} />
                    <Field label="Container">
                      <select className={inputCls} value={inputs.fcl.container_type}
                        onChange={(e) => setInput('fcl', 'container_type', e.target.value)}>
                        <option value="20ft">20ft Container</option>
                        <option value="40ft">40ft Container</option>
                      </select>
                    </Field>
                    <Field label="Packing Type">
                      <select className={inputCls} value={inputs.fcl.packing_type}
                        onChange={(e) => setInput('fcl', 'packing_type', e.target.value)}>
                        {FCL_PACKING_OPTIONS.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Selling Qty (kg)">
                      <input type="number" step="any" className={inputCls} value={inputs.fcl.selling_quantity}
                        onChange={(e) => setInput('fcl', 'selling_quantity', e.target.value)} placeholder="0" />
                    </Field>
                  </div>
                  <div className="mt-3 flex items-start gap-1.5 bg-blue-50 rounded-lg px-3 py-2">
                    <Info className="w-3.5 h-3.5 text-blue-400 mt-0.5 flex-shrink-0" />
                    {fclCapacity > 0 ? (
                      <span className="text-xs text-blue-600">
                        Standard Loading: <strong>{fclCapacity.toLocaleString()} kg</strong>
                        &nbsp;·&nbsp; Est. Units: <strong>{fclEstUnits.toLocaleString()} × {fclUnitWeight}kg</strong>
                        &nbsp;·&nbsp; Clearance: <strong>${config.fcl[inputs.fcl.container_type as '20ft' | '40ft'].clearance.toLocaleString()}</strong>
                      </span>
                    ) : (
                      <span className="text-xs text-amber-600">
                        Capacity not configured for {inputs.fcl.container_type} + {selectedPacking?.label}. Go to Settings.
                      </span>
                    )}
                  </div>
                </>
              )}

              {mode === 'lcl' && (
                <>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
                    <PurchasePriceField section="lcl" inputs={inputs} setInput={setInput} inrRate={inrRate} />
                    <Field label="Product Qty (kg)">
                      <input type="number" step="any" className={inputCls} value={inputs.lcl.product_qty}
                        onChange={(e) => setInput('lcl', 'product_qty', e.target.value)} placeholder="e.g. 100" />
                    </Field>
                    <Field label="Total Shipment Qty (kg)">
                      <input type="number" step="any" className={`${inputCls} ${!inputs.lcl.total_shipment_qty ? 'border-amber-400' : ''}`}
                        value={inputs.lcl.total_shipment_qty}
                        onChange={(e) => setInput('lcl', 'total_shipment_qty', e.target.value)} placeholder="e.g. 5000" />
                    </Field>
                    <Field label="Packing Type">
                      <select className={inputCls} value={inputs.lcl.packing_type}
                        onChange={(e) => setInput('lcl', 'packing_type', e.target.value)}>
                        {LCL_PACKING_OPTIONS.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </Field>
                    <PctField label="India Margin" value={inputs.lcl.india_margin_percent}
                      onChange={(v) => setInput('lcl', 'india_margin_percent', v)} />
                    <PctField label="Indonesia Margin" value={inputs.lcl.indonesia_margin_percent}
                      onChange={(v) => setInput('lcl', 'indonesia_margin_percent', v)} />
                    <FreightField section="lcl" inputs={inputs} setInput={setInput} mode="lcl" />
                    <InsuranceField section="lcl" inputs={inputs} setInput={setInput} />
                    <PctField label="Import Duty" value={inputs.lcl.duty_percent}
                      onChange={(v) => setInput('lcl', 'duty_percent', v)} />
                    <PctField label="Additional Cost" value={inputs.lcl.additional_cost_percent}
                      onChange={(v) => setInput('lcl', 'additional_cost_percent', v)} />
                  </div>
                  {lclTotalShipment > 0 && lclPkg && (
                    <div className="mt-3 flex items-start gap-1.5 bg-blue-50 rounded-lg px-3 py-2">
                      <Info className="w-3.5 h-3.5 text-blue-400 mt-0.5 flex-shrink-0" />
                      <span className="text-xs text-blue-600">
                        Shipment CBM: <strong>{fmtCbm(lclShipmentCbm)}</strong>
                        &nbsp;·&nbsp; Chargeable CBM: <strong>{fmtCbm(lclChargeableCbm)}</strong>
                        &nbsp;·&nbsp; Shipment Tons: <strong>{lclShipmentTon.toFixed(2)}</strong>
                        &nbsp;·&nbsp; Trucking: <strong>${lclShipmentTon <= 2 ? config.lcl.trucking_2t : lclShipmentTon <= 4 ? config.lcl.trucking_4t : config.lcl.trucking_above_4t}</strong>
                        &nbsp;({lclShipmentTon <= 2 ? '≤2T' : lclShipmentTon <= 4 ? '≤4T' : '>4T'})
                        {lclAllocationRatio > 0 && (
                          <>&nbsp;·&nbsp; Allocated Ratio: <strong>{(lclAllocationRatio * 100).toFixed(2)}%</strong></>
                        )}
                      </span>
                    </div>
                  )}
                </>
              )}

              {mode === 'air' && (
                <>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4 lg:grid-cols-4">
                    <PurchasePriceField section="air" inputs={inputs} setInput={setInput} inrRate={inrRate} />
                    <Field label="Shipment Weight (kg)">
                      <input type="number" step="any" className={inputCls} value={inputs.air.weight}
                        onChange={(e) => setInput('air', 'weight', e.target.value)} placeholder="0" />
                    </Field>
                    <PctField label="India Margin" value={inputs.air.india_margin_percent}
                      onChange={(v) => setInput('air', 'india_margin_percent', v)} />
                    <PctField label="Indonesia Margin" value={inputs.air.indonesia_margin_percent}
                      onChange={(v) => setInput('air', 'indonesia_margin_percent', v)} />
                    <FreightField section="air" inputs={inputs} setInput={setInput} mode="air" />
                    <InsuranceField section="air" inputs={inputs} setInput={setInput} />
                    <PctField label="Import Duty" value={inputs.air.duty_percent}
                      onChange={(v) => setInput('air', 'duty_percent', v)} />
                  </div>
                  {airWeight > 0 && (
                    <div className="mt-3 flex items-start gap-1.5 bg-blue-50 rounded-lg px-3 py-2">
                      <Info className="w-3.5 h-3.5 text-blue-400 mt-0.5 flex-shrink-0" />
                      <span className="text-xs text-blue-600">
                        {airSlabApplied ? (
                          <>Clearance: <strong>${config.air.clearance_base}</strong> (base slab ≤{config.air.clearance_min_weight}kg)</>
                        ) : (
                          <>Clearance: <strong>${config.air.clearance_base} + ({airWeight}-{config.air.clearance_min_weight}) × ${config.air.clearance_per_kg_after}/kg</strong></>
                        )}
                        &nbsp;·&nbsp; Trucking: <strong>${airWeight <= 500 ? config.air.trucking_500 : config.air.trucking_above_500}</strong>
                        &nbsp;({airWeight <= 500 ? '≤500kg' : '>500kg'})
                        &nbsp;·&nbsp; Generic: <strong>${config.air.generic_charge}</strong>
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-1.5">
                  <DollarSign className="w-4 h-4 text-green-600" />
                  <span className="text-sm font-semibold text-gray-900">Result</span>
                  {calculating && <span className="text-xs text-gray-400">Calculating...</span>}
                </div>
                {result && !result.is_zero && (
                  <button onClick={() => setShowBreakdown(!showBreakdown)}
                    className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700">
                    <span>{showBreakdown ? 'Hide' : 'Show'} Breakdown</span>
                    {showBreakdown ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>
                )}
              </div>

              {(!result || result.is_zero) && (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
                  <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-amber-700">
                      {result?.zero_reason ?? 'Enter values above to calculate price'}
                    </p>
                    <p className="text-[11px] text-amber-500 mt-0.5">
                      Fill in purchase price and required fields, then click Calculate Price.
                    </p>
                  </div>
                </div>
              )}

              {result && !result.is_zero && (
                <>
                  {result.inr_to_usd_rate > 0 && (
                    <div className="mb-3 flex items-center gap-2 bg-orange-50 border border-orange-100 rounded-lg px-3 py-1.5">
                      <TrendingDown className="w-3.5 h-3.5 text-orange-500 flex-shrink-0" />
                      <span className="text-xs text-orange-700">
                        INR price converted: <strong>₹/$ = {result.inr_to_usd_rate}</strong>
                        &nbsp;→ Purchase price = <strong>${fmt4(result.purchase_price_usd)}/kg</strong>
                      </span>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                    <div className="bg-blue-600 rounded-xl px-3 py-3 shadow-md col-span-2 sm:col-span-1 lg:col-span-2 flex flex-col justify-between">
                      <div className="text-[10px] text-blue-100 font-semibold uppercase tracking-widest">Quote Price / kg</div>
                      <div className="mt-1">
                        <div className="text-2xl font-extrabold text-white">${fmt2(result.final_price_per_kg_usd)}</div>
                        <div className="text-sm font-semibold text-blue-100 mt-0.5">Rp {fmtIDR(result.final_price_per_kg_idr)}</div>
                        <WordsRow text={usdToWords(result.final_price_per_kg_usd)} />
                      </div>
                    </div>
                    <div className="bg-gray-50 rounded-lg px-3 py-2">
                      <div className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">Landed Cost/kg</div>
                      <div className="text-sm font-bold text-gray-900 mt-0.5">${fmt2(result.landed_cost_per_kg_usd)}</div>
                    </div>
                    <div className="bg-green-50 rounded-lg px-3 py-2">
                      <div className="text-[10px] text-green-600 font-medium uppercase tracking-wide">Total Quote (USD)</div>
                      <div className="text-sm font-bold text-green-700 mt-0.5">${fmt2(result.total_quote_usd)}</div>
                      <WordsRow text={usdToWords(result.total_quote_usd)} />
                    </div>
                    <div className="bg-green-50 rounded-lg px-3 py-2">
                      <div className="text-[10px] text-green-600 font-medium uppercase tracking-wide">Total Quote (IDR)</div>
                      <div className="text-sm font-bold text-green-700 mt-0.5">Rp {fmtIDR(result.total_quote_idr)}</div>
                      <WordsRow text={idrToWords(result.total_quote_idr)} />
                    </div>
                    <div className="bg-slate-50 rounded-lg px-3 py-2">
                      <div className="text-[10px] text-slate-500 font-medium uppercase tracking-wide">USD/IDR Rate</div>
                      <div className="text-sm font-bold text-slate-700 mt-0.5">{fmtIDR(result.applied_fx_rate)}</div>
                      <div className="text-[10px] text-slate-400">applied rate</div>
                    </div>
                  </div>

                  {showBreakdown && (
                    <div className="mt-3 border-t border-gray-100 pt-3">
                      <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Cost Breakdown</div>
                      <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-3 lg:grid-cols-4">
                        {Object.entries(result.breakdown).map(([key, value]) => {
                          const kgKeys = ['capacity_kg', 'loaded_qty', 'product_qty', 'total_shipment_qty', 'shipment_units'];
                          const cbmKeys = ['shipment_cbm', 'chargeable_cbm'];
                          const tonKeys = ['shipment_tons'];
                          const ratioKeys = ['allocation_ratio'];
                          let formatted: string;
                          if (kgKeys.includes(key)) formatted = `${(value as number).toLocaleString()} kg`;
                          else if (cbmKeys.includes(key)) formatted = `${(value as number).toFixed(3)} CBM`;
                          else if (tonKeys.includes(key)) formatted = `${(value as number).toFixed(2)} MT`;
                          else if (ratioKeys.includes(key)) formatted = `${((value as number) * 100).toFixed(2)}%`;
                          else formatted = `$${(value as number).toFixed(4)}`;
                          return (
                            <div key={key} className="flex justify-between py-1 border-b border-gray-50">
                              <span className="text-xs text-gray-500 capitalize">{key.replace(/_/g, ' ')}</span>
                              <span className="text-xs font-semibold text-gray-800">{formatted}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className="mt-3 border-t border-gray-100 pt-2">
                    <button onClick={() => setShowAssumptions(!showAssumptions)}
                      className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600">
                      <Info className="w-3 h-3" />
                      <span>{mode === 'lcl' ? 'How LCL Calculation Works' : 'Assumptions Used'}</span>
                      {showAssumptions ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    </button>
                    {showAssumptions && (
                      <ul className="mt-1.5 space-y-0.5 pl-4 list-disc text-[11px] text-gray-400">
                        {mode === 'lcl' ? (
                          <>
                            <li>Clearance, trucking and generic charges are calculated on total shipment quantity</li>
                            <li>Cost is allocated proportionally to product quantity</li>
                            <li>Smaller product quantities will have higher per kg allocation</li>
                            <li>Freight applies only to product value (% mode) or product qty ($/kg mode)</li>
                          </>
                        ) : mode === 'fcl' ? (
                          <>
                            <li>Standard container capacity from Settings is used for all cost distribution</li>
                            <li>Clearance is a fixed cost per container, divided by container capacity</li>
                            <li>Selling Qty is used only to compute total quote value, not for cost allocation</li>
                            <li>FX rate rounded up to nearest 10, buffer applied if configured</li>
                          </>
                        ) : (
                          <>
                            <li>Air freight uses minimum weight slab if actual weight is below threshold</li>
                            <li>FX rate rounded up to nearest 10</li>
                            <li>FX buffer applied if configured</li>
                          </>
                        )}
                      </ul>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="space-y-3">
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="text-sm font-semibold text-gray-700 mb-1">INR / USD Rate Settings</div>
              <p className="text-xs text-gray-400 mb-3">Controls how INR supplier prices are converted to USD. Effective Rate = Live Rate − Buffer.</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-3">
                <Field label="INR/USD Mode">
                  <select className={inputCls} value={config.general.inr_usd_mode}
                    onChange={(e) => updateConfig(['general', 'inr_usd_mode'], e.target.value)}>
                    <option value="manual">Manual Rate</option>
                    <option value="auto">Auto (Live − Buffer)</option>
                  </select>
                </Field>
                <Field label="Manual INR/USD Rate">
                  <input type="number" step="0.01" className={inputCls}
                    value={config.general.inr_usd_manual_rate}
                    onChange={(e) => updateConfig(['general', 'inr_usd_manual_rate'], parseFloat(e.target.value) || 0)}
                    disabled={config.general.inr_usd_mode !== 'manual'} />
                </Field>
                <Field label="Buffer (subtract from live)">
                  <input type="number" step="0.01" className={inputCls}
                    value={config.general.inr_usd_buffer}
                    onChange={(e) => updateConfig(['general', 'inr_usd_buffer'], parseFloat(e.target.value) || 0)} />
                </Field>
                <div>
                  <label className={labelCls}>Live Rate Snapshot</label>
                  <div className="flex gap-1">
                    <div className="flex-1 px-2.5 py-1.5 border border-gray-200 rounded-md text-sm bg-gray-50 text-gray-700">
                      {config.general.inr_usd_cached_rate > 0 ? config.general.inr_usd_cached_rate.toFixed(2) : '—'}
                    </div>
                    <button onClick={handleFetchINRRate} disabled={fetchingINR}
                      className="px-2.5 py-1.5 bg-orange-50 border border-orange-200 text-orange-700 text-xs rounded-md hover:bg-orange-100 disabled:opacity-50 whitespace-nowrap transition-colors">
                      {fetchingINR ? 'Fetching...' : 'Fetch Live'}
                    </button>
                  </div>
                  <div className="text-[10px] text-gray-400 mt-0.5">Last: {inrCachedLabel}</div>
                </div>
              </div>
              <div className="bg-orange-50 border border-orange-100 rounded-lg px-3 py-2 text-xs text-orange-700">
                {config.general.inr_usd_mode === 'manual' ? (
                  <>Effective Rate = <strong>{config.general.inr_usd_manual_rate} (manual)</strong></>
                ) : (
                  <>
                    Effective Rate = Live ({config.general.inr_usd_cached_rate > 0 ? config.general.inr_usd_cached_rate.toFixed(2) : 'not fetched'}) − Buffer ({config.general.inr_usd_buffer}) = <strong>{inrRate.toFixed(2)}</strong>
                  </>
                )}
                &nbsp;·&nbsp; Example: ₹100/kg ÷ {inrRate} = ${(100 / inrRate).toFixed(4)}/kg
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="text-sm font-semibold text-gray-700 mb-3">USD / IDR FX Settings</div>
              <div className="grid grid-cols-3 gap-3">
                <Field label="FX Mode">
                  <select className={inputCls} value={config.general.fx_mode}
                    onChange={(e) => updateConfig(['general', 'fx_mode'], e.target.value)}>
                    <option value="auto">Auto (Live Rate)</option>
                    <option value="manual">Manual Rate</option>
                  </select>
                </Field>
                <PctField label="FX Buffer (%)" value={String(config.general.fx_buffer_percent)}
                  onChange={(v) => updateConfig(['general', 'fx_buffer_percent'], parseFloat(v) || 0)} />
                <Field label="Manual FX Rate (IDR)">
                  <input type="number" step="1" className={inputCls} value={config.general.manual_fx_rate}
                    onChange={(e) => updateConfig(['general', 'manual_fx_rate'], parseFloat(e.target.value) || 0)}
                    disabled={config.general.fx_mode !== 'manual'} />
                </Field>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="text-sm font-semibold text-gray-700 mb-3">FCL Container Settings</div>
              {(['20ft', '40ft'] as const).map((ct) => (
                <div key={ct} className="mb-4">
                  <div className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">{ct} Container</div>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                    <Field label="Clearance (USD)">
                      <MoneyInput className={inputCls} value={config.fcl[ct].clearance}
                        onChange={(amount) => updateConfig(['fcl', ct, 'clearance'], amount)} />
                    </Field>
                    {FCL_PACKING_OPTIONS.map(opt => (
                      <Field key={opt.value} label={`${opt.label} (kg)`}>
                        <input type="number" step="any" className={inputCls}
                          value={config.fcl[ct].capacity[opt.value] ?? 0}
                          onChange={(e) => updateConfig(['fcl', ct, 'capacity', opt.value], parseFloat(e.target.value) || 0)} />
                      </Field>
                    ))}
                  </div>
                </div>
              ))}
              <div className="bg-blue-50 rounded-lg px-3 py-2 text-xs text-blue-600">
                Set these to the typical actual loaded qty for each packing type, not theoretical max capacity.
                You can also override per-quote using the "Actual Loaded Qty" field in the calculator.
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="text-sm font-semibold text-gray-700 mb-3">LCL Settings (CIF Model)</div>

              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">W/M Rule</div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-4">
                <Field label="Min Chargeable (CBM)">
                  <input type="number" step="any" className={inputCls} value={config.lcl.min_chargeable}
                    onChange={(e) => updateConfig(['lcl', 'min_chargeable'], parseFloat(e.target.value) || 0)} />
                </Field>
              </div>

              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Clearance Slab (CBM based)</div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 mb-4">
                <Field label="Base Clearance (USD)">
                  <MoneyInput className={inputCls} value={config.lcl.clearance_base}
                    onChange={(amount) => updateConfig(['lcl', 'clearance_base'], amount)} />
                </Field>
                <Field label="Base Limit (CBM)">
                  <input type="number" step="any" className={inputCls} value={config.lcl.clearance_base_limit_cbm}
                    onChange={(e) => updateConfig(['lcl', 'clearance_base_limit_cbm'], parseFloat(e.target.value) || 0)} />
                </Field>
                <Field label="Additional / CBM after limit (USD)">
                  <MoneyInput className={inputCls} value={config.lcl.clearance_additional_per_cbm}
                    onChange={(amount) => updateConfig(['lcl', 'clearance_additional_per_cbm'], amount)} maximumFractionDigits={4} />
                </Field>
              </div>
              <div className="mb-4 text-[11px] text-gray-400 bg-gray-50 rounded px-3 py-1.5">
                If chargeable ≤ {config.lcl.clearance_base_limit_cbm} CBM → ${config.lcl.clearance_base} flat.
                Above → ${config.lcl.clearance_base} + (CBM − {config.lcl.clearance_base_limit_cbm}) × ${config.lcl.clearance_additional_per_cbm}
              </div>

              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Trucking Slab (Ton based)</div>
              <div className="grid grid-cols-3 gap-3 mb-4">
                <Field label="Trucking ≤ 2 Ton (USD)">
                  <MoneyInput className={inputCls} value={config.lcl.trucking_2t}
                    onChange={(amount) => updateConfig(['lcl', 'trucking_2t'], amount)} />
                </Field>
                <Field label="Trucking ≤ 4 Ton (USD)">
                  <MoneyInput className={inputCls} value={config.lcl.trucking_4t}
                    onChange={(amount) => updateConfig(['lcl', 'trucking_4t'], amount)} />
                </Field>
                <Field label="Trucking > 4 Ton (USD)">
                  <MoneyInput className={inputCls} value={config.lcl.trucking_above_4t}
                    onChange={(amount) => updateConfig(['lcl', 'trucking_above_4t'], amount)} />
                </Field>
              </div>

              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Generic Shipment Charge</div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-4">
                <Field label="Generic Charge (USD)">
                  <MoneyInput className={inputCls} value={config.lcl.generic_charge}
                    onChange={(amount) => updateConfig(['lcl', 'generic_charge'], amount)} />
                </Field>
              </div>

              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Packaging Dimensions</div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {(['mixed', '25kg_drum', '50kg_drum', '25kg_bag', '50kg_bag'] as const).map((pk) => (
                  <div key={pk} className="border border-gray-100 rounded-lg p-2.5 bg-gray-50">
                    <div className="text-xs font-semibold text-gray-600 mb-2">{pk === 'mixed' ? 'Mixed Lot' : pk.replace(/_/g, ' ')}</div>
                    <div className="space-y-1.5">
                      <Field label="Weight (kg)">
                        <input type="number" step="any" className={inputCls}
                          value={config.lcl.packaging[pk]?.weight ?? 0}
                          onChange={(e) => updateConfig(['lcl', 'packaging', pk, 'weight'], parseFloat(e.target.value) || 0)} />
                      </Field>
                      <Field label="CBM per unit">
                        <input type="number" step="0.001" className={inputCls}
                          value={config.lcl.packaging[pk]?.cbm ?? 0}
                          onChange={(e) => updateConfig(['lcl', 'packaging', pk, 'cbm'], parseFloat(e.target.value) || 0)} />
                      </Field>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="text-sm font-semibold text-gray-700 mb-3">Air Freight Settings</div>

              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Clearance Slab (Weight based)</div>
              <div className="grid grid-cols-3 gap-3 mb-2">
                <Field label="Base Clearance (USD)">
                  <MoneyInput className={inputCls} value={config.air.clearance_base}
                    onChange={(amount) => updateConfig(['air', 'clearance_base'], amount)} />
                </Field>
                <Field label="Min Weight Threshold (kg)">
                  <input type="number" step="any" className={inputCls} value={config.air.clearance_min_weight}
                    onChange={(e) => updateConfig(['air', 'clearance_min_weight'], parseFloat(e.target.value) || 0)} />
                </Field>
                <Field label="Rate / kg After Threshold (USD)">
                  <MoneyInput className={inputCls} value={config.air.clearance_per_kg_after}
                    onChange={(amount) => updateConfig(['air', 'clearance_per_kg_after'], amount)} maximumFractionDigits={4} />
                </Field>
              </div>
              <div className="mb-4 text-[11px] text-gray-400 bg-gray-50 rounded px-3 py-1.5">
                If weight ≤ {config.air.clearance_min_weight}kg → ${config.air.clearance_base} flat.
                Above → ${config.air.clearance_base} + (weight − {config.air.clearance_min_weight}) × ${config.air.clearance_per_kg_after}/kg
              </div>

              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Trucking Slab (Weight based)</div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-4">
                <Field label="Trucking ≤ 500kg (USD)">
                  <MoneyInput className={inputCls} value={config.air.trucking_500}
                    onChange={(amount) => updateConfig(['air', 'trucking_500'], amount)} />
                </Field>
                <Field label="Trucking > 500kg (USD)">
                  <MoneyInput className={inputCls} value={config.air.trucking_above_500}
                    onChange={(amount) => updateConfig(['air', 'trucking_above_500'], amount)} />
                </Field>
              </div>

              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Generic Shipment Charge</div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Field label="Generic Charge (USD)">
                  <MoneyInput className={inputCls} value={config.air.generic_charge}
                    onChange={(amount) => updateConfig(['air', 'generic_charge'], amount)} />
                </Field>
              </div>
            </div>

            <div className="flex justify-end pb-3">
              <button onClick={saveConfig} disabled={savingConfig}
                className="px-5 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-sm">
                {savingConfig ? 'Saving...' : 'Save Settings'}
              </button>
            </div>
          </div>
        )}

        {activeTab === 'import_info' && (
          <div className="bg-white rounded-xl border border-gray-200 p-4" style={{ minHeight: '70vh', display: 'flex', flexDirection: 'column' }}>
            <ImportInfo />
          </div>
        )}
      </div>
    </Layout>
  );
}
