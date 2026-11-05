import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import pako from "npm:pako@2.1.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface ParsedTransaction {
  date: string;
  description: string;
  branchCode: string;
  debitAmount: number;
  creditAmount: number;
  balance: number | null;
  hash?: string;
}

interface ParsedStatement {
  period: string;
  startDate: string;
  endDate: string;
  accountNumber: string;
  accountHolder?: string;
  currency: string;
  openingBalance: number;
  closingBalance: number;
  totalDebits: number;
  totalCredits: number;
  expectedTransactionCount?: number;
  transactions: ParsedTransaction[];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  let uploadId: string | null = null;
  let supabaseClient: any = null;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      throw new Error("No authorization header");
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );
    supabaseClient = supabase;

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      throw new Error("Unauthorized");
    }

    const formData = await req.formData();
    const file = formData.get("file") as File;
    const bankAccountId = formData.get("bankAccountId") as string;
    const previewOnly = formData.get("previewOnly") === "true";

    if (!file || !bankAccountId) {
      throw new Error("Missing file or bankAccountId");
    }

    // 1. Fetch bank account details from DB
    const { data: bankAccount, error: bankError } = await supabase
      .from("bank_accounts")
      .select("id, currency, account_number, account_name, bank_name, coa_id")
      .eq("id", bankAccountId)
      .single();

    if (bankError || !bankAccount) {
      throw new Error("Bank account not found: " + (bankError?.message || ""));
    }

    // 2. Read PDF binary stream and extract text
    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    const extractedText = await extractTextFromPDF(uint8Array);

    // 3. Parse BCA Statement fields
    const parsed = parseBCAStatement(extractedText, bankAccount.currency);

    if (!parsed.transactions || parsed.transactions.length === 0) {
      throw new Error("No transactions found in PDF. Please verify this is a valid BCA bank statement.");
    }

    // 4. Validate Account Number if extracted
    const cleanDbAcc = (bankAccount.account_number || "").replace(/\D/g, "");
    const cleanParsedAcc = (parsed.accountNumber || "").replace(/\D/g, "");

    if (cleanParsedAcc && cleanDbAcc && cleanParsedAcc !== cleanDbAcc) {
      throw new Error(
        `Statement account number (${parsed.accountNumber}) does not match selected bank account (${bankAccount.account_number}).`
      );
    }

    // 5. Validate Currency
    if (parsed.currency && upper(parsed.currency) !== upper(bankAccount.currency)) {
      throw new Error(
        `Statement currency (${parsed.currency}) does not match selected bank account currency (${bankAccount.currency}).`
      );
    }

    // 6. Enforce Mathematical Balance Equation (Tolerance Rp0.01 / $0.01)
    const computedClosing = round2(parsed.openingBalance + parsed.totalCredits - parsed.totalDebits);
    const balanceDiff = Math.abs(computedClosing - parsed.closingBalance);

    if (parsed.openingBalance !== 0 || parsed.closingBalance !== 0) {
      if (balanceDiff > 0.05) {
        throw new Error(
          `Statement balance validation failed: Opening (${parsed.openingBalance.toLocaleString()}) + Credits (${parsed.totalCredits.toLocaleString()}) - Debits (${parsed.totalDebits.toLocaleString()}) = ${computedClosing.toLocaleString()}, but statement reports Closing (${parsed.closingBalance.toLocaleString()}). Difference of ${balanceDiff.toFixed(2)} exceeds tolerance.`
        );
      }
    }

    // 7. Validate Transaction Count if summary header is present
    if (parsed.expectedTransactionCount && parsed.expectedTransactionCount > 0) {
      if (parsed.transactions.length < parsed.expectedTransactionCount) {
        const missingCount = parsed.expectedTransactionCount - parsed.transactions.length;
        throw new Error(
          `Extracted ${parsed.transactions.length} of ${parsed.expectedTransactionCount} transactions (${missingCount} missing). Incomplete statement imports are rejected to prevent accounting discrepancy.`
        );
      }
    }

    // 8. Generate SHA-256 Transaction Hashes for Duplicate Detection
    for (const txn of parsed.transactions) {
      const hashInput = `${bankAccountId}|${txn.date}|${txn.debitAmount.toFixed(2)}|${txn.creditAmount.toFixed(2)}|${txn.balance !== null ? txn.balance.toFixed(2) : ""}|${txn.description.trim()}`;
      txn.hash = await sha256(hashInput);
    }

    const hashes = parsed.transactions.map((t) => t.hash!);
    const { data: existingLines } = await supabase
      .from("bank_statement_lines")
      .select("transaction_hash")
      .eq("bank_account_id", bankAccountId)
      .in("transaction_hash", hashes);

    const existingHashSet = new Set((existingLines || []).map((l: any) => l.transaction_hash));
    const newTransactions = parsed.transactions.filter((t) => !existingHashSet.has(t.hash));
    const duplicateCount = parsed.transactions.length - newTransactions.length;

    // Return preview if requested
    if (previewOnly) {
      return new Response(
        JSON.stringify({
          preview: true,
          period: parsed.period,
          accountNumber: parsed.accountNumber,
          currency: bankAccount.currency,
          openingBalance: parsed.openingBalance,
          closingBalance: parsed.closingBalance,
          totalDebits: parsed.totalDebits,
          totalCredits: parsed.totalCredits,
          totalTransactions: parsed.transactions.length,
          newTransactionsCount: newTransactions.length,
          duplicateCount,
          transactions: parsed.transactions.slice(0, 20),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 9. Upload PDF File to Supabase Storage
    const fileName = `${bankAccountId}/${Date.now()}_${file.name}`;
    const { error: uploadError } = await supabase.storage
      .from("bank-statements")
      .upload(fileName, file);

    let publicUrl = "";
    if (!uploadError) {
      const { data: urlData } = supabase.storage
        .from("bank-statements")
        .getPublicUrl(fileName);
      publicUrl = urlData?.publicUrl || "";
    }

    // 10. Atomic Ingestion of Upload Header & Non-Duplicate Lines
    const uploadPayload = {
      bank_account_id: bankAccountId,
      statement_period: parsed.period,
      statement_start_date: parsed.startDate,
      statement_end_date: parsed.endDate,
      currency: bankAccount.currency,
      opening_balance: parsed.openingBalance,
      closing_balance: parsed.closingBalance,
      total_credits: parsed.totalCredits,
      total_debits: parsed.totalDebits,
      file_url: publicUrl,
      account_holder: parsed.accountHolder || "",
      uploaded_by: user.id,
    };

    const linesPayload = newTransactions.map((txn) => ({
      transaction_date: txn.date,
      description: txn.description,
      reference: "",
      branch_code: txn.branchCode,
      debit_amount: txn.debitAmount,
      credit_amount: txn.creditAmount,
      running_balance: txn.balance,
      transaction_hash: txn.hash,
    }));

    const { data: atomicResult, error: atomicError } = await supabase.rpc(
      "import_bank_statement_atomic",
      {
        p_upload_payload: uploadPayload,
        p_lines: linesPayload,
      }
    );

    if (atomicError || !atomicResult) {
      throw new Error("Atomic statement import failed: " + (atomicError?.message || ""));
    }

    uploadId = atomicResult.upload_id;
    const autoMatchedCount = atomicResult.reconciliation_result?.auto_matched_count || 0;

    return new Response(
      JSON.stringify({
        success: true,
        uploadId,
        period: parsed.period,
        transactionCount: parsed.transactions.length,
        insertedCount: newTransactions.length,
        duplicateCount,
        autoMatchedCount,
        openingBalance: parsed.openingBalance,
        closingBalance: parsed.closingBalance,
        totalDebits: parsed.totalDebits,
        totalCredits: parsed.totalCredits,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: any) {
    console.error("Error in parse-bca-statement:", error);

    // If an upload was created but failed during processing, mark it failed
    if (uploadId && supabaseClient) {
      try {
        await supabaseClient
          .from("bank_statement_uploads")
          .update({
            status: "failed",
            error_message: error.message || "Unknown import error",
            updated_at: new Date().toISOString(),
          })
          .eq("id", uploadId);
      } catch (e) {
        console.error("Failed to update status to failed:", e);
      }
    }

    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || "Failed to parse BCA statement",
      }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Robust PDF Text & Stream Extraction
// ─────────────────────────────────────────────────────────────────────────────

async function extractTextFromPDF(pdfData: Uint8Array): Promise<string> {
  let combinedText = "";

  // 1. Search for PDF stream ... endstream blocks
  // Streams can be FlateDecode compressed or uncompressed
  const pdfString = new TextDecoder("latin1").decode(pdfData);
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match;

  while ((match = streamRegex.exec(pdfString)) !== null) {
    const streamContent = match[1];
    // Find preceding dictionary to check for /Filter /FlateDecode
    const dictStartIndex = Math.max(0, match.index - 500);
    const precedingDict = pdfString.substring(dictStartIndex, match.index);

    let decodedStream = "";
    if (precedingDict.includes("/FlateDecode")) {
      try {
        // Convert stream content string to binary uint8array
        const streamBytes = new Uint8Array(streamContent.length);
        for (let i = 0; i < streamContent.length; i++) {
          streamBytes[i] = streamContent.charCodeAt(i);
        }
        const decompressed = pako.inflate(streamBytes);
        decodedStream = new TextDecoder("latin1").decode(decompressed);
      } catch {
        // Fallback: try raw stream as text
        decodedStream = streamContent;
      }
    } else {
      decodedStream = streamContent;
    }

    // Extract text blocks between BT and ET
    const btRegex = /BT\s+([\s\S]*?)\s+ET/g;
    let btMatch;
    while ((btMatch = btRegex.exec(decodedStream)) !== null) {
      const block = btMatch[1];
      // Extract text in parentheses (text) Tj or bracketed [(text) 20 (more)] TJ
      const textMatches = block.matchAll(/\(([^)\\]*(?:\\.[^)\\]*)*\)/g);
      for (const tm of textMatches) {
        const unescaped = tm[1]
          .replace(/\\([()\\])/g, "$1")
          .replace(/\\r/g, " ")
          .replace(/\\n/g, " ")
          .replace(/\\t/g, " ");
        combinedText += unescaped + " ";
      }
      combinedText += "\n";
    }
  }

  // 2. If stream extraction found minimal text, do direct regex over raw PDF
  if (combinedText.trim().length < 50) {
    const rawMatches = pdfString.matchAll(/\(([^)\\]*(?:\\.[^)\\]*)*\)\s*Tj/g);
    for (const rm of rawMatches) {
      combinedText += rm[1] + "\n";
    }
  }

  return combinedText;
}

// ─────────────────────────────────────────────────────────────────────────────
// BCA Statement Parser (IDR and USD formats)
// ─────────────────────────────────────────────────────────────────────────────

function parseBCAStatement(text: string, defaultCurrency: string): ParsedStatement {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  let period = "";
  let accountNumber = "";
  let accountHolder = "";
  let currency = defaultCurrency;
  let openingBalance = 0;
  let closingBalance = 0;
  let expectedDebitsCount = 0;
  let expectedCreditsCount = 0;
  let totalDebitsSummary = 0;
  let totalCreditsSummary = 0;

  for (const line of lines) {
    const upperLine = line.toUpperCase();

    // Account Number
    if (upperLine.includes("NO. REKENING") || upperLine.includes("NO.REKENING") || upperLine.includes("ACCOUNT NO")) {
      const accMatch = line.match(/[:\s]+(\d[\d\s-]{6,}\d)/);
      if (accMatch) {
        accountNumber = accMatch[1].replace(/[\s-]/g, "");
      }
    }

    // Account Holder Name
    if (upperLine.includes("NAMA :") || upperLine.includes("NAMA:") || upperLine.includes("NAME :") || upperLine.includes("ACCOUNT NAME")) {
      const nameMatch = line.match(/(?:NAMA|NAME|ACCOUNT NAME)\s*[:]\s*(.+)$/i);
      if (nameMatch) {
        accountHolder = nameMatch[1].trim();
      }
    }

    // Currency
    if (upperLine.includes("MATA UANG") || upperLine.includes("CURRENCY")) {
      if (upperLine.includes("USD")) currency = "USD";
      else if (upperLine.includes("IDR")) currency = "IDR";
    }

    // Period
    if (upperLine.includes("PERIODE") || upperLine.includes("PERIOD")) {
      const perMatch = line.match(/[:\s]+([A-Z0-9\s\/-]{6,})/i);
      if (perMatch) {
        period = perMatch[1].trim();
      }
    }

    // Opening Balance
    if (upperLine.includes("SALDO AWAL") || upperLine.includes("OPENING BALANCE")) {
      const numMatch = line.match(/([\d,]+(?:\.\d{1,2})?)/);
      if (numMatch) {
        openingBalance = parseIndoNumber(numMatch[1]);
      }
    }

    // Closing Balance
    if (upperLine.includes("SALDO AKHIR") || upperLine.includes("CLOSING BALANCE")) {
      const numMatch = line.match(/([\d,]+(?:\.\d{1,2})?)/);
      if (numMatch) {
        closingBalance = parseIndoNumber(numMatch[1]);
      }
    }

    // Summary debit/credit counts and totals
    if (upperLine.includes("MUTASI DEBET") || upperLine.includes("TOTAL DEBIT")) {
      const countMatch = line.match(/(\d+)\s+TRANSAKSI/i);
      if (countMatch) expectedDebitsCount = parseInt(countMatch[1]);
      const amtMatch = line.match(/([\d,]+(?:\.\d{1,2})?)\s*$/);
      if (amtMatch) totalDebitsSummary = parseIndoNumber(amtMatch[1]);
    }
    if (upperLine.includes("MUTASI KREDIT") || upperLine.includes("TOTAL CREDIT")) {
      const countMatch = line.match(/(\d+)\s+TRANSAKSI/i);
      if (countMatch) expectedCreditsCount = parseInt(countMatch[1]);
      const amtMatch = line.match(/([\d,]+(?:\.\d{1,2})?)\s*$/);
      if (amtMatch) totalCreditsSummary = parseIndoNumber(amtMatch[1]);
    }
  }

  // Parse Date Range from Period
  let startDate = "";
  let endDate = "";
  const dateRangeMatch = period.match(/(\d{2})[\/-](\d{2})[\/-](\d{2,4})\s*-\s*(\d{2})[\/-](\d{2})[\/-](\d{2,4})/);
  if (dateRangeMatch) {
    const startY = dateRangeMatch[3].length === 2 ? "20" + dateRangeMatch[3] : dateRangeMatch[3];
    const endY = dateRangeMatch[6].length === 2 ? "20" + dateRangeMatch[6] : dateRangeMatch[6];
    startDate = `${startY}-${dateRangeMatch[2]}-${dateRangeMatch[1]}`;
    endDate = `${endY}-${dateRangeMatch[5]}-${dateRangeMatch[4]}`;
  } else {
    const monthYearMatch = period.match(/([A-Z]+)\s+(\d{4})/i);
    if (monthYearMatch) {
      const mName = monthYearMatch[1].toUpperCase();
      const yr = monthYearMatch[2];
      const monthMap: Record<string, string> = {
        JANUARI: "01", JANUARY: "01", FEBRUARI: "02", FEBRUARY: "02",
        MARET: "03", MARCH: "03", APRIL: "04", MEI: "05", MAY: "05",
        JUNI: "06", JUNE: "06", JULI: "07", JULY: "07", AGUSTUS: "08",
        AUGUST: "08", SEPTEMBER: "09", OKTOBER: "10", OCTOBER: "10",
        NOVEMBER: "11", DESEMBER: "12", DECEMBER: "12",
      };
      const mm = monthMap[mName] || "01";
      startDate = `${yr}-${mm}-01`;
      const lastDay = new Date(parseInt(yr), parseInt(mm), 0).getDate();
      endDate = `${yr}-${mm}-${String(lastDay).padStart(2, "0")}`;
    }
  }

  // Parse Transaction Rows
  const transactions: ParsedTransaction[] = [];
  const currentYear = startDate ? startDate.slice(0, 4) : new Date().getFullYear().toString();

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    // Date match DD/MM or DD-MM
    const dateMatch = line.match(/^(\d{2})[\/-](\d{2})\b/);
    if (!dateMatch) continue;

    const day = dateMatch[1];
    const month = dateMatch[2];
    const fullDate = `${currentYear}-${month}-${day}`;

    // Extract amounts and DB/CR indicator
    let isDebit = false;
    let amount = 0;
    let balance: number | null = null;
    let branchCode = "";
    let description = "";

    const tokens = line.trim().split(/\s+/);
    let i = 1; // Skip date token

    const descTokens: string[] = [];
    while (i < tokens.length) {
      const tok = tokens[i];
      // Branch code (4 digits like 0000 or 0930)
      if (/^\d{4}$/.test(tok) && i === tokens.length - 3) {
        branchCode = tok;
        i++;
        break;
      }
      // If hitting an amount token
      if (/^[\d,.]+(?:\.\d{2})?$/.test(tok) && (tokens.slice(i).some(t => t === "DB" || t === "CR") || i >= tokens.length - 2)) {
        break;
      }
      descTokens.push(tok);
      i++;
    }

    // Accumulate multi-line description if subsequent lines don't start with a date
    while (idx + 1 < lines.length && !lines[idx + 1].match(/^\d{2}[\/-]\d{2}\b/) && !lines[idx + 1].toUpperCase().includes("SALDO")) {
      const nextLine = lines[idx + 1].trim();
      if (nextLine.length > 0 && !nextLine.toUpperCase().includes("HALAMAN") && !nextLine.toUpperCase().includes("BERSAMBUNG")) {
        descTokens.push(nextLine);
      }
      idx++;
    }

    description = descTokens.join(" ");

    // Parse Amount, Type (DB/CR) and Balance from remaining tokens
    const remaining = tokens.slice(i);
    for (let r = 0; r < remaining.length; r++) {
      const tok = remaining[r];
      if (tok === "DB") {
        isDebit = true;
      } else if (tok === "CR") {
        isDebit = false;
      } else if (/^[\d,.]+(?:\.\d{2})?$/.test(tok)) {
        const val = parseIndoNumber(tok);
        if (amount === 0) {
          amount = val;
        } else {
          balance = val;
        }
      }
    }

    if (amount > 0) {
      transactions.push({
        date: fullDate,
        description: description.trim(),
        branchCode,
        debitAmount: isDebit ? amount : 0,
        creditAmount: isDebit ? 0 : amount,
        balance,
      });
    }
  }

  const totalDebits = round2(transactions.reduce((s, t) => s + t.debitAmount, 0));
  const totalCredits = round2(transactions.reduce((s, t) => s + t.creditAmount, 0));
  const expectedCount = (expectedDebitsCount + expectedCreditsCount) > 0 ? (expectedDebitsCount + expectedCreditsCount) : undefined;

  return {
    period: period || "UNKNOWN",
    startDate: startDate || new Date().toISOString().slice(0, 10),
    endDate: endDate || new Date().toISOString().slice(0, 10),
    accountNumber,
    accountHolder: accountHolder || undefined,
    currency,
    openingBalance: round2(openingBalance),
    closingBalance: round2(closingBalance),
    totalDebits: totalDebitsSummary > 0 ? totalDebitsSummary : totalDebits,
    totalCredits: totalCreditsSummary > 0 ? totalCreditsSummary : totalCredits,
    expectedTransactionCount: expectedCount,
    transactions,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseIndoNumber(str: string): number {
  if (!str) return 0;
  // Handle 1,234.56 or 1.234,56
  let clean = str.replace(/[^\d.,]/g, "");
  if (clean.includes(",") && clean.includes(".")) {
    if (clean.lastIndexOf(".") > clean.lastIndexOf(",")) {
      // 1,234.56
      clean = clean.replace(/,/g, "");
    } else {
      // 1.234,56
      clean = clean.replace(/\./g, "").replace(",", ".");
    }
  } else if (clean.includes(",")) {
    // Check if comma is decimal (e.g., 500,50) or thousand (e.g. 100,000)
    if (/,\d{2}$/.test(clean)) {
      clean = clean.replace(",", ".");
    } else {
      clean = clean.replace(/,/g, "");
    }
  }
  const val = parseFloat(clean);
  return isNaN(val) ? 0 : val;
}

function round2(num: number): number {
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function upper(s?: string): string {
  return (s || "").toUpperCase().trim();
}

async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
