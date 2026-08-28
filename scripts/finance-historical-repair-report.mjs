import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const useLinkedProject = process.argv.includes('--linked');
const databaseUrl = process.env.FINANCE_DATABASE_URL;
if (!useLinkedProject && !databaseUrl) {
  console.error('Use --linked or set FINANCE_DATABASE_URL to a service-role PostgreSQL connection string.');
  process.exit(2);
}

let client;
const query = async (sql, params = []) => {
  if (useLinkedProject) {
    if (params.length) throw new Error('Parameterized queries are not supported in --linked mode.');
    const stdout = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', sql], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 100 * 1024 * 1024,
    });
    const response = JSON.parse(stdout);
    if (response.error) throw new Error(response.error.message ?? JSON.stringify(response.error));
    return { rows: response.rows ?? [] };
  }
  return client.query(sql, params);
};

const sqlLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
const csv = value => `"${String(value ?? '').replaceAll('"', '""').replaceAll('\n', ' ')}"`;
const md = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const businessReason = reason => {
  if (reason.includes('No unique authoritative relationship')) return 'Required currency, payment method, or bank details cannot be confirmed from the historical records.';
  if (reason.includes('USD currency is certain') || reason.includes('USD transaction currency is proven')) return 'The transaction is confirmed as USD, but the original transaction-date exchange rate is missing.';
  if (reason.includes('Approved expense has no active journal')) return 'The approved expense has no active journal entry.';
  if (reason.includes('metadata conflicts with its unique reconciliation bank line')) return 'The voucher details conflict with the linked bank transaction.';
  if (reason.includes('Legacy USD-source Contra')) return 'The USD transfer used legacy currency posting logic; changing it directly would alter posted accounting history.';
  if (reason.includes('Journal metadata cannot be derived')) return 'The journal source document or currency details cannot be confirmed from the historical records.';
  if (reason.includes('Linked document has no provable active journal')) return 'The bank transaction is linked to a document, but no active journal entry can be confirmed.';
  if (reason.includes('does not use the Expense bank account') || reason.includes('does not post to this bank account')) return 'The voucher is linked to a bank transaction, but its journal was posted to Cash on Hand or another account instead of the bank account.';
  if (reason.includes('multiple typed document links')) return 'The bank transaction is linked to more than one Finance document.';
  return reason;
};
const businessAction = (reason, fallback) => {
  if (reason.includes('No unique authoritative relationship')) return 'Review the original voucher and bank statement, then enter the confirmed currency, payment method, and bank account.';
  if (reason.includes('USD currency is certain') || reason.includes('USD transaction currency is proven')) return 'Check the original bank statement or supporting document and enter the actual transaction-date exchange rate.';
  if (reason.includes('Approved expense has no active journal')) return 'Keep the expense. Finance should create or relink the correct journal entry after checking the supporting documents.';
  if (reason.includes('metadata conflicts with its unique reconciliation bank line')) return 'Compare the voucher with the bank transaction, then correct the voucher details or relink it manually.';
  if (reason.includes('Legacy USD-source Contra')) return 'Keep the posted transfer. An accountant must decide whether to post a correcting entry or formally reverse and repost it.';
  if (reason.includes('Journal metadata cannot be derived')) return 'Find the original source document and manually relink the journal or complete its currency details.';
  if (reason.includes('Linked document has no provable active journal')) return 'Relink the correct active journal, or create it through the original Finance module after verification.';
  if (reason.includes('does not use the Expense bank account') || reason.includes('does not post to this bank account')) return 'Keep the record. An accountant should post a correcting/reclassification journal or formally reverse and repost it.';
  if (reason.includes('multiple typed document links')) return 'Confirm which Finance document owns the bank transaction, then keep only that link.';
  return fallback;
};

try {
  if (!useLinkedProject) {
    client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  }

  const requestedRun = process.argv.find(argument => argument.startsWith('--run-id='))?.split('=')[1];
  const runResult = requestedRun
    ? { rows: [{ run_id: requestedRun }] }
    : await query('SELECT run_id FROM public.finance_historical_repair_summary ORDER BY started_at DESC LIMIT 1');
  const runId = runResult.rows[0]?.run_id;
  if (!runId) throw new Error('No historical repair run exists.');
  const runFilter = useLinkedProject ? sqlLiteral(runId) : '$1';
  const params = useLinkedProject ? [] : [runId];

  const summary = await query(
    `SELECT * FROM public.finance_historical_repair_summary WHERE run_id=${runFilter}`,
    params,
  );
  const exceptions = await query(
    `SELECT * FROM public.finance_historical_repair_exception_details
      WHERE run_id=${runFilter}
      ORDER BY classification,document_type,date,document_number,database_id,exact_problem`,
    params,
  );
  const repairs = await query(
    `SELECT document_number,document_type,document_id AS database_id,repaired_fields,
            old_metadata,new_metadata,repair_reason,repaired_at
       FROM public.finance_historical_repair_items
      WHERE run_id=${runFilter} ORDER BY document_type,document_number,document_id,id`,
    params,
  );
  const verificationFailures = await query(
    `SELECT * FROM public.finance_historical_repair_verification_failures
      WHERE run_id=${runFilter} ORDER BY document_type,document_number,database_id`,
    params,
  );
  const classificationCounts = await query(
    `SELECT classification,count(DISTINCT (document_type,database_id)) AS records
       FROM public.finance_historical_repair_exception_details
      WHERE run_id=${runFilter} GROUP BY classification ORDER BY classification`,
    params,
  );

  if (!useLinkedProject) await client.query('COMMIT');

  const exceptionRecords = new Set(exceptions.rows.map(row => `${row.document_type}:${row.database_id}`)).size;
  const safeToRecreate = new Set(exceptions.rows
    .filter(row => row.safe_to_delete_and_recreate)
    .map(row => `${row.document_type}:${row.database_id}`)).size;
  const output = {
    generated_at: new Date().toISOString(),
    run_id: runId,
    summary: summary.rows[0],
    exception_summary: {
      manual_review_records: exceptionRecords,
      exception_rows: exceptions.rows.length,
      safe_to_delete_and_recreate: safeToRecreate,
      by_classification: Object.fromEntries(classificationCounts.rows.map(row => [row.classification, Number(row.records)])),
      verification_failures: verificationFailures.rows.length,
    },
    exceptions: exceptions.rows,
    automatic_repair_items: repairs.rows,
    report_verification_failures: verificationFailures.rows,
  };

  const outputDirectory = resolve(process.cwd(), 'finance-repair-output');
  mkdirSync(outputDirectory, { recursive: true });
  const stem = `finance-production-cleanup-${runId}`;
  const jsonPath = resolve(outputDirectory, `${stem}.json`);
  const csvPath = resolve(outputDirectory, `${stem}-exceptions.csv`);
  const businessCsvPath = resolve(outputDirectory, `${stem}-business-exceptions.csv`);
  const markdownPath = resolve(outputDirectory, `${stem}.md`);

  writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`);

  const csvColumns = [
    'document_type','document_number','database_id','date','amount','currency','customer_supplier',
    'bank_account','journal_number','exact_problem_fields','exact_problem','why_cannot_repair_automatically',
    'recommended_action','classification','safe_to_delete_and_recreate','disposition',
  ];
  writeFileSync(csvPath, `${csvColumns.join(',')}\n${exceptions.rows
    .map(row => csvColumns.map(column => csv(row[column])).join(','))
    .join('\n')}\n`);

  const businessExceptions = new Map();
  for (const row of exceptions.rows) {
    const key = `${row.document_type}:${row.database_id}`;
    const current = businessExceptions.get(key) ?? {
      voucher_number: row.document_number && row.document_number !== '(none)'
        ? row.document_number
        : row.journal_number || 'No voucher number',
      date: row.date ?? '',
      amount: row.amount == null
        ? ''
        : `${row.currency ?? 'Unknown'} ${Number(row.amount).toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`,
      reasons: new Set(),
      actions: new Set(),
    };
    current.reasons.add(businessReason(row.exact_problem));
    current.actions.add(businessAction(row.exact_problem, row.recommended_action));
    businessExceptions.set(key, current);
  }
  const businessColumns = ['Voucher No.','Date','Amount','Why it is flagged','Recommended action'];
  const businessRows = [...businessExceptions.values()].map(row => [
    row.voucher_number,
    row.date,
    row.amount,
    [...row.reasons].join('; '),
    [...row.actions].join('; '),
  ]);
  writeFileSync(businessCsvPath, `${businessColumns.map(csv).join(',')}\n${businessRows
    .map(row => row.map(csv).join(','))
    .join('\n')}\n`);

  const s = summary.rows[0];
  const markdownRows = exceptions.rows.map(row =>
    `| ${md(row.document_type)} | ${md(row.document_number)} | ${md(row.database_id)} | ${md(row.date)} | ${md(row.amount)} | ${md(row.currency)} | ${md(row.customer_supplier)} | ${md(row.bank_account)} | ${md(row.journal_number)} | ${md(row.exact_problem)} | ${md(row.why_cannot_repair_automatically)} | ${md(row.recommended_action)} | ${md(row.classification)} | ${row.safe_to_delete_and_recreate ? 'Yes' : 'No'} |`,
  );
  const markdown = `# Finance Production Cleanup Exception Report

Run ID: \`${runId}\`

Generated: ${output.generated_at}

## Summary

- Total Finance records scanned: ${s.total_records_scanned}
- Fully repaired automatically: ${s.records_repaired}
- Partially repaired, then flagged for review: ${s.records_partially_repaired}
- Manual review required: ${s.records_manual_review}
- Clean records skipped: ${s.records_skipped}
- Safe to delete and recreate: ${safeToRecreate}
- Verification failures: ${verificationFailures.rows.length} (all are represented below as exceptions)

## Classification

${classificationCounts.rows.map(row => `- ${row.classification}: ${row.records}`).join('\n')}

## Complete Exception Report

| Document Type | Document Number | Database ID | Date | Amount | Currency | Customer/Supplier | Bank Account | Journal Number | Exact Problem | Why It Cannot Be Repaired Automatically | Recommended Action | Classification | Safe to Delete and Recreate |
|---|---|---|---|---:|---|---|---|---|---|---|---|---|---|
${markdownRows.join('\n')}
`;
  writeFileSync(markdownPath, markdown);

  console.log(JSON.stringify({
    run_id: runId,
    summary: s,
    exception_summary: output.exception_summary,
    files: { json: jsonPath, csv: csvPath, business_csv: businessCsvPath, markdown: markdownPath },
  }, null, 2));
} catch (error) {
  if (client) await client.query('ROLLBACK').catch(() => undefined);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (client) await client.end().catch(() => undefined);
}
