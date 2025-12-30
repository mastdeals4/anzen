import { useState } from 'react';
import { ChevronDown, ChevronRight, CheckSquare, Square } from 'lucide-react';

interface DCItem {
  dc_item_id: string;
  product_id: string;
  product_name: string;
  batch_id: string;
  batch_number: string;
  unit: string;
  pack_size: number;
  pack_type: string;
  number_of_packs: number;
  original_quantity: number;
  remaining_quantity: number;
  purchase_price: number;
  selling_price: number;
  mrp: number;
  is_from_editing: boolean;
}

interface DCWithItems {
  challan_id: string;
  challan_number: string;
  challan_date: string;
  dc_status: string;
  items: DCItem[];
}

interface SelectedDCItem {
  dcItemId: string;
  dcNumber: string;
  selected: boolean;
  quantity: number;
}

interface DCItemSelectorProps {
  pendingDCs: DCWithItems[];
  selectedItems: Map<string, SelectedDCItem>;
  expandedDCs: Set<string>;
  onItemToggle: (dcItem: DCItem, dcNumber: string, checked: boolean) => void;
  onExpandToggle: (dcId: string) => void;
  onSelectAll: (dcId: string, items: DCItem[], dcNumber: string, checked: boolean) => void;
}

export function DCItemSelector({
  pendingDCs,
  selectedItems,
  expandedDCs,
  onItemToggle,
  onExpandToggle,
  onSelectAll
}: DCItemSelectorProps) {
  if (pendingDCs.length === 0) {
    return (
      <div className="text-sm text-gray-500 p-4 bg-gray-50 rounded-lg border border-gray-200">
        No pending delivery challans available for this customer.
        You can add manual items below or create a delivery challan first.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-gray-700 mb-2">
        Select Items from Delivery Challans
      </div>
      <div className="border border-gray-200 rounded-lg divide-y divide-gray-200 max-h-96 overflow-y-auto">
        {pendingDCs.map((dc) => {
          const isExpanded = expandedDCs.has(dc.challan_id);
          const selectedCount = dc.items.filter(item =>
            selectedItems.has(item.dc_item_id)
          ).length;
          const allSelected = selectedCount === dc.items.length && dc.items.length > 0;
          const someSelected = selectedCount > 0 && !allSelected;

          return (
            <div key={dc.challan_id} className="bg-white">
              <div className="p-3 flex items-center justify-between hover:bg-gray-50">
                <div className="flex items-center gap-3 flex-1">
                  <button
                    type="button"
                    onClick={() => onExpandToggle(dc.challan_id)}
                    className="text-gray-500 hover:text-gray-700"
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-5 h-5" />
                    ) : (
                      <ChevronRight className="w-5 h-5" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => onSelectAll(dc.challan_id, dc.items, dc.challan_number, !allSelected)}
                    className="text-blue-600 hover:text-blue-700"
                  >
                    {allSelected ? (
                      <CheckSquare className="w-5 h-5" />
                    ) : someSelected ? (
                      <div className="w-5 h-5 border-2 border-blue-600 bg-blue-100 rounded"></div>
                    ) : (
                      <Square className="w-5 h-5" />
                    )}
                  </button>

                  <div className="flex-1">
                    <div className="font-medium text-gray-900">
                      {dc.challan_number}
                    </div>
                    <div className="text-sm text-gray-500">
                      {new Date(dc.challan_date).toLocaleDateString()} • {selectedCount}/{dc.items.length} items selected
                    </div>
                  </div>

                  <div>
                    {dc.dc_status === 'fully_invoiced' && (
                      <span className="px-2 py-1 text-xs font-medium bg-gray-100 text-gray-600 rounded">
                        Fully Invoiced
                      </span>
                    )}
                    {dc.dc_status === 'partially_invoiced' && (
                      <span className="px-2 py-1 text-xs font-medium bg-yellow-100 text-yellow-700 rounded">
                        Partially Invoiced
                      </span>
                    )}
                    {dc.dc_status === 'not_invoiced' && (
                      <span className="px-2 py-1 text-xs font-medium bg-green-100 text-green-700 rounded">
                        Not Invoiced
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {isExpanded && (
                <div className="bg-gray-50 border-t border-gray-200">
                  <div className="divide-y divide-gray-200">
                    {dc.items.map((item) => {
                      const isSelected = selectedItems.has(item.dc_item_id);

                      return (
                        <div
                          key={item.dc_item_id}
                          className="p-3 pl-12 flex items-center gap-3 hover:bg-gray-100"
                        >
                          <button
                            type="button"
                            onClick={() => onItemToggle(item, dc.challan_number, !isSelected)}
                            className="text-blue-600 hover:text-blue-700"
                          >
                            {isSelected ? (
                              <CheckSquare className="w-4 h-4" />
                            ) : (
                              <Square className="w-4 h-4" />
                            )}
                          </button>

                          <div className="flex-1 grid grid-cols-4 gap-4">
                            <div>
                              <div className="text-sm font-medium text-gray-900">
                                {item.product_name}
                              </div>
                              <div className="text-xs text-gray-500">
                                Batch: {item.batch_number}
                              </div>
                            </div>

                            <div className="text-sm text-gray-600">
                              {item.remaining_quantity} {item.unit}
                              {item.is_from_editing && (
                                <span className="ml-2 text-xs text-blue-600">(editing)</span>
                              )}
                            </div>

                            <div className="text-sm text-gray-600">
                              ₹{item.selling_price.toFixed(2)} / {item.unit}
                            </div>

                            <div className="text-sm font-medium text-gray-900">
                              ₹{(item.remaining_quantity * item.selling_price).toFixed(2)}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
