import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

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
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

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

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      throw new Error("Unauthorized");
    }

    const formData = await req.formData();
    const file = formData.get("file") as File;
    const bankAccountId = formData.get("bankAccountId") as string;

    if (!file || !bankAccountId) {
      throw new Error("Missing file or bankAccountId");
    }

    const { data: bankAccount, error: bankError } = await supabase
      .from("bank_accounts")
      .select("currency, account_number, bank_name")
      .eq("id", bankAccountId)
      .single();

    if (bankError || !bankAccount) {
      throw new Error("Bank account not found");
    }

    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    
    const text = await extractTextFromPDF(uint8Array);
    const parsed = parseBCAStatement(text, bankAccount.currency);
    
    if (!parsed.transactions || parsed.transactions.length === 0) {
      throw new Error("No transactions found in PDF. Please check if this is a valid BCA statement.");
    }

    const fileName = `${bankAccountId}/${Date.now()}_${file.name}`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from("bank-statements")
      .upload(fileName, file);

    if (uploadError) {
      console.error("Storage upload error:", uploadError);
      throw new Error("Failed to upload PDF");
    }

    const { data: { publicUrl } } = supabase.storage
      .from("bank-statements")
      .getPublicUrl(fileName);

    const { data: upload, error: uploadInsertError } = await supabase
      .from("bank_statement_uploads")
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
        status: "completed",
      })
      .select()
      .single();

    if (uploadInsertError) {
      console.error("Upload insert error:", uploadInsertError);
      throw new Error("Failed to create upload record");
    }

    const lines = parsed.transactions.map((txn) => ({
      upload_id: upload.id,
      bank_account_id: bankAccountId,
      transaction_date: txn.date,
      description: txn.description,
      reference: "",
      branch_code: txn.branchCode,
      debit_amount: txn.debitAmount,
      credit_amount: txn.creditAmount,
      running_balance: txn.balance,
      currency: bankAccount.currency,
      reconciliation_status: "unmatched",
      created_by: user.id,
    }));

    const { error: linesError } = await supabase
      .from("bank_statement_lines")
      .insert(lines);

    if (linesError) {
      console.error("Lines insert error:", linesError);
      throw new Error("Failed to insert transactions");
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
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: any) {
    console.error("Error parsing BCA statement:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Failed to parse PDF" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

async function extractTextFromPDF(pdfData: Uint8Array): Promise<string> {
  const decoder = new TextDecoder("latin1");
  let rawText = decoder.decode(pdfData);

  let extractedText = "";

  const textObjectRegex = /BT\s+([\s\S]+?)\s+ET/g;
  const textMatches = rawText.matchAll(textObjectRegex);

  for (const match of textMatches) {
    const content = match[1];
    const stringMatches = content.matchAll(/[\(\<]([^\)\>]+)[\)\>]/g);
    for (const strMatch of stringMatches) {
      let text = strMatch[1];
      text = text.replace(/\\([\\()rnt])/g, (_, char) => {
        switch (char) {
          case 'n': return '\n';
          case 'r': return '\r';
          case 't': return '\t';
          case '\\': return '\\';
          case '(': return '(';
          case ')': return ')';
          default: return char;
        }
      });
      extractedText += text + " ";
    }
  }

  const streamRegex = /stream\s+([\s\S]+?)\s+endstream/g;
  const streamMatches = rawText.matchAll(streamRegex);

  for (const match of streamMatches) {
    const stream = match[1];
    const textPattern = /[A-Za-z0-9\/\-\.\,\s]{5,}/g;
    const texts = stream.match(textPattern);
    if (texts) {
      extractedText += " " + texts.join(" ");
    }
  }

  return extractedText;
}

function parseBCAStatement(text: string, currency: string) {
  text = text.replace(/\s+/g, " ");

  let period = "";
  let accountNumber = "";
  let openingBalance = 0;
  let closingBalance = 0;

  const periodMatch = text.match(/PERIODE\s*:\s*([A-Z]+\s+\d{4})/i);
  if (periodMatch) period = periodMatch[1];

  const accMatch = text.match(/NO\.\s*REKENING\s*:\s*(\d+)/i);
  if (accMatch) accountNumber = accMatch[1];

  const openingMatch = text.match(/SALDO AWAL\s+([\d,\.]+)/i);
  if (openingMatch) {
    openingBalance = parseFloat(openingMatch[1].replace(/,/g, "").replace(/\./g, ""));
  }

  const closingMatch = text.match(/SALDO AKHIR\s*:?\s*([\d,\.]+)/i);
  if (closingMatch) {
    closingBalance = parseFloat(closingMatch[1].replace(/,/g, "").replace(/\./g, ""));
  }

  let startDate = "";
  let endDate = "";
  if (period) {
    const [monthName, year] = period.split(" ");
    const monthMap: Record<string, string> = {
      JANUARY: "01", FEBRUARI: "02", FEBRUARY: "02", MARET: "03", MARCH: "03",
      APRIL: "04", MEI: "05", MAY: "05", JUNI: "06", JUNE: "06",
      JULI: "07", JULY: "07", AGUSTUS: "08", AUGUST: "08",
      SEPTEMBER: "09", OKTOBER: "10", OCTOBER: "10", NOVEMBER: "11", DESEMBER: "12", DECEMBER: "12",
    };
    const month = monthMap[monthName.toUpperCase()] || "01";
    startDate = `${year}-${month}-01`;
    const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
    endDate = `${year}-${month}-${String(lastDay).padStart(2, "0")}`;
  }

  const transactions: ParsedTransaction[] = [];
  const txnPattern = /(\d{2}\/\d{2})\s+([A-Z\s\-]+?)\s+(\d{2}\/\d{2}\s+)?([A-Z0-9\/\-\s]+?)\s+([\d,\.]+)\s+(DB|CR)?\s*([\d,\.]+)?/gi;

  let match;
  const year = period.split(" ")[1] || new Date().getFullYear().toString();

  while ((match = txnPattern.exec(text)) !== null) {
    const [_, dateStr, type, _, desc, amountStr, indicator, balanceStr] = match;

    const [day, month] = dateStr.split("/");
    const fullDate = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;

    const amount = parseFloat(amountStr.replace(/,/g, "").replace(/\./g, ""));
    const balance = balanceStr ? parseFloat(balanceStr.replace(/,/g, "").replace(/\./g, "")) : null;
    const isDebit = !indicator || indicator === "DB";

    if (amount > 0 && !isNaN(amount)) {
      transactions.push({
        date: fullDate,
        description: (type.trim() + " " + desc.trim()).trim().substring(0, 500),
        branchCode: "",
        debitAmount: isDebit ? amount : 0,
        creditAmount: isDebit ? 0 : amount,
        balance,
      });
    }
  }

  if (transactions.length === 0) {
    const simplePattern = /(\d{2}\/\d{2})[^\d]+([\d,\.]+)\s+(DB|CR)?/gi;
    let simpleMatch;

    while ((simpleMatch = simplePattern.exec(text)) !== null) {
      const [_, dateStr, amountStr, indicator] = simpleMatch;

      const [day, month] = dateStr.split("/");
      const fullDate = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;

      const amount = parseFloat(amountStr.replace(/,/g, "").replace(/\./g, ""));
      const isDebit = !indicator || indicator === "DB";

      const contextStart = Math.max(0, simpleMatch.index - 100);
      const contextEnd = Math.min(text.length, simpleMatch.index + 200);
      const context = text.substring(contextStart, contextEnd);
      const descMatch = context.match(/(\d{2}\/\d{2})\s+([A-Za-z\s\-\/]+)/);
      const description = descMatch ? descMatch[2].trim().substring(0, 200) : "Transaction";

      if (amount > 0 && !isNaN(amount)) {
        transactions.push({
          date: fullDate,
          description,
          branchCode: "",
          debitAmount: isDebit ? amount : 0,
          creditAmount: isDebit ? 0 : amount,
          balance: null,
        });
      }
    }
  }

  const totalDebits = transactions.reduce((sum, t) => sum + t.debitAmount, 0);
  const totalCredits = transactions.reduce((sum, t) => sum + t.creditAmount, 0);

  console.log(`Parsed: ${transactions.length} transactions, Opening: ${openingBalance}, Closing: ${closingBalance}`);

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
