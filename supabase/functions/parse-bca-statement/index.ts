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
    const useOCR = formData.get('useOCR') === 'true';
    const previewOnly = formData.get('previewOnly') === 'true';

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
    const fileType = file.type || '';
    const isImageFile = fileType.includes('image/') || file.name.match(/\.(png|jpg|jpeg)$/i);

    let text = '';

    if (isImageFile || useOCR) {
      console.log('[OCR] Processing with OpenAI Vision (image file or OCR requested)...');

      const openaiKey = Deno.env.get('OPENAI_API_KEY');
      if (!openaiKey) {
        throw new Error('OCR is not configured. Please use Excel export instead.');
      }

      text = await extractTextWithOpenAI(uint8Array, openaiKey, isImageFile ? fileType : 'application/pdf');
      console.log('[OCR] Extracted', text.length, 'chars via OpenAI Vision');

      if (text.length < 100) {
        throw new Error('OCR failed to extract sufficient text. File may be corrupt or empty.');
      }
    } else {
      text = extractTextFromPDF(uint8Array);
      console.log('[INFO] Extracted', text.length, 'chars from PDF');
      console.log('[DEBUG] First 2000 chars:', text.substring(0, 2000));
      console.log('[DEBUG] Contains dd/mm pattern:', /\d{2}\/\d{2}/.test(text));

      const sampleLines = text.split(/\n/).slice(0, 30);
      console.log('[DEBUG] First 30 lines:');
      sampleLines.forEach((line, idx) => {
        if (line.trim()) console.log(`  [${idx}] ${line.substring(0, 100)}`);
      });
    }

    const parsed = parseBCAStatement(text, bankAccount.currency);

    if (!parsed.transactions || parsed.transactions.length === 0) {
      console.error('[ERROR] Parser found no transactions. Text length:', text.length);
      console.error('[ERROR] Text sample:', text.substring(0, 1000));

      return new Response(
        JSON.stringify({
          error: 'No valid transactions found in PDF. The document may be encrypted or image-based.',
          canUseOCR: true,
          suggestions: [
            'Use "Download as Excel" from BCA e-Banking (recommended)',
            'Click "Run OCR Anyway" to process with optical character recognition',
            'Upload as PNG/JPG image instead of PDF',
            'Manually enter transactions using the Excel template'
          ]
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (previewOnly) {
      return new Response(
        JSON.stringify({
          preview: true,
          period: parsed.period,
          openingBalance: parsed.openingBalance,
          closingBalance: parsed.closingBalance,
          transactionCount: parsed.transactions.length,
          transactions: parsed.transactions.slice(0, 10),
          extractedText: text.substring(0, 2000),
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
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
      statement_balance: txn.balance,
      currency: bankAccount.currency,
      reconciliation_status: 'unmatched',
      created_by: user.id,
    }));

    let insertedCount = 0;
    let duplicateCount = 0;

    for (const line of lines) {
      const { error: lineError } = await supabase
        .from('bank_statement_lines')
        .insert(line);

      if (lineError) {
        if (lineError.code === '23505') {
          duplicateCount++;
        } else {
          console.error('[ERROR] Failed to insert line:', lineError);
        }
      } else {
        insertedCount++;
      }
    }

    console.log(`[INFO] Inserted ${insertedCount} transactions, skipped ${duplicateCount} duplicates`);

    return new Response(
      JSON.stringify({
        success: true,
        uploadId: upload.id,
        transactionCount: parsed.transactions.length,
        insertedCount,
        duplicateCount,
        period: parsed.period,
        openingBalance: parsed.openingBalance,
        closingBalance: parsed.closingBalance,
        usedOCR: useOCR,
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

async function extractTextWithOpenAI(fileData: Uint8Array, apiKey: string, mimeType: string): Promise<string> {
  const base64Data = btoa(String.fromCharCode(...fileData));

  const prompt = `You are an OCR system. Extract ALL text from this BCA (Bank Central Asia) bank statement.

CRITICAL REQUIREMENTS:
1. Extract EVERY line of text exactly as shown
2. Preserve the exact format and spacing
3. Include dates in DD/MM format
4. Include all transaction descriptions
5. Include all amounts with their DB/CR indicators
6. Include period information (PERIODE: BULAN TAHUN)
7. Include balance information (SALDO AWAL, SALDO AKHIR)
8. Maintain the row structure - each transaction on its own lines

Output ONLY the extracted text, no explanations or commentary.`;

  const imageUrl = mimeType.includes('image/')
    ? `data:${mimeType};base64,${base64Data}`
    : `data:image/png;base64,${base64Data}`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: {
                url: imageUrl,
                detail: 'high'
              }
            }
          ]
        }
      ],
      max_tokens: 4096,
      temperature: 0
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[OCR] OpenAI API Error:', errorText);

    if (errorText.includes('pdf') || errorText.includes('format')) {
      throw new Error('OpenAI cannot process PDFs directly. Please upload as PNG/JPG image instead, or use Excel export.');
    }

    throw new Error('OpenAI OCR service failed: ' + errorText.substring(0, 200));
  }

  const result = await response.json();

  if (!result.choices || !result.choices[0] || !result.choices[0].message) {
    throw new Error('OpenAI returned no results');
  }

  const extractedText = result.choices[0].message.content;
  if (!extractedText || extractedText.length < 50) {
    throw new Error('OpenAI could not extract sufficient text from this file');
  }

  console.log('[OCR] OpenAI extracted text sample:', extractedText.substring(0, 500));

  return extractedText;
}

function extractTextFromPDF(pdfData: Uint8Array): string {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const raw = decoder.decode(pdfData);
  const parts: string[] = [];

  // Method 1: Extract text from parentheses (standard PDF text)
  const textPattern = /\(([^)]+)\)/g;
  let match;
  while ((match = textPattern.exec(raw)) !== null) {
    let text = match[1];
    text = text
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '')
      .replace(/\\t/g, ' ')
      .replace(/\\\\/g, '\\')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')');
    parts.push(text);
  }

  console.log(`[EXTRACT] Found ${parts.length} text blocks in PDF`);
  console.log(`[EXTRACT] Raw PDF size: ${raw.length} bytes`);

  // Method 2: If no text found, try hex-encoded text
  if (parts.length === 0) {
    console.log('[EXTRACT] No parentheses text found, trying hex-encoded text...');
    const hexPattern = /<([0-9A-Fa-f]+)>/g;
    let hexMatch;
    while ((hexMatch = hexPattern.exec(raw)) !== null) {
      try {
        const hexStr = hexMatch[1];
        if (hexStr.length % 2 === 0) {
          let decoded = '';
          for (let i = 0; i < hexStr.length; i += 2) {
            const byte = parseInt(hexStr.substr(i, 2), 16);
            if (byte >= 32 && byte <= 126) {
              decoded += String.fromCharCode(byte);
            } else if (byte === 10) {
              decoded += '\n';
            } else if (byte === 32) {
              decoded += ' ';
            }
          }
          if (decoded.trim()) parts.push(decoded);
        }
      } catch (e) {
        // Skip invalid hex
      }
    }
    console.log(`[EXTRACT] Found ${parts.length} hex-encoded blocks`);
  }

  const finalText = parts.join('\n');
  console.log(`[EXTRACT] Final text length: ${finalText.length} chars`);
  console.log(`[EXTRACT] Contains dates (dd/mm)?: ${/\d{2}\/\d{2}/.test(finalText)}`);

  return finalText;
}

function parseBCAStatement(text: string, currency: string) {
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

  const lines = text.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
  console.log(`[PARSE] Found ${lines.length} lines`);

  const transactions: ParsedTransaction[] = [];
  let i = 0;

  // BLOCK-BASED PARSER (USER'S FINAL REQUIREMENT):
  // 1. Transaction starts when line = DATE (dd/mm)
  // 2. Collect ALL lines after that date
  // 3. Stop ONLY when NEXT date appears
  // 4. Store EVERYTHING as description (NO truncation, NO summarizing)

  while (i < lines.length) {
    const line = lines[i];

    // Check if this line is a DATE (dd/mm format)
    const dateMatch = line.match(/^(\d{2})\/(\d{2})$/);
    if (!dateMatch) {
      i++;
      continue;
    }

    const day = parseInt(dateMatch[1]);
    const mon = parseInt(dateMatch[2]);

    // Validate it's a real date
    if (day < 1 || day > 31 || mon < 1 || mon > 12) {
      i++;
      continue;
    }

    // Collect ALL lines until the next date
    const descriptionLines: string[] = [];
    let j = i + 1;

    while (j < lines.length) {
      const nextLine = lines[j];

      // Stop if we hit another date
      if (nextLine.match(/^\d{2}\/\d{2}$/)) {
        const testDay = parseInt(nextLine.split('/')[0]);
        const testMon = parseInt(nextLine.split('/')[1]);
        if (testDay >= 1 && testDay <= 31 && testMon >= 1 && testMon <= 12) {
          // This is the next transaction's date - stop here
          break;
        }
      }

      // Collect this line as part of the description
      descriptionLines.push(nextLine);
      j++;

      // Safety: don't collect more than 50 lines per transaction
      if (descriptionLines.length > 50) break;
    }

    // Join with newlines to preserve multi-line structure
    const fullDescription = descriptionLines.join('\n');

    // Skip header rows and empty transactions
    if (fullDescription.match(/TANGGAL|KETERANGAN|CABANG|MUTASI|SALDO|Halaman|Bersambung/i)) {
      i = j;
      continue;
    }

    if (fullDescription.trim().length < 3) {
      i = j;
      continue;
    }

    // Extract amounts from the FULL description text
    const amounts: number[] = [];
    const amountPattern = /([\d,\.]+)/g;
    let amountMatch;
    const textForAmounts = descriptionLines.join(' ');
    while ((amountMatch = amountPattern.exec(textForAmounts)) !== null) {
      const amt = parseAmount(amountMatch[1]);
      if (amt > 0 && amt < 100000000000) {
        amounts.push(amt);
      }
    }

    if (amounts.length === 0) {
      i = j;
      continue;
    }

    // Determine if credit (CR) or debit (DB)
    const isCredit = /\bCR\b/i.test(textForAmounts);
    const amount = amounts[0];
    const balance = amounts.length > 1 ? amounts[amounts.length - 1] : null;

    // Extract reference (e.g., "0211/FTSCY/WS95051")
    let reference = '';
    const refMatch = textForAmounts.match(/\d{4}\/[\w\/]+/);
    if (refMatch) {
      reference = refMatch[0];
    }

    // Store the FULL description (NO truncation, NO summarizing)
    const description = fullDescription;

    const fullDate = `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    transactions.push({
      date: fullDate,
      description,  // FULL multi-line description stored here
      reference,
      branchCode: '',
      debitAmount: isCredit ? 0 : amount,
      creditAmount: isCredit ? amount : 0,
      balance,
    });

    // Debug log first 5 transactions
    if (transactions.length <= 5) {
      console.log(`[TXN ${transactions.length}] ${day}/${mon}:`);
      console.log(`  Description (${description.length} chars):`);
      console.log(`  ${description.substring(0, 200).replace(/\n/g, ' | ')}`);
      console.log(`  Amount: ${amount}, Balance: ${balance}`);
    }

    // Move to the next date
    i = j;
  }

  const totalDebits = transactions.reduce((s, t) => s + t.debitAmount, 0);
  const totalCredits = transactions.reduce((s, t) => s + t.creditAmount, 0);

  console.log(`[RESULT] Parsed ${transactions.length} transactions`);
  console.log(`[RESULT] Total Debits: ${totalDebits.toFixed(2)}, Total Credits: ${totalCredits.toFixed(2)}`);

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
