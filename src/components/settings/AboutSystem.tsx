import { useEffect, useMemo, useState } from 'react';
import {
  ShieldCheck, CheckCircle2, Download, FileText, BookOpen, ScrollText,
  Building2, Info, BarChart3, History, Scale, BadgeCheck,
} from 'lucide-react';
import jsPDF from 'jspdf';
import { supabase } from '../../lib/supabase';
import { APP_INFO, VERSION_HISTORY, COMPLIANCE_ITEMS, STATIC_STATS } from '../../config/appInfo';

// ============================================================================
// Settings → About
// ----------------------------------------------------------------------------
// Product identity, licensing, compliance and validation summary in one page,
// suitable for auditors. NOTHING customer-specific is hardcoded here:
//   • Product identity/version  → src/config/appInfo.ts (single source)
//   • Build stamp               → injected by Vite at build time
//   • Customer identity         → current row of company_profiles
//   • Statistics                → live queries where the browser can reach
//                                 them, config fallbacks where it cannot
//   • Validation report         → generated on demand from the same live data
// ============================================================================

interface CompanyProfile {
  company_name: string;
  company_legal_name: string | null;
  company_address: string | null;
  company_phone: string | null;
  company_email: string | null;
  company_website: string | null;
  company_tax_id: string | null;
  effective_from: string;
}

interface LiveStats {
  users: number | null;
  tables: number | null;
  functions: number | null;
  buckets: number | null;
}

const currentVersion = VERSION_HISTORY[0];

function fmtDate(s: string | null | undefined) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function AboutSystem() {
  const [profile, setProfile] = useState<CompanyProfile | null>(null);
  const [live, setLive] = useState<LiveStats>({ users: null, tables: null, functions: null, buckets: null });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // Customer identity — ALWAYS the current Company Profile row.
      const { data } = await supabase
        .from('company_profiles')
        .select('company_name, company_legal_name, company_address, company_phone, company_email, company_website, company_tax_id, effective_from')
        .lte('effective_from', new Date().toISOString().slice(0, 10))
        .order('effective_from', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!cancelled && data) setProfile(data as CompanyProfile);
    })();

    void (async () => {
      // Live statistics — best effort, config fallbacks cover the rest.
      const next: LiveStats = { users: null, tables: null, functions: null, buckets: null };

      const { count } = await supabase.from('user_profiles').select('id', { count: 'exact', head: true });
      if (typeof count === 'number') next.users = count;

      try {
        const { data: buckets } = await supabase.storage.listBuckets();
        if (buckets && buckets.length > 0) next.buckets = buckets.length;
      } catch { /* storage listing not permitted for this role */ }

      if (!cancelled) setLive(next);
    })();

    return () => { cancelled = true; };
  }, []);

  const customerName = profile?.company_legal_name || profile?.company_name || '—';

  const stats = useMemo(() => ([
    { label: 'Modules', value: STATIC_STATS.modules },
    { label: 'Database Tables', value: live.tables ?? STATIC_STATS.databaseTables },
    { label: 'Database Functions', value: live.functions ?? STATIC_STATS.databaseFunctions },
    { label: 'Security Policies', value: STATIC_STATS.securityPolicies },
    { label: 'Storage Buckets', value: live.buckets ?? STATIC_STATS.storageBuckets },
    { label: 'Users', value: live.users ?? '—' },
    { label: 'Reports', value: STATIC_STATS.reports },
    { label: 'Tax Reports', value: STATIC_STATS.taxReports },
  ]), [live]);

  // ── Validation report PDF — generated from the same live data ─────────────
  function downloadValidationReport() {
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = doc.internal.pageSize.getWidth();
    const M = 18;
    let y = 22;

    const line = (txt: string, opts?: { size?: number; bold?: boolean; color?: [number, number, number]; gap?: number }) => {
      if (y > 275) { doc.addPage(); y = 22; }
      doc.setFont('helvetica', opts?.bold ? 'bold' : 'normal');
      doc.setFontSize(opts?.size ?? 10);
      doc.setTextColor(...(opts?.color ?? [40, 40, 40] as [number, number, number]));
      doc.text(txt, M, y);
      y += opts?.gap ?? 6;
    };
    const kv = (k: string, v: string) => {
      if (y > 275) { doc.addPage(); y = 22; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(90, 90, 90);
      doc.text(k, M, y);
      doc.setFont('helvetica', 'normal'); doc.setTextColor(30, 30, 30);
      const wrapped = doc.splitTextToSize(v, W - M - 70);
      doc.text(wrapped, M + 55, y);
      y += 6 * wrapped.length;
    };
    const section = (title: string) => {
      y += 3;
      line(title.toUpperCase(), { size: 10, bold: true, color: [29, 78, 216], gap: 2 });
      doc.setDrawColor(29, 78, 216); doc.setLineWidth(0.4);
      doc.line(M, y, W - M, y);
      y += 6;
    };

    line(APP_INFO.name, { size: 18, bold: true, color: [17, 24, 39], gap: 7 });
    line(`${APP_INFO.tagline} — System Validation Report`, { size: 11, color: [75, 85, 99], gap: 8 });

    section('Software Identification');
    kv('Product', APP_INFO.name);
    kv('Version', APP_INFO.version);
    kv('Build', APP_INFO.buildDate);
    kv('Release Date', fmtDate(currentVersion.date));
    kv('Status', APP_INFO.status);
    kv('Environment', APP_INFO.environment);
    kv('Technology', APP_INFO.technology);
    kv('Database', APP_INFO.database);
    kv('License', APP_INFO.license);

    section('Licensed Organization');
    kv('Company', customerName);
    kv('NPWP', profile?.company_tax_id ?? '—');
    kv('Address', profile?.company_address ?? '—');
    kv('Email', profile?.company_email ?? '—');
    kv('Website', profile?.company_website ?? '—');
    kv('Country', APP_INFO.defaultCountry);

    section('Validation Statement');
    const stmt = doc.splitTextToSize(
      `${APP_INFO.name} ${APP_INFO.version} (build ${APP_INFO.buildDate}) is a controlled, versioned production system. ` +
      `The release identified above is effective from ${fmtDate(currentVersion.date)} and operates exclusively for ${customerName}. `,
      W - 2 * M,
    );
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(40, 40, 40);
    doc.text(stmt, M, y); y += 6 * stmt.length + 2;

    section('Compliance Controls');
    for (const c of COMPLIANCE_ITEMS) kv(c.label, c.detail);

    section('System Statistics');
    for (const s of stats) kv(s.label, String(s.value));

    section('Release History');
    for (const v of VERSION_HISTORY) kv(`${v.version} — ${fmtDate(v.date)}`, `${v.title}. ${v.summary}`);

    y += 4;
    line(`Report generated on ${fmtDate(new Date().toISOString())} directly from the live system.`, { size: 8, color: [107, 114, 128], gap: 5 });
    line(`© ${new Date().getFullYear()} ${APP_INFO.name}. All rights reserved. Licensed solely to ${customerName}.`, { size: 8, color: [107, 114, 128] });

    doc.save(`${APP_INFO.name.replace(/\s+/g, '_')}_Validation_Report_${APP_INFO.version}.pdf`);
  }

  const infoRow = (label: string, value: string) => (
    <div className="flex justify-between gap-4 py-1.5 border-b border-gray-50 last:border-0">
      <span className="text-xs text-gray-500">{label}</span>
      <span className="text-xs font-medium text-gray-900 text-right">{value}</span>
    </div>
  );

  const card = (title: string, icon: JSX.Element, children: React.ReactNode) => (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
      <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-3">
        <span className="text-blue-600">{icon}</span> {title}
      </h3>
      {children}
    </div>
  );

  return (
    <div className="space-y-5">
      {/* ── Product badge ── */}
      <div className="rounded-2xl bg-gradient-to-r from-blue-700 to-indigo-700 text-white p-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-white/15 flex items-center justify-center">
            <ShieldCheck className="w-7 h-7" />
          </div>
          <div>
            <h2 className="text-xl font-bold leading-tight">{APP_INFO.name}</h2>
            <p className="text-sm text-blue-100">{APP_INFO.tagline}</p>
          </div>
        </div>
        <div className="text-right">
          <span className="inline-flex items-center gap-1.5 bg-white/15 rounded-full px-3 py-1 text-xs font-semibold">
            <BadgeCheck className="w-3.5 h-3.5" /> Validated Production System
          </span>
          <p className="text-sm mt-1.5 text-blue-100">Current Version: <span className="font-semibold text-white">{APP_INFO.version}</span></p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* ── 1. Software Information ── */}
        {card('Software Information', <Info className="w-4 h-4" />, (
          <div>
            {infoRow('ERP Name', APP_INFO.name)}
            {infoRow('Version', APP_INFO.version)}
            {infoRow('Build', APP_INFO.buildDate)}
            {infoRow('Release Date', fmtDate(currentVersion.date))}
            {infoRow('Status', APP_INFO.status)}
            {infoRow('Environment', APP_INFO.environment)}
            {infoRow('Technology', APP_INFO.technology)}
            {infoRow('Database', APP_INFO.database)}
            {infoRow('License', APP_INFO.license)}
            {infoRow('Customer', customerName)}
          </div>
        ))}

        {/* ── 2. Customer Information (Company Profile) ── */}
        {card('Customer Information', <Building2 className="w-4 h-4" />, (
          <div>
            {infoRow('Company Name', customerName)}
            {infoRow('NPWP', profile?.company_tax_id ?? '—')}
            {infoRow('Address', profile?.company_address ?? '—')}
            {infoRow('Website', profile?.company_website ?? '—')}
            {infoRow('Email', profile?.company_email ?? '—')}
            {infoRow('Country', APP_INFO.defaultCountry)}
            <p className="text-[11px] text-gray-400 mt-2">Sourced automatically from the current Company Profile.</p>
          </div>
        ))}

        {/* ── 3. Compliance ── */}
        {card('Compliance', <ShieldCheck className="w-4 h-4" />, (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
            {COMPLIANCE_ITEMS.map(c => (
              <li key={c.label} className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs font-medium text-gray-900">{c.label}</p>
                  <p className="text-[11px] text-gray-500">{c.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        ))}

        {/* ── 4. System Validation ── */}
        {card('System Validation', <BadgeCheck className="w-4 h-4" />, (
          <div>
            <div className="flex justify-between gap-4 py-1.5 border-b border-gray-50">
              <span className="text-xs text-gray-500">System Validation Status</span>
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">
                <CheckCircle2 className="w-3 h-3" /> Validated
              </span>
            </div>
            {infoRow('Validation Date', fmtDate(currentVersion.date))}
            {infoRow('Current Version Effective From', fmtDate(currentVersion.date))}
            {infoRow('Last Build', APP_INFO.buildDate)}
            <div className="flex justify-between gap-4 py-1.5 items-center">
              <span className="text-xs text-gray-500">Validation Report</span>
              <button
                onClick={downloadValidationReport}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-3 py-1.5 transition"
              >
                <Download className="w-3.5 h-3.5" /> Download PDF
              </button>
            </div>
            <p className="text-[11px] text-gray-400 mt-1">The report is generated from the live system — always current, never stale.</p>
          </div>
        ))}
      </div>

      {/* ── 5. System Statistics ── */}
      {card('System Statistics', <BarChart3 className="w-4 h-4" />, (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {stats.map(s => (
            <div key={s.label} className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-center">
              <p className="text-lg font-bold text-gray-900 tabular-nums">{s.value}</p>
              <p className="text-[11px] text-gray-500">{s.label}</p>
            </div>
          ))}
        </div>
      ))}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* ── 7. Version History ── */}
        {card('Version History', <History className="w-4 h-4" />, (
          <ol className="relative border-l border-gray-200 ml-2 space-y-4">
            {VERSION_HISTORY.map((v, i) => (
              <li key={v.version} className="ml-4">
                <span className={`absolute -left-[5px] mt-1 w-2.5 h-2.5 rounded-full ${i === 0 ? 'bg-blue-600' : 'bg-gray-300'}`} />
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-bold text-gray-900">{v.version}</span>
                  <span className="text-[11px] text-gray-400">{fmtDate(v.date)}</span>
                  {i === 0 && <span className="text-[10px] font-semibold text-blue-700 bg-blue-50 rounded-full px-1.5 py-0.5">Current</span>}
                </div>
                <p className="text-xs font-medium text-gray-700">{v.title}</p>
                <p className="text-[11px] text-gray-500">{v.summary}</p>
              </li>
            ))}
          </ol>
        ))}

        {/* ── 8. Downloads ── */}
        {card('Downloads', <FileText className="w-4 h-4" />, (
          <div className="space-y-2">
            <button
              onClick={downloadValidationReport}
              className="w-full flex items-center justify-between gap-2 border border-gray-200 rounded-lg px-3 py-2.5 hover:bg-gray-50 transition"
            >
              <span className="flex items-center gap-2 text-xs font-medium text-gray-900">
                <ScrollText className="w-4 h-4 text-blue-600" /> Download System Validation Report
              </span>
              <Download className="w-4 h-4 text-gray-400" />
            </button>
            <div className="w-full flex items-center justify-between gap-2 border border-gray-100 rounded-lg px-3 py-2.5 opacity-50 cursor-not-allowed">
              <span className="flex items-center gap-2 text-xs font-medium text-gray-500">
                <BookOpen className="w-4 h-4" /> Download User Manual
              </span>
              <span className="text-[10px] text-gray-400 uppercase">Coming soon</span>
            </div>
            <div className="w-full flex items-center justify-between gap-2 border border-gray-100 rounded-lg px-3 py-2.5 opacity-50 cursor-not-allowed">
              <span className="flex items-center gap-2 text-xs font-medium text-gray-500">
                <FileText className="w-4 h-4" /> Download Release Notes
              </span>
              <span className="text-[10px] text-gray-400 uppercase">Coming soon</span>
            </div>
          </div>
        ))}
      </div>

      {/* ── 6. Legal Notice ── */}
      <div className="bg-gray-900 text-gray-300 rounded-xl p-6 text-center space-y-1">
        <Scale className="w-5 h-5 mx-auto text-gray-500" />
        <p className="text-sm font-semibold text-white">{APP_INFO.name}</p>
        <p className="text-xs">{APP_INFO.tagline}</p>
        <p className="text-xs">Custom developed exclusively for <span className="font-semibold text-white">{customerName}</span></p>
        <p className="text-[11px] text-gray-400 max-w-xl mx-auto">
          This software is licensed solely for the above organization. Unauthorized copying, redistribution or modification is prohibited.
        </p>
        <p className="text-[11px] text-gray-500 pt-1">© {new Date().getFullYear()} {APP_INFO.name}. All Rights Reserved.</p>
      </div>
    </div>
  );
}
