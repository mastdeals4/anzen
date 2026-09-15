import React from 'react';
import { Layers, CheckCircle2 } from 'lucide-react';
import { EnquiryControlCenterRow as RowModel } from '../../../types/enquiry/controlCenter.types.ts';
import { RequestBadges } from './RequestBadges';
import { CustomerNeedCell } from './CustomerNeedCell';
import { InlineEditDropdown, DropdownOption } from './InlineEditDropdown';
import { pipelineStatusOptions } from '../PipelineStatusBadge';

interface EnquiryControlCenterRowProps {
  row: RowModel;
  isSelected: boolean;
  onSelect: (row: RowModel) => void;
  onRefresh: () => void;
  userOptions: DropdownOption[];
  priorityOptions: DropdownOption[];
  canManage?: boolean;
}

const WAITING_FOR_COLORS: Record<string, string> = {
  CUSTOMER: 'bg-purple-100 text-purple-800 border-purple-200',
  INDIA: 'bg-amber-100 text-amber-800 border-amber-200',
  MANUFACTURER: 'bg-cyan-100 text-cyan-800 border-cyan-200',
  INTERNAL: 'bg-blue-100 text-blue-800 border-blue-200',
  NONE: 'bg-gray-100 text-gray-600 border-gray-200',
};

const AGE_COLORS = {
  today: 'bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold',
  recent: 'bg-blue-50 text-blue-700 border-blue-200',
  attention: 'bg-amber-50 text-amber-800 border-amber-200 font-semibold',
  ageing: 'bg-rose-50 text-rose-800 border-rose-200 font-bold',
};

export const EnquiryControlCenterRow: React.FC<EnquiryControlCenterRowProps> = ({
  row,
  isSelected,
  onSelect,
  onRefresh,
  userOptions,
  priorityOptions,
  canManage = true,
}) => {
  const { customer, operationalSummary, age, requests } = row;

  const waitingKey = operationalSummary.waitingFor.toUpperCase();
  const waitingColor = WAITING_FOR_COLORS[waitingKey] || 'bg-slate-100 text-slate-700 border-slate-200';

  const ageColor = AGE_COLORS[age.urgency] || 'bg-gray-100 text-gray-700 border-gray-200';

  const pipelineOptionsFormatted: DropdownOption[] = pipelineStatusOptions.map(p => ({
    value: p.value,
    label: p.label,
  }));

  return (
    <tr
      onClick={() => onSelect(row)}
      className={`border-b border-gray-200 text-xs transition cursor-pointer hover:bg-blue-50/60 ${
        isSelected ? 'bg-blue-50 ring-1 ring-blue-500 font-normal' : ''
      }`}
    >
      {/* 1. ENQ */}
      <td className="px-3 py-2 border-r border-gray-200 whitespace-nowrap font-semibold text-blue-700">
        <div className="flex items-center gap-1.5">
          {row.isMultiProduct && (
            <span title="Multi-product inquiry">
              <Layers className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
            </span>
          )}
          <span>{row.inquiryNumber}</span>
          {row.priceReady && (
            <span
              title="Supplier price ready"
              className="inline-flex items-center gap-0.5 text-[9px] bg-emerald-100 text-emerald-800 px-1 py-0.2 rounded font-bold"
            >
              <CheckCircle2 className="w-2.5 h-2.5" /> Ready
            </span>
          )}
        </div>
      </td>

      {/* 2. AGE */}
      <td className="px-2.5 py-2 border-r border-gray-200 whitespace-nowrap">
        <span
          className={`inline-block px-1.5 py-0.5 rounded text-[11px] border ${ageColor}`}
          title={`Received on ${row.inquiryDate}`}
        >
          {age.label}
        </span>
      </td>

      {/* 3. CUSTOMER */}
      <td className="px-3 py-2 border-r border-gray-200 min-w-[150px] max-w-[200px]">
        <div className="font-medium text-gray-900 truncate" title={customer.companyName}>
          {customer.companyName}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-gray-500 mt-0.5">
          <span
            className={`text-[9px] px-1 py-0.2 rounded border font-medium ${
              customer.isErpCustomer
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : 'bg-amber-50 text-amber-700 border-amber-200'
            }`}
          >
            {customer.isErpCustomer ? 'ERP' : 'Prospect'}
          </span>
          {customer.contactPerson && (
            <span className="truncate max-w-[110px]" title={customer.contactPerson}>
              {customer.contactPerson}
            </span>
          )}
        </div>
      </td>

      {/* 4. PRODUCT */}
      <td className="px-3 py-2 border-r border-gray-200 min-w-[140px] max-w-[220px]">
        <div className="font-medium text-gray-900 truncate" title={row.productName}>
          {row.productName}
        </div>
        {row.quantity && (
          <div className="text-[11px] text-gray-500 font-normal truncate">Qty: {row.quantity}</div>
        )}
      </td>

      {/* 5. CUSTOMER NEED */}
      <td className="px-3 py-2 border-r border-gray-200 min-w-[140px] max-w-[200px]">
        <CustomerNeedCell
          quantity={row.quantity}
          specification={row.specification}
          requestsRequirement={requests[0]?.customer_requirement}
        />
      </td>

      {/* 6. CURRENT BLOCKER */}
      <td className="px-3 py-2 border-r border-gray-200 min-w-[170px] max-w-[250px]">
        {operationalSummary.currentBlocker ? (
          <span
            className="inline-block bg-rose-50 text-rose-800 border border-rose-200 rounded px-1.5 py-0.5 text-xs font-medium truncate max-w-full"
            title={operationalSummary.currentBlocker}
          >
            🛑 {operationalSummary.currentBlocker}
          </span>
        ) : (
          <span className="text-gray-400 text-xs">—</span>
        )}
      </td>

      {/* 7. WAITING FOR */}
      <td className="px-2.5 py-2 border-r border-gray-200 whitespace-nowrap">
        <span
          className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold border ${waitingColor}`}
          title={operationalSummary.waitingForSummary}
        >
          {operationalSummary.waitingForSummary || 'None'}
        </span>
      </td>

      {/* 8. NEXT ACTION */}
      <td className="px-3 py-2 border-r border-gray-200 min-w-[160px] max-w-[240px]">
        {operationalSummary.nextAction ? (
          <div className="flex items-center gap-1 text-xs text-blue-800 font-medium truncate" title={operationalSummary.nextAction}>
            <span className="flex-shrink-0 text-blue-500">👉</span>
            <span className="truncate">{operationalSummary.nextAction}</span>
          </div>
        ) : (
          <span className="text-gray-400 text-xs">—</span>
        )}
      </td>

      {/* 9. OWNER */}
      <td className="px-2.5 py-2 border-r border-gray-200 whitespace-nowrap">
        <InlineEditDropdown
          inquiryId={row.id}
          field="assigned_to"
          currentValue={row.assignedTo}
          displayLabel={row.assignedToName || 'Unassigned'}
          options={userOptions}
          onUpdated={onRefresh}
          canManage={canManage}
        />
      </td>

      {/* 10. REQUESTS */}
      <td className="px-2.5 py-2 border-r border-gray-200 min-w-[120px]">
        <RequestBadges requests={requests} />
      </td>

      {/* 11. STATUS */}
      <td className="px-2.5 py-2 whitespace-nowrap">
        <InlineEditDropdown
          inquiryId={row.id}
          field="pipeline_status"
          currentValue={row.pipelineStatus}
          displayLabel={row.pipelineStatus.toUpperCase().replace('_', ' ')}
          options={pipelineOptionsFormatted}
          onUpdated={onRefresh}
          canManage={canManage}
        />
      </td>
    </tr>
  );
};
