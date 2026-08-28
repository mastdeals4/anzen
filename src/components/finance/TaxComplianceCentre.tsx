import { Suspense, useState } from 'react';
import { Calendar, FileText, Receipt, Layers, TrendingUp, Lock, ShieldCheck } from 'lucide-react';
import { TaxCalendarPanel } from './tax/TaxCalendarPanel';
import { TaxPeriodsPanel } from './tax/TaxPeriodsPanel';
import { PphRegisterPanel } from './tax/PphRegisterPanel';
import { TaxPaymentsPanel } from './tax/TaxPaymentsPanel';
import { FakturPajakPanel } from './tax/FakturPajakPanel';
import { PeriodClosePanel } from './tax/PeriodClosePanel';
import { TaxReportsPanel } from './tax/TaxReportsPanel';
import { FinancePage } from './FinancePage';

type TaxSubTab =
  | 'calendar' | 'periods' | 'pph' | 'payments' | 'faktur' | 'close' | 'reports';

const TABS: { id: TaxSubTab; label: string; icon: JSX.Element }[] = [
  { id: 'calendar', label: 'Calendar',       icon: <Calendar className="w-3.5 h-3.5" /> },
  { id: 'periods',  label: 'PPN',            icon: <TrendingUp className="w-3.5 h-3.5" /> },
  { id: 'pph',      label: 'PPh',             icon: <Layers className="w-3.5 h-3.5" /> },
  { id: 'payments', label: 'Tax Payments',   icon: <Receipt className="w-3.5 h-3.5" /> },
  { id: 'faktur',   label: 'Faktur Pajak',   icon: <FileText className="w-3.5 h-3.5" /> },
  { id: 'close',    label: 'Period Close',   icon: <Lock className="w-3.5 h-3.5" /> },
  { id: 'reports',  label: 'Reports',        icon: <ShieldCheck className="w-3.5 h-3.5" /> },
];

interface Props {
  onOpenExpense?: (id: string) => void;
  onOpenPayment?: (id: string) => void;
  onOpenJournal?: (id: string) => void;
}

export function TaxComplianceCentre({ onOpenExpense, onOpenPayment, onOpenJournal }: Props) {
  const [active, setActive] = useState<TaxSubTab>('calendar');

  return (
    <FinancePage title="TAX COMPLIANCE">
      <div className="space-y-2">
      <div className="border-b border-gray-200 bg-white px-1 py-1.5">
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setActive(t.id)}
              className={`flex-none inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition ${
                active === t.id
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <Suspense fallback={<div className="text-gray-500 text-sm">Loading…</div>}>
        {active === 'calendar' && <TaxCalendarPanel />}
        {active === 'periods'  && <TaxPeriodsPanel />}
        {active === 'pph'      && <PphRegisterPanel onOpenExpense={onOpenExpense} onOpenPayment={onOpenPayment} onOpenJournal={onOpenJournal} />}
        {active === 'payments' && <TaxPaymentsPanel onOpenJournal={onOpenJournal} />}
        {active === 'faktur'   && <FakturPajakPanel />}
        {active === 'close'    && <PeriodClosePanel />}
        {active === 'reports'  && <TaxReportsPanel />}
      </Suspense>
      </div>
    </FinancePage>
  );
}
