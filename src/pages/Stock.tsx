import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { useLanguage } from '../contexts/LanguageContext';
import { supabase } from '../lib/supabase';
import { Package, AlertTriangle, Search, ChevronDown, ChevronUp } from 'lucide-react';
import { useNavigation } from '../contexts/NavigationContext';
import { formatDate } from '../utils/dateFormat';
import { StockDrillDownModal } from '../components/StockDrillDownModal';

interface StockSummary {
  product_id: string;
  product_name: string;
  product_code: string;
  unit: string;
  category: string;
  min_stock_level: number | null;
  total_current_stock: number;
  reserved_stock: number;
  shortage_quantity: number;
  available_quantity: number;
  active_batch_count: number;
  expired_batch_count: number;
  nearest_expiry_date: string | null;
}

export function Stock() {
  const { t } = useLanguage();
  const { setCurrentPage } = useNavigation();
  const [stockSummary, setStockSummary] = useState<StockSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedProduct, setSelectedProduct] = useState<StockSummary | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);

  useEffect(() => {
    loadStockSummary();
  }, []);

  const loadStockSummary = async () => {
    try {
      const { data, error } = await supabase
        .from('inventory_v1_stock_summary')
        .select('*')
        .order('product_name');

      if (error) throw error;

      const filteredProducts = (data || []).filter(
        p => p.total_current_stock > 0 || p.reserved_stock > 0 || p.shortage_quantity > 0
      );

      setStockSummary(filteredProducts);
    } catch (error) {
      console.error('Error loading stock summary:', error);
    } finally {
      setLoading(false);
    }
  };

  const isExpired = (expiryDate: string | null) => {
    if (!expiryDate) return false;
    return new Date(expiryDate) < new Date();
  };

  const isNearExpiry = (expiryDate: string | null) => {
    if (!expiryDate) return false;
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
    return new Date(expiryDate) <= thirtyDaysFromNow && !isExpired(expiryDate);
  };

  const handleSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig?.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const filteredData = (() => {
    let result = [...stockSummary];
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(item =>
        item.product_name.toLowerCase().includes(term) ||
        item.product_code?.toLowerCase().includes(term) ||
        item.category?.toLowerCase().includes(term)
      );
    }
    if (sortConfig) {
      result.sort((a, b) => {
        const aVal = (a as any)[sortConfig.key];
        const bVal = (b as any)[sortConfig.key];
        if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
      });
    }
    return result;
  })();

  const totalStock = stockSummary.reduce((sum, item) => sum + item.total_current_stock, 0);
  const totalProducts = stockSummary.length;
  const lowStockProducts = stockSummary.filter(item =>
    (item.min_stock_level ?? 0) > 0 && item.total_current_stock < (item.min_stock_level ?? 0)
  ).length;
  const productsWithNearExpiry = stockSummary.filter(item =>
    item.nearest_expiry_date && isNearExpiry(item.nearest_expiry_date)
  ).length;

  const SortIcon = ({ columnKey }: { columnKey: string }) => {
    if (sortConfig?.key !== columnKey) return <ChevronDown className="w-3 h-3 opacity-30 inline ml-0.5" />;
    return sortConfig.direction === 'asc'
      ? <ChevronUp className="w-3 h-3 inline ml-0.5" />
      : <ChevronDown className="w-3 h-3 inline ml-0.5" />;
  };

  return (
    <Layout>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-900">{t('stock.title')}</h1>
          <button
            onClick={() => setCurrentPage('batches')}
            className="flex items-center gap-1.5 bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 transition text-sm"
          >
            <Package className="w-4 h-4" />
            View Batches
          </button>
        </div>

        <div className="grid grid-cols-4 gap-3">
          <div className="bg-blue-600 rounded-lg p-3 text-white">
            <p className="text-blue-100 text-xs">Products In Stock</p>
            <p className="text-xl font-bold">{totalProducts}</p>
          </div>
          <div className="bg-green-600 rounded-lg p-3 text-white">
            <p className="text-green-100 text-xs">Total Stock</p>
            <p className="text-xl font-bold">{totalStock.toLocaleString()}</p>
          </div>
          <div className="bg-orange-500 rounded-lg p-3 text-white">
            <p className="text-orange-100 text-xs">Low Stock</p>
            <p className="text-xl font-bold">{lowStockProducts}</p>
          </div>
          <div className="bg-red-500 rounded-lg p-3 text-white">
            <p className="text-red-100 text-xs">Near Expiry</p>
            <p className="text-xl font-bold">{productsWithNearExpiry}</p>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-sm border">
          <div className="p-2 border-b">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search products..."
                className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
            </div>
          </div>

          {loading ? (
            <div className="p-6 text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" />
              <p className="mt-2 text-gray-500 text-sm">Loading...</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="text-left px-3 py-1.5 text-[11px] font-medium text-gray-500 uppercase cursor-pointer" onClick={() => handleSort('product_name')}>
                      Product <SortIcon columnKey="product_name" />
                    </th>
                    <th className="text-right px-3 py-1.5 text-[11px] font-medium text-gray-500 uppercase cursor-pointer" onClick={() => handleSort('total_current_stock')}>
                      Stock <SortIcon columnKey="total_current_stock" />
                    </th>
                    <th className="text-right px-3 py-1.5 text-[11px] font-medium text-gray-500 uppercase">Reserved</th>
                    <th className="text-right px-3 py-1.5 text-[11px] font-medium text-gray-500 uppercase">Available</th>
                    <th className="text-center px-3 py-1.5 text-[11px] font-medium text-gray-500 uppercase">Batches</th>
                    <th className="text-right px-3 py-1.5 text-[11px] font-medium text-gray-500 uppercase">Nearest Expiry</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredData.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-6 text-center text-gray-400 text-sm">
                        <Package className="w-10 h-10 mx-auto mb-2 text-gray-300" />
                        No stock available
                      </td>
                    </tr>
                  ) : (
                    filteredData.map((item) => (
                      <tr
                        key={item.product_id}
                        onClick={() => setSelectedProduct(item)}
                        className="cursor-pointer hover:bg-blue-50 transition-colors group"
                        title="Click to view batch & reservation details"
                      >
                        <td className="px-3 py-2 text-sm">
                          <span className="font-medium text-gray-900 group-hover:text-blue-700 transition-colors">{item.product_name}</span>
                          <span className="text-[10px] text-gray-400 ml-1.5 capitalize">({item.category})</span>
                        </td>
                        <td className={`px-3 py-2 text-sm text-right font-semibold ${item.total_current_stock === 0 ? 'text-gray-400' : item.total_current_stock < 500 ? 'text-orange-600' : 'text-green-600'}`}>
                          {item.total_current_stock.toLocaleString()} {item.unit}
                        </td>
                        <td className="px-3 py-2 text-sm text-right">
                          {item.reserved_stock === 0 && !item.shortage_quantity ? (
                            <span className="text-gray-300">-</span>
                          ) : (
                            <div className="flex flex-col items-end gap-0.5">
                              {item.reserved_stock > 0 && (
                                <span className="text-orange-600">{item.reserved_stock.toLocaleString()} {item.unit}</span>
                              )}
                              {item.shortage_quantity > 0 && (
                                <span className="text-red-600 text-xs font-semibold">-{item.shortage_quantity.toLocaleString()} shortage</span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-sm text-right font-semibold text-green-600">
                          {item.available_quantity.toLocaleString()} {item.unit}
                        </td>
                        <td className="px-3 py-2 text-sm text-center">
                          <span className="text-blue-600 font-medium">{item.active_batch_count}</span>
                          {item.expired_batch_count > 0 && (
                            <span className="text-red-500 ml-0.5 text-xs">({item.expired_batch_count} exp)</span>
                          )}
                        </td>
                        <td className={`px-3 py-2 text-sm text-right ${
                          item.nearest_expiry_date && isExpired(item.nearest_expiry_date) ? 'text-red-700 font-semibold' :
                          item.nearest_expiry_date && isNearExpiry(item.nearest_expiry_date) ? 'text-orange-600 font-semibold' :
                          'text-gray-600'
                        }`}>
                          {item.nearest_expiry_date ? formatDate(item.nearest_expiry_date) : '-'}
                          {item.nearest_expiry_date && isNearExpiry(item.nearest_expiry_date) && (
                            <AlertTriangle className="w-3 h-3 inline ml-0.5" />
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {selectedProduct && (
        <StockDrillDownModal
          product={selectedProduct}
          onClose={() => setSelectedProduct(null)}
        />
      )}
    </Layout>
  );
}
