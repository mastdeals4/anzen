import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ParsedTransaction {
  date: string;
  description: string;
  reference: string;
  branchCode: string;
  debitAmount: number;
  creditAmount: number;
  balance: number | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('No authorization header');
    }

    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      throw new Error('Unauthorized');
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const formData = await req.formData();
    const file = formData.get('file') as File;
    const bankAccountId = formData.get('bankAccountId') as string;

    if (!file || !bankAccountId) {
      throw new Error('Missing file or bankAccountId');
    }

    const { data: bankAccount, error: bankError } = await supabase
      .from('bank_accounts')
      .select('currency, account_number, bank_name')
      .eq('id', bankAccountId)
      .single();

    if (bankError || !bankAccount) {
      throw new Error('Bank account not found');
    }

    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    const text = extractTextFromPDF(uint8Array);
    console.log('[INFO] Extracted', text.length, 'chars');
    console.log('[DEBUG] First 1000 chars:', text.substring(0, 1000));

    const parsed = parseBCAStatement(text, bankAccount.currency);

    if (!parsed.transactions || parsed.transactions.length === 0) {
      const debugInfo = {
        textLength: text.length,
        sample: text.substring(0, 1000),
        hasSaldo: text.includes('SALDO'),
        hasPeriode: text.includes('PERIODE'),
        hasDate: /\d{2}\/\d{2}/.test(text),
        dateMatches: text.match(/\d{2}\/\d{2}/g)?.slice(0, 10),
      };
      console.error('[ERROR] No transactions found:', JSON.stringify(debugInfo, null, 2));
      throw new Error('No transactions found in PDF. Please ensure this is a valid BCA bank statement.');
    }

    const fileName = `${bankAccountId}/${Date.now()}_${file.name}`;
    const { error: uploadError } = await supabase.storage
      .from('bank-statements')
      .upload(fileName, file);

    if (uploadError) {
      throw new Error('Failed to upload PDF: ' + uploadError.message);
    }

    const { data: { publicUrl } } = supabase.storage
      .from('bank-statements')
      .getPublicUrl(fileName);

    const { data: upload, error: uploadInsertError } = await supabase
      .from('bank_statement_uploads')
      .insert({
        bank_account_id: bankAccountId,
        statement_period: parsed.period,
        statement_start_date: parsed.startDate,
        statement_end_date: parsed.endDate,
        currency: bankAccount.currency,
        opening_balance: parsed.openingBalance,
        closing_balance: parsed.closingBalance,
        total_credits: parsed.totalCredits,
        total_debits: parsed.totalDebits,
        transaction_count: parsed.transactions.length,
        file_url: publicUrl,
        uploaded_by: user.id,
        status: 'completed',
      })
      .select()
      .single();

    if (uploadInsertError) {
      throw new Error('Failed to create upload record: ' + uploadInsertError.message);
    }

    const lines = parsed.transactions.map((txn) => ({
      upload_id: upload.id,
      bank_account_id: bankAccountId,
      transaction_date: txn.date,
      description: txn.description,
      reference: txn.reference,
      branch_code: txn.branchCode,
      debit_amount: txn.debitAmount,
      credit_amount: txn.creditAmount,
      running_balance: txn.balance,
      currency: bankAccount.currency,
      reconciliation_status: 'unmatched',
      created_by: user.id,
    }));

    const { error: linesError } = await supabase
      .from('bank_statement_lines')
      .insert(lines);

    if (linesError) {
      throw new Error('Failed to insert transactions: ' + linesError.message);
    }

    return new Response(
      JSON.stringify({
        success: true,
        uploadId: upload.id,
        transactionCount: parsed.transactions.length,
        period: parsed.period,
        openingBalance: parsed.openingBalance,
        closingBalance: parsed.closingBalance,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('[ERROR]', error.message);
    return new Response(
      JSON.stringify({ error: error.message || 'Failed to parse PDF' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function extractTextFromPDF(pdfData: Uint8Array): string {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const raw = decoder.decode(pdfData);
  const parts: string[] = [];

  const textPattern = /\(([^)]+)\)/g;
  let match;
  while ((match = textPattern.exec(raw)) !== null) {
    let text = match[1];
    text = text
      .replace(/\\n/g, ' ')
      .replace(/\\r/g, '')
      .replace(/\\t/g, ' ')
      .replace(/\\\\/g, '\\')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')');
    parts.push(text);
  }

  return parts.join(' ');
}

function parseBCAStatement(text: string, currency: string) {
  text = text.replace(/\s+/g, ' ').trim();

  let period = '';
  let year = new Date().getFullYear();
  let month = 1;

  const periodMatch = text.match(/PERIODE[:\s]+(JANUARI|FEBRUARI|MARET|APRIL|MEI|JUNI|JULI|AGUSTUS|SEPTEMBER|OKTOBER|NOVEMBER|DESEMBER)[\s]+(\d{4})/i);
  if (periodMatch) {
    period = periodMatch[1] + ' ' + periodMatch[2];
    year = parseInt(periodMatch[2]);
    const monthMap: Record<string, number> = {
      JANUARI: 1, FEBRUARI: 2, MARET: 3, APRIL: 4, MEI: 5, JUNI: 6,
      JULI: 7, AGUSTUS: 8, SEPTEMBER: 9, OKTOBER: 10, NOVEMBER: 11, DESEMBER: 12,
    };
    month = monthMap[periodMatch[1].toUpperCase()] || 1;
  }

  let openingBalance = 0;
  const openingMatch = text.match(/SALDO[\s]+AWAL[:\s]*([\d,\.]+)/i);
  if (openingMatch) openingBalance = parseAmount(openingMatch[1]);

  let closingBalance = 0;
  const closingMatch = text.match(/SALDO[\s]+AKHIR[:\s]*([\d,\.]+)/i);
  if (closingMatch) closingBalance = parseAmount(closingMatch[1]);

  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const transactions: ParsedTransaction[] = [];

  const words = text.split(/\s+/);
  console.log(`[PARSE] Split into ${words.length} words`);

  let datesFound = 0;
  for (let i = 0; i < words.length; i++) {
    const dateMatch = words[i].match(/^(\d{2})\/(\d{2})$/);
    if (!dateMatch) continue;
    datesFound++;

    const day = parseInt(dateMatch[1]);
    const mon = parseInt(dateMatch[2]);
    if (day < 1 || day > 31 || mon < 1 || mon > 12) continue;

    let j = i + 1;
    let endPos = Math.min(i + 50, words.length);

    for (let k = i + 1; k < endPos; k++) {
      if (words[k].match(/^\d{2}\/\d{2}$/)) {
        const nextDay = parseInt(words[k].split('/')[0]);
        const nextMon = parseInt(words[k].split('/')[1]);
        if (nextDay >= 1 && nextDay <= 31 && nextMon >= 1 && nextMon <= 12) {
          endPos = k;
          break;
        }
      }
    }

    const txnWords = words.slice(i + 1, endPos);
    const fullText = txnWords.join(' ');

    if (datesFound <= 3) console.log(`[DATE ${day}/${mon}] Text: ${fullText.substring(0, 150)}`);

    if (fullText.match(/TANGGAL|KETERANGAN|CABANG|MUTASI|SALDO|Halaman/i)) {
      if (datesFound <= 3) console.log(`[SKIP] Header keyword found`);
      continue;
    }
    if (fullText.trim().length < 3) {
      if (datesFound <= 3) console.log(`[SKIP] Too short`);
      continue;
    }

    const amounts: number[] = [];
    const amountPattern = /([\d,\.]+)/g;
    let amountMatch;
    while ((amountMatch = amountPattern.exec(fullText)) !== null) {
      const amt = parseAmount(amountMatch[1]);
      if (amt > 0 && amt < 100000000000) {
        amounts.push(amt);
      }
    }

    if (amounts.length === 0) {
      if (datesFound <= 3) console.log(`[SKIP] No valid amounts found`);
      continue;
    }

    if (datesFound <= 3) console.log(`[FOUND] ${amounts.length} amounts: ${amounts.join(', ')}`);

    const isCredit = /\bCR\b/i.test(fullText);

    const amount = amounts[0];
    const balance = amounts.length > 1 ? amounts[amounts.length - 1] : null;

    let reference = '';
    const refMatch = fullText.match(/\d{4}\/[\w\/]+/);
    if (refMatch) {
      reference = refMatch[0];
    }

    let description = fullText.replace(/\s+/g, ' ').trim();

    const fullDate = `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    transactions.push({
      date: fullDate,
      description: description.substring(0, 500),
      reference: reference.substring(0, 100),
      branchCode: '',
      debitAmount: isCredit ? 0 : amount,
      creditAmount: isCredit ? amount : 0,
      balance,
    });

    i = endPos - 1;
  }

  const totalDebits = transactions.reduce((s, t) => s + t.debitAmount, 0);
  const totalCredits = transactions.reduce((s, t) => s + t.creditAmount, 0);

  console.log(`[RESULT] ${transactions.length} txns, DR:${totalDebits.toFixed(2)}, CR:${totalCredits.toFixed(2)}`);

  return {
    period,
    startDate,
    endDate,
    openingBalance,
    closingBalance,
    totalDebits,
    totalCredits,
    transactions,
  };
}

function parseAmount(str: string): number {
  if (!str) return 0;
  let cleaned = str.replace(/[^0-9,\.]/g, '');
  const dots = (cleaned.match(/\./g) || []).length;
  const commas = (cleaned.match(/,/g) || []).length;
  if (dots > 1) cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  else if (commas > 1) cleaned = cleaned.replace(/,/g, '');
  else if (dots === 1 && commas === 1) cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  else if (commas === 1 && dots === 0) cleaned = cleaned.replace(',', '.');
  return parseFloat(cleaned) || 0;
}
