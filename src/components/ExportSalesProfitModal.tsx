import { useState } from 'react';
import { Calendar, Download, FileSpreadsheet, Loader2, X } from 'lucide-react';
import { ExportDateRangeOptions, generateSalesProfitabilityExcel } from '../utils/salesProfitabilityExcelExport';

interface ExportSalesProfitModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentStartDate: string;
  currentEndDate: string;
}

const MONTHS = [
  { value: 1, label: 'January' },
  { value: 2, label: 'February' },
  { value: 3, label: 'March' },
  { value: 4, label: 'April' },
  { value: 5, label: 'May' },
  { value: 6, label: 'June' },
  { value: 7, label: 'July' },
  { value: 8, label: 'August' },
  { value: 9, label: 'September' },
  { value: 10, label: 'October' },
  { value: 11, label: 'November' },
  { value: 12, label: 'December' },
];

const YEARS = [2027, 2026, 2025, 2024];

export function ExportSalesProfitModal({
  isOpen,
  onClose,
  currentStartDate,
  currentEndDate,
}: ExportSalesProfitModalProps) {
  const [exportMode, setExportMode] = useState<'this_year' | 'specific_month' | 'custom' | 'current_screen'>('this_year');
  const [selectedYear, setSelectedYear] = useState<number>(2026);
  const [selectedMonth, setSelectedMonth] = useState<number>(new Date().getMonth() + 1);
  const [customStart, setCustomStart] = useState<string>(currentStartDate || '2026-01-01');
  const [customEnd, setCustomEnd] = useState<string>(currentEndDate || '2026-12-31');

  const [loading, setLoading] = useState<boolean>(false);
  const [progressMsg, setProgressMsg] = useState<string>('');
  const [progressPct, setProgressPct] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  // Resolve effective date range based on selection
  const resolveDateRange = (): ExportDateRangeOptions => {
    if (exportMode === 'this_year') {
      return {
        mode: 'this_year',
        year: selectedYear,
        startDate: `${selectedYear}-01-01`,
        endDate: `${selectedYear}-12-31`,
        label: `Full_Year_${selectedYear}`,
      };
    } else if (exportMode === 'specific_month') {
      const monthStr = String(selectedMonth).padStart(2, '0');
      const start = `${selectedYear}-${monthStr}-01`;
      // Find last day of the month
      const lastDay = new Date(selectedYear, selectedMonth, 0).getDate();
      const end = `${selectedYear}-${monthStr}-${String(lastDay).padStart(2, '0')}`;
      const mName = MONTHS.find(m => m.value === selectedMonth)?.label || monthStr;
      return {
        mode: 'specific_month',
        year: selectedYear,
        month: selectedMonth,
        startDate: start,
        endDate: end,
        label: `${mName}_${selectedYear}`,
      };
    } else if (exportMode === 'current_screen') {
      return {
        mode: 'current_screen',
        year: selectedYear,
        startDate: currentStartDate,
        endDate: currentEndDate,
        label: 'Current_Screen_View',
      };
    } else {
      return {
        mode: 'custom',
        year: selectedYear,
        startDate: customStart,
        endDate: customEnd,
        label: 'Custom_Date_Range',
      };
    }
  };

  const resolved = resolveDateRange();

  const handleStartExport = async () => {
    setLoading(true);
    setError(null);
    setProgressPct(0);
    setProgressMsg('Starting export preparation...');

    try {
      await generateSalesProfitabilityExcel(resolved, (step, pct) => {
        setProgressMsg(step);
        setProgressPct(pct);
      });
      // Short delay so user sees 100% complete
      setTimeout(() => {
        setLoading(false);
        onClose();
      }, 700);
    } catch (err: any) {
      console.error('Export error:', err);
      setError(err.message || 'Failed to export report');
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-screen items-center justify-center p-4">
        {/* Backdrop */}
        <div
          className="fixed inset-0 bg-gray-900 bg-opacity-60 transition-opacity backdrop-blur-sm"
          onClick={() => !loading && onClose()}
        />

        {/* Modal Window */}
        <div className="relative bg-white rounded-xl shadow-2xl max-w-lg w-full overflow-hidden border border-gray-100 animate-in fade-in zoom-in-95 duration-200">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 bg-gradient-to-r from-emerald-700 to-teal-800 text-white">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-white/10 rounded-lg backdrop-blur-md">
                <FileSpreadsheet className="w-6 h-6 text-emerald-200" />
              </div>
              <div>
                <h3 className="text-base font-bold tracking-tight">Export Sales Profitability to Excel</h3>
                <p className="text-xs text-emerald-100">Full drill-down report with batches & delivery challans</p>
              </div>
            </div>
            {!loading && (
              <button
                onClick={onClose}
                className="p-1 rounded-lg text-emerald-100 hover:text-white hover:bg-white/10 transition"
              >
                <X className="w-5 h-5" />
              </button>
            )}
          </div>

          {/* Body */}
          <div className="p-6 space-y-5">
            {/* Scope Selection */}
            <div>
              <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wider mb-2">
                Select Export Period Scope
              </label>
              <div className="grid grid-cols-2 gap-2.5">
                {[
                  { id: 'this_year', title: 'Full Year', desc: 'All 12 months for year' },
                  { id: 'specific_month', title: 'Specific Month', desc: 'Full month drill-down' },
                  { id: 'current_screen', title: 'Current Screen', desc: `${currentStartDate} to ${currentEndDate}` },
                  { id: 'custom', title: 'Custom Date', desc: 'Choose start & end date' },
                ].map(opt => (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={loading}
                    onClick={() => setExportMode(opt.id as any)}
                    className={`text-left p-3 rounded-lg border text-xs transition relative ${
                      exportMode === opt.id
                        ? 'border-emerald-600 bg-emerald-50/60 ring-1 ring-emerald-600 text-emerald-950 font-medium'
                        : 'border-gray-200 hover:border-gray-300 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    <div className="font-semibold text-sm">{opt.title}</div>
                    <div className="text-[11px] text-gray-500 mt-0.5 truncate">{opt.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Scope Options */}
            <div className="bg-gray-50 rounded-lg p-4 border border-gray-200 space-y-3">
              {/* Year Selector (shown for year or month) */}
              {(exportMode === 'this_year' || exportMode === 'specific_month') && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Target Year</label>
                  <select
                    value={selectedYear}
                    disabled={loading}
                    onChange={e => setSelectedYear(Number(e.target.value))}
                    className="w-full text-sm px-3 py-2 bg-white border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  >
                    {YEARS.map(y => (
                      <option key={y} value={y}>
                        Year {y}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Month Selector */}
              {exportMode === 'specific_month' && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Target Month</label>
                  <select
                    value={selectedMonth}
                    disabled={loading}
                    onChange={e => setSelectedMonth(Number(e.target.value))}
                    className="w-full text-sm px-3 py-2 bg-white border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  >
                    {MONTHS.map(m => (
                      <option key={m.value} value={m.value}>
                        {m.label} ({selectedYear})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Custom Date Pickers */}
              {exportMode === 'custom' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Start Date</label>
                    <input
                      type="date"
                      value={customStart}
                      disabled={loading}
                      onChange={e => setCustomStart(e.target.value)}
                      className="w-full text-xs px-2.5 py-2 bg-white border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">End Date</label>
                    <input
                      type="date"
                      value={customEnd}
                      disabled={loading}
                      onChange={e => setCustomEnd(e.target.value)}
                      className="w-full text-xs px-2.5 py-2 bg-white border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                  </div>
                </div>
              )}

              {/* Current Screen Preview */}
              {exportMode === 'current_screen' && (
                <div className="text-xs text-gray-600">
                  Exporting the exact date range currently active on screen: <br />
                  <span className="font-semibold text-gray-900">{currentStartDate}</span> to{' '}
                  <span className="font-semibold text-gray-900">{currentEndDate}</span>
                </div>
              )}

              {/* Range Confirmation Summary */}
              <div className="pt-2 border-t border-gray-200 flex items-center justify-between text-xs text-gray-600">
                <span className="flex items-center gap-1">
                  <Calendar className="w-3.5 h-3.5 text-gray-400" />
                  Resolved Period:
                </span>
                <span className="font-mono font-semibold text-gray-900">
                  {resolved.startDate} → {resolved.endDate}
                </span>
              </div>
            </div>

            {/* Excel Structure Info Callout */}
            <div className="bg-emerald-50/70 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-900 space-y-1">
              <div className="font-semibold flex items-center gap-1.5">
                <span>📊</span> Workbook Structure (4 Dedicated Sheets):
              </div>
              <ul className="list-disc list-inside space-y-0.5 text-[11px] text-emerald-800">
                <li>
                  <span className="font-medium">Detailed Profitability Audit:</span> Full hierarchy (Product → Batch →
                  Orders & DC) with unmerged lines and sub-totals.
                </li>
                <li>
                  <span className="font-medium">Product Summary:</span> Consolidated product sales, landed cost, and
                  canonical stock.
                </li>
                <li>
                  <span className="font-medium">Batch Summary:</span> Granular batch costs, stock, and margins.
                </li>
                <li>
                  <span className="font-medium">Orders & Delivery Challans:</span> Complete flat transaction register
                  with invoice, SO, DC, and expense vouchers.
                </li>
              </ul>
            </div>

            {/* Error Message */}
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                <strong>Export Error:</strong> {error}
              </div>
            )}

            {/* Progress Bar during loading */}
            {loading && (
              <div className="space-y-2 pt-1">
                <div className="flex justify-between text-xs text-gray-600">
                  <span className="flex items-center gap-1.5 font-medium">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600" />
                    {progressMsg || 'Processing...'}
                  </span>
                  <span className="font-mono font-semibold">{progressPct}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                  <div
                    className="bg-emerald-600 h-2 rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-3.5 bg-gray-50 border-t border-gray-200 flex items-center justify-end gap-2.5">
            <button
              type="button"
              disabled={loading}
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-100 transition disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={handleStartExport}
              className="inline-flex items-center gap-2 px-5 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg shadow transition disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Exporting Report...
                </>
              ) : (
                <>
                  <Download className="w-4 h-4" />
                  Generate Excel Report
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
