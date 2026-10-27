import React from 'react';

interface CustomerNeedCellProps {
  quantity: string | null;
  specification: string | null;
  requestsRequirement?: string | null;
}

export const CustomerNeedCell: React.FC<CustomerNeedCellProps> = ({
  quantity,
  specification,
  requestsRequirement,
}) => {
  const parts: string[] = [];

  const cleanQty = quantity?.trim();
  const cleanSpec = specification?.trim();
  const cleanReq = requestsRequirement?.trim();

  if (cleanQty) parts.push(cleanQty);
  if (cleanSpec) parts.push(cleanSpec);
  else if (cleanReq && cleanReq !== cleanQty) parts.push(cleanReq);

  if (parts.length === 0) {
    return <span className="text-gray-400 text-xs">—</span>;
  }

  const primaryText = parts.join(' — ');

  return (
    <div className="truncate max-w-[200px]" title={primaryText}>
      <span className="text-xs text-gray-800 font-medium">{primaryText}</span>
    </div>
  );
};
