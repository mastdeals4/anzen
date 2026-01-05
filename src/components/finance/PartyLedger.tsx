import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { Users, Building2, Download, Mail, RefreshCw } from 'lucide-react';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

interface Party {
  id: string;
  name: string;
  type: 'customer' | 'supplier';
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  npwp?: string;
}

interface LedgerEntry {
  id: string;
  entry_date: string;
  particulars: string;
  reference: string;
  debit: number;
  credit: number;
  running_balance: number;
  type: 'invoice' | 'payment' | 'receipt' | 'opening';
}

export default function PartyLedger() {
  const printRef = useRef<HTMLDivElement>(null);
  const [partyType, setPartyType] = useState<'customer' | 'supplier'>('customer');
  const [parties, setParties] = useState<Party[]>([]);
  const [selectedParty, setSelectedParty] = useState<string>('');
  const [ledgerEntries, setLedgerEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [dateRange, setDateRange] = useState({
    start: new Date(new Date().getFullYear(), 3, 1).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0],
  });
  const [openingBalance, setOpeningBalance] = useState(0);
  const [sendingEmail, setSendingEmail] = useState(false);

  useEffect(() => {
    loadParties();
  }, [partyType]);

  useEffect(() => {
    if (selectedParty) {
      loadLedgerEntries();
    } else {
      setLedgerEntries([]);
      setOpeningBalance(0);
    }
  }, [selectedParty, dateRange]);

  const loadParties = async () => {
    const tableName = partyType === 'customer' ? 'customers' : 'suppliers';
    const nameField = 'company_name';

    const { data } = await supabase
      .from(tableName)
      .select('id, company_name, email, phone, address, city, npwp')
      .order('company_name');

    if (data) {
      setParties(data.map(p => ({
        ...p,
        name: p.company_name,
        type: partyType
      })));
    }
    setSelectedParty('');
  };

  const loadLedgerEntries = async () => {
    if (!selectedParty) return;

    setLoading(true);
    try {
      const entries: LedgerEntry[] = [];

      if (partyType === 'customer') {
        const { data: invoices } = await supabase
          .from('sales_invoices')
          .select('id, invoice_date, invoice_number, total_amount, payment_status')
          .eq('customer_id', selectedParty)
          .gte('invoice_date', dateRange.start)
          .lte('invoice_date', dateRange.end)
          .order('invoice_date');

        if (invoices) {
          invoices.forEach(inv => {
            entries.push({
              id: inv.id,
              entry_date: inv.invoice_date,
              particulars: `Sales Invoice - ${inv.payment_status || 'Unpaid'}`,
              reference: inv.invoice_number,
              debit: inv.total_amount,
              credit: 0,
              running_balance: 0,
              type: 'invoice',
            });
          });
        }

        const { data: receipts } = await supabase
          .from('receipt_vouchers')
          .select('id, voucher_date, voucher_number, amount, description')
          .eq('customer_id', selectedParty)
          .gte('voucher_date', dateRange.start)
          .lte('voucher_date', dateRange.end)
          .order('voucher_date');

        if (receipts) {
          receipts.forEach(rec => {
            entries.push({
              id: rec.id,
              entry_date: rec.voucher_date,
              particulars: rec.description || 'Receipt',
              reference: rec.voucher_number,
              debit: 0,
              credit: rec.amount,
              running_balance: 0,
              type: 'receipt',
            });
          });
        }

        const { data: creditNotes } = await supabase
          .from('credit_notes')
          .select('id, credit_note_date, credit_note_number, total_amount')
          .eq('customer_id', selectedParty)
          .gte('credit_note_date', dateRange.start)
          .lte('credit_note_date', dateRange.end)
          .eq('status', 'approved')
          .order('credit_note_date');

        if (creditNotes) {
          creditNotes.forEach(cn => {
            entries.push({
              id: cn.id,
              entry_date: cn.credit_note_date,
              particulars: 'Credit Note',
              reference: cn.credit_note_number,
              debit: 0,
              credit: cn.total_amount,
              running_balance: 0,
              type: 'receipt',
            });
          });
        }
      } else {
        const { data: invoices } = await supabase
          .from('purchase_invoices')
          .select('id, invoice_date, invoice_number, total_amount, payment_status')
          .eq('supplier_id', selectedParty)
          .gte('invoice_date', dateRange.start)
          .lte('invoice_date', dateRange.end)
          .order('invoice_date');

        if (invoices) {
          invoices.forEach(inv => {
            entries.push({
              id: inv.id,
              entry_date: inv.invoice_date,
              particulars: `Purchase Invoice - ${inv.payment_status || 'Unpaid'}`,
              reference: inv.invoice_number,
              debit: 0,
              credit: inv.total_amount,
              running_balance: 0,
              type: 'invoice',
            });
          });
        }

        const { data: payments } = await supabase
          .from('payment_vouchers')
          .select('id, voucher_date, voucher_number, amount, description')
          .eq('supplier_id', selectedParty)
          .gte('voucher_date', dateRange.start)
          .lte('voucher_date', dateRange.end)
          .order('voucher_date');

        if (payments) {
          payments.forEach(pay => {
            entries.push({
              id: pay.id,
              entry_date: pay.voucher_date,
              particulars: pay.description || 'Payment',
              reference: pay.voucher_number,
              debit: pay.amount,
              credit: 0,
              running_balance: 0,
              type: 'payment',
            });
          });
        }
      }

      entries.sort((a, b) => new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime());

      let runningBalance = openingBalance;
      entries.forEach(entry => {
        runningBalance += entry.debit - entry.credit;
        entry.running_balance = runningBalance;
      });

      setLedgerEntries(entries);
    } catch (err) {
      console.error('Error loading ledger:', err);
      alert('Failed to load ledger data. Please check console for details.');
    } finally {
      setLoading(false);
    }
  };

  const formatAmount = (amount: number) => {
    if (amount === 0) return '-';
    return `Rp ${amount.toLocaleString('id-ID', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  };

  const formatBalance = (balance: number) => {
    const absBalance = Math.abs(balance);
    const label = balance >= 0 ? 'Dr' : 'Cr';
    return `${formatAmount(absBalance)} ${label}`;
  };

  const totalDebit = ledgerEntries.reduce((sum, e) => sum + e.debit, 0);
  const totalCredit = ledgerEntries.reduce((sum, e) => sum + e.credit, 0);
  const closingBalance = openingBalance + totalDebit - totalCredit;
  const outstanding = Math.abs(closingBalance);

  const exportToPDF = async () => {
    if (!printRef.current) return;

    try {
      const canvas = await html2canvas(printRef.current, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
        backgroundColor: '#ffffff',
      });

      const imgData = canvas.toDataURL('image/png', 1.0);
      const pdf = new jsPDF('p', 'mm', 'a4');

      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = pdf.internal.pageSize.getHeight();
      const imgWidth = canvas.width;
      const imgHeight = canvas.height;
      const ratio = pdfWidth / imgWidth;
      const scaledHeight = imgHeight * ratio;

      if (scaledHeight > pdfHeight) {
        let position = 0;
        let remainingHeight = scaledHeight;

        while (remainingHeight > 0) {
          pdf.addImage(imgData, 'PNG', 0, position, pdfWidth, scaledHeight);
          remainingHeight -= pdfHeight;
          position -= pdfHeight;

          if (remainingHeight > 0) {
            pdf.addPage();
          }
        }
      } else {
        pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, scaledHeight);
      }

      const selectedPartyData = parties.find(p => p.id === selectedParty);
      pdf.save(`${partyType}_Ledger_${selectedPartyData?.name.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.pdf`);
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Failed to generate PDF. Please try again.');
    }
  };

  const sendStatementOfAccount = async () => {
    const selectedPartyData = parties.find(p => p.id === selectedParty);
    if (!selectedPartyData || !selectedPartyData.email) {
      alert('No email address found for this party');
      return;
    }

    if (!confirm(`Send Statement of Account to ${selectedPartyData.email}?`)) {
      return;
    }

    setSendingEmail(true);
    await exportToPDF();
    alert(`PDF downloaded. Please attach and send to ${selectedPartyData.email}`);
    setSendingEmail(false);
  };

  const selectedPartyData = parties.find(p => p.id === selectedParty);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {partyType === 'customer' ? (
            <Users className="w-5 h-5 text-blue-600" />
          ) : (
            <Building2 className="w-5 h-5 text-purple-600" />
          )}
          <h2 className="text-xl font-semibold text-gray-800">
            {partyType === 'customer' ? 'Customer' : 'Supplier'} Ledger
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadLedgerEntries}
            disabled={!selectedParty || loading}
            className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={exportToPDF}
            disabled={!selectedParty || ledgerEntries.length === 0}
            className="flex items-center gap-2 px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download className="w-4 h-4" />
            Export PDF
          </button>
          <button
            onClick={sendStatementOfAccount}
            disabled={!selectedParty || ledgerEntries.length === 0 || sendingEmail}
            className="flex items-center gap-2 px-3 py-1.5 bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Mail className="w-4 h-4" />
            {sendingEmail ? 'Sending...' : 'Email SOA'}
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm p-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Party Type</label>
            <select
              value={partyType}
              onChange={(e) => {
                setPartyType(e.target.value as 'customer' | 'supplier');
                setSelectedParty('');
              }}
              className="w-full px-3 py-2 border rounded-lg"
            >
              <option value="customer">Customer (Debtor)</option>
              <option value="supplier">Supplier (Creditor)</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Select {partyType === 'customer' ? 'Customer' : 'Supplier'}
            </label>
            <select
              value={selectedParty}
              onChange={(e) => setSelectedParty(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg"
            >
              <option value="">Select Party</option>
              {parties.map(party => (
                <option key={party.id} value={party.id}>
                  {party.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">From Date</label>
            <input
              type="date"
              value={dateRange.start}
              onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">To Date</label>
            <input
              type="date"
              value={dateRange.end}
              onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg"
            />
          </div>
        </div>

        {selectedPartyData && ledgerEntries.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 p-4 bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg">
            <div>
              <p className="text-xs font-medium text-gray-600 uppercase">Opening Balance</p>
              <p className="text-lg font-bold text-gray-900">{formatBalance(openingBalance)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-600 uppercase">Total Debit</p>
              <p className="text-lg font-bold text-red-600">{formatAmount(totalDebit)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-600 uppercase">Total Credit</p>
              <p className="text-lg font-bold text-green-600">{formatAmount(totalCredit)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-600 uppercase">Outstanding</p>
              <p className="text-lg font-bold text-orange-600">{formatAmount(outstanding)}</p>
            </div>
          </div>
        )}
      </div>

      {selectedParty && (
        <>
          {/* Screen View */}
          <div className="bg-white rounded-lg shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                      Date
                    </th>
                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                      Particulars
                    </th>
                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                      Ref No
                    </th>
                    <th className="px-3 py-3 text-right text-xs font-medium text-gray-700 uppercase tracking-wider">
                      Debit (Dr)
                    </th>
                    <th className="px-3 py-3 text-right text-xs font-medium text-gray-700 uppercase tracking-wider">
                      Credit (Cr)
                    </th>
                    <th className="px-3 py-3 text-right text-xs font-medium text-gray-700 uppercase tracking-wider">
                      Balance
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  <tr className="bg-blue-50 font-semibold">
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900" colSpan={3}>
                      Opening Balance
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900 text-right">-</td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900 text-right">-</td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900 text-right font-bold">
                      {formatBalance(openingBalance)}
                    </td>
                  </tr>

                  {loading ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                        Loading entries...
                      </td>
                    </tr>
                  ) : ledgerEntries.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                        No transactions found for this period
                      </td>
                    </tr>
                  ) : (
                    ledgerEntries.map(entry => (
                      <tr key={entry.id} className="hover:bg-gray-50">
                        <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900">
                          {new Date(entry.entry_date).toLocaleDateString('id-ID')}
                        </td>
                        <td className="px-3 py-2 text-sm text-gray-900">
                          {entry.particulars}
                        </td>
                        <td className="px-3 py-2 text-sm text-gray-600 font-mono">
                          {entry.reference}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-sm text-red-600 text-right font-medium">
                          {entry.debit > 0 ? formatAmount(entry.debit) : '-'}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-sm text-green-600 text-right font-medium">
                          {entry.credit > 0 ? formatAmount(entry.credit) : '-'}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900 text-right font-semibold">
                          {formatBalance(entry.running_balance)}
                        </td>
                      </tr>
                    ))
                  )}

                  {ledgerEntries.length > 0 && (
                    <tr className="bg-gray-100 font-semibold border-t-2 border-gray-300">
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900" colSpan={3}>
                        Closing Balance
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-red-600 text-right font-bold">
                        {formatAmount(totalDebit)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-green-600 text-right font-bold">
                        {formatAmount(totalCredit)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900 text-right font-bold">
                        {formatBalance(closingBalance)}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* PDF Print Content - Hidden */}
          {selectedPartyData && ledgerEntries.length > 0 && (
            <div style={{ position: 'absolute', left: '-9999px', top: 0 }}>
              <div ref={printRef} style={{ width: '210mm', padding: '20mm', backgroundColor: '#ffffff' }}>
                {/* Header with Company Logo */}
                <div style={{ marginBottom: '15px', borderWidth: '2px', borderColor: '#000', borderStyle: 'solid', padding: '15px' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '15px' }}>
                      <div style={{ width: '60px', height: '60px', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' }}>
                        <svg xmlns="http://www.w3.org/2000/svg" xmlSpace="preserve" width="100%" height="100%" viewBox="0 0 15686.55 15480.24">
                          <g>
                            <path fill="#FDB763" d="M69.94 10438.12l10353.39 0 0 -1798.67 1665.92 0 0 1868.6 0 320.44 0 4552.28c0,38.48 -31.45,69.94 -69.94,69.94l-11949.38 0c-38.48,0 -69.94,-31.45 -69.94,-69.94l0 -4872.72c0,-38.48 31.45,-69.94 69.94,-69.94zm1605.9 1710.15l8737.57 0c13.58,0 24.68,11.11 24.68,24.68l0 1719.84c0,13.58 -11.11,24.68 -24.68,24.68l-8737.57 0c-13.58,0 -24.68,-11.11 -24.68,-24.68l0 -1719.84c0,-13.58 11.11,-24.68 24.68,-24.68z"/>
                            <path fill="#FDB763" d="M15587.15 5136.67l-10353.49 0 0 1822.07 -1665.92 0 0 -1892.9 0 -324.61 0 -4611.43c0,-39 31.45,-70.87 69.94,-70.87l11949.47 0c38.48,0 69.94,31.87 69.94,70.87l0 4936.04c0,39 -31.45,70.83 -69.94,70.83zm-1605.9 -1732.36l-8737.67 0c-13.58,0 -24.68,-11.27 -24.68,-25l0 -1742.21c0,-13.74 11.11,-25 24.68,-25l8737.67 0c13.58,0 24.68,11.27 24.68,25l0 1742.21c0,13.74 -11.11,25 -24.68,25z"/>
                            <polygon fill="#FD6D26" points="-0,0 1651.16,0 1651.16,6929.27 15657.09,6929.27 15657.09,6958.74 15686.55,6958.74 15686.55,15480.24 14022.85,15480.24 14022.85,8639.45 1651.16,8639.45 -0,8639.45 -0,6929.27"/>
                          </g>
                        </svg>
                      </div>
                      <div>
                        <h1 style={{ fontSize: '16px', fontWeight: 'bold', marginBottom: '5px' }}>PT. SHUBHAM ANZEN PHARMA JAYA</h1>
                        <p style={{ fontSize: '11px', margin: '2px 0' }}>Komplek Ruko Metro Sunter Blok A1 NO.15, Jl. Metro Indah Raya,</p>
                        <p style={{ fontSize: '11px', margin: '2px 0' }}>Kelurahan Papanggo, Kec. Tanjung Priok, Jakarta Utara - 14340</p>
                        <p style={{ fontSize: '11px', margin: '2px 0' }}>Telp: (+62 21) 65832426</p>
                        <p style={{ fontSize: '11px', margin: '2px 0' }}>NPWP: 03.174.071.8-093.000</p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Document Title */}
                <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                  <h2 style={{ fontSize: '18px', fontWeight: 'bold', marginBottom: '5px' }}>
                    STATEMENT OF ACCOUNT
                  </h2>
                  <p style={{ fontSize: '12px', color: '#666' }}>
                    Period: {new Date(dateRange.start).toLocaleDateString('id-ID')} to {new Date(dateRange.end).toLocaleDateString('id-ID')}
                  </p>
                </div>

                {/* Party Details */}
                <div style={{ marginBottom: '20px', padding: '12px', backgroundColor: '#f3f4f6', borderRadius: '8px' }}>
                  <p style={{ fontSize: '13px', fontWeight: 'bold', marginBottom: '5px' }}>
                    {partyType === 'customer' ? 'Customer:' : 'Supplier:'} {selectedPartyData.name}
                  </p>
                  {selectedPartyData.address && (
                    <p style={{ fontSize: '11px', margin: '2px 0' }}>{selectedPartyData.address}</p>
                  )}
                  {selectedPartyData.city && (
                    <p style={{ fontSize: '11px', margin: '2px 0' }}>{selectedPartyData.city}</p>
                  )}
                  {selectedPartyData.phone && (
                    <p style={{ fontSize: '11px', margin: '2px 0' }}>Phone: {selectedPartyData.phone}</p>
                  )}
                  {selectedPartyData.npwp && (
                    <p style={{ fontSize: '11px', margin: '2px 0' }}>NPWP: {selectedPartyData.npwp}</p>
                  )}
                </div>

                {/* Summary */}
                <div style={{ marginBottom: '15px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
                  <div style={{ padding: '10px', backgroundColor: '#eff6ff', borderRadius: '6px' }}>
                    <p style={{ fontSize: '10px', fontWeight: '600', color: '#666', marginBottom: '3px' }}>OPENING BALANCE</p>
                    <p style={{ fontSize: '13px', fontWeight: 'bold' }}>{formatBalance(openingBalance)}</p>
                  </div>
                  <div style={{ padding: '10px', backgroundColor: '#fef2f2', borderRadius: '6px' }}>
                    <p style={{ fontSize: '10px', fontWeight: '600', color: '#666', marginBottom: '3px' }}>TOTAL DEBIT</p>
                    <p style={{ fontSize: '13px', fontWeight: 'bold', color: '#dc2626' }}>{formatAmount(totalDebit)}</p>
                  </div>
                  <div style={{ padding: '10px', backgroundColor: '#f0fdf4', borderRadius: '6px' }}>
                    <p style={{ fontSize: '10px', fontWeight: '600', color: '#666', marginBottom: '3px' }}>TOTAL CREDIT</p>
                    <p style={{ fontSize: '13px', fontWeight: 'bold', color: '#16a34a' }}>{formatAmount(totalCredit)}</p>
                  </div>
                  <div style={{ padding: '10px', backgroundColor: '#fff7ed', borderRadius: '6px' }}>
                    <p style={{ fontSize: '10px', fontWeight: '600', color: '#666', marginBottom: '3px' }}>OUTSTANDING</p>
                    <p style={{ fontSize: '13px', fontWeight: 'bold', color: '#ea580c' }}>{formatAmount(outstanding)}</p>
                  </div>
                </div>

                {/* Ledger Table */}
                <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '20px' }}>
                  <thead>
                    <tr style={{ backgroundColor: '#f9fafb', borderBottom: '2px solid #000' }}>
                      <th style={{ padding: '8px', textAlign: 'left', fontSize: '10px', fontWeight: '600', borderRight: '1px solid #e5e7eb' }}>Date</th>
                      <th style={{ padding: '8px', textAlign: 'left', fontSize: '10px', fontWeight: '600', borderRight: '1px solid #e5e7eb' }}>Particulars</th>
                      <th style={{ padding: '8px', textAlign: 'left', fontSize: '10px', fontWeight: '600', borderRight: '1px solid #e5e7eb' }}>Ref No</th>
                      <th style={{ padding: '8px', textAlign: 'right', fontSize: '10px', fontWeight: '600', borderRight: '1px solid #e5e7eb' }}>Debit (Dr)</th>
                      <th style={{ padding: '8px', textAlign: 'right', fontSize: '10px', fontWeight: '600', borderRight: '1px solid #e5e7eb' }}>Credit (Cr)</th>
                      <th style={{ padding: '8px', textAlign: 'right', fontSize: '10px', fontWeight: '600' }}>Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={{ backgroundColor: '#eff6ff', borderBottom: '1px solid #e5e7eb' }}>
                      <td colSpan={3} style={{ padding: '6px 8px', fontSize: '11px', fontWeight: '600' }}>Opening Balance</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: '11px' }}>-</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: '11px' }}>-</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: '11px', fontWeight: 'bold' }}>{formatBalance(openingBalance)}</td>
                    </tr>
                    {ledgerEntries.map(entry => (
                      <tr key={entry.id} style={{ borderBottom: '1px solid #e5e7eb' }}>
                        <td style={{ padding: '6px 8px', fontSize: '10px' }}>{new Date(entry.entry_date).toLocaleDateString('id-ID')}</td>
                        <td style={{ padding: '6px 8px', fontSize: '10px' }}>{entry.particulars}</td>
                        <td style={{ padding: '6px 8px', fontSize: '10px', fontFamily: 'monospace' }}>{entry.reference}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: '10px', color: entry.debit > 0 ? '#dc2626' : '#000' }}>
                          {entry.debit > 0 ? formatAmount(entry.debit) : '-'}
                        </td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: '10px', color: entry.credit > 0 ? '#16a34a' : '#000' }}>
                          {entry.credit > 0 ? formatAmount(entry.credit) : '-'}
                        </td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: '10px', fontWeight: '600' }}>{formatBalance(entry.running_balance)}</td>
                      </tr>
                    ))}
                    <tr style={{ backgroundColor: '#f3f4f6', borderTop: '2px solid #000', borderBottom: '2px solid #000' }}>
                      <td colSpan={3} style={{ padding: '8px', fontSize: '11px', fontWeight: 'bold' }}>Closing Balance</td>
                      <td style={{ padding: '8px', textAlign: 'right', fontSize: '11px', fontWeight: 'bold', color: '#dc2626' }}>{formatAmount(totalDebit)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', fontSize: '11px', fontWeight: 'bold', color: '#16a34a' }}>{formatAmount(totalCredit)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', fontSize: '11px', fontWeight: 'bold' }}>{formatBalance(closingBalance)}</td>
                    </tr>
                  </tbody>
                </table>

                {/* Footer Note */}
                <div style={{ marginTop: '30px', padding: '12px', backgroundColor: '#f9fafb', borderRadius: '8px' }}>
                  <p style={{ fontSize: '11px', color: '#666', marginBottom: '8px' }}>
                    <strong>Note:</strong> This is a computer-generated statement of account.
                  </p>
                  <p style={{ fontSize: '11px', color: '#666' }}>
                    Please review the above transactions and confirm. If you have any questions or discrepancies, please contact us immediately.
                  </p>
                </div>

                {/* Footer */}
                <div style={{ marginTop: '20px', textAlign: 'center', borderTop: '1px solid #e5e7eb', paddingTop: '10px' }}>
                  <p style={{ fontSize: '10px', color: '#999' }}>Generated on {new Date().toLocaleString('id-ID')}</p>
                  <p style={{ fontSize: '10px', color: '#999' }}>PT. SHUBHAM ANZEN PHARMA JAYA</p>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
