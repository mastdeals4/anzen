import React from 'react';
import { FolderArchive } from 'lucide-react';
import { UniversalDocumentBankTable } from '../components/documents/UniversalDocumentBankTable.tsx';

export const DocumentBankPage: React.FC = () => {
  return (
    <div className="p-4 sm:p-6 max-w-[1600px] mx-auto space-y-5 animate-in fade-in duration-150">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-blue-600 text-white rounded-2xl shadow-sm">
            <FolderArchive className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
              Universal Document Bank
            </h1>
            <p className="text-xs sm:text-sm text-slate-500 mt-0.5">
              One central document registry for Products, Batches, CRM, Pricing, Sourcing, and Orders
            </p>
          </div>
        </div>
      </div>

      {/* Main Document Bank Table & Workspace */}
      <UniversalDocumentBankTable />
    </div>
  );
};

