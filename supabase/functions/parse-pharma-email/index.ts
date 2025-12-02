import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface EmailParseRequest {
  emailSubject: string;
  emailBody: string;
  fromEmail: string;
  fromName?: string;
  receivedDate?: string;
}

interface ProductLine {
  productName: string;
  specification?: string;
  quantity: string;
  itemNumber?: string;
  etdPo?: string;
}

interface ParsedInquiry {
  products: ProductLine[];
  productName: string;
  specification?: string;
  quantity: string;
  supplierName?: string;
  supplierCountry?: string;
  companyName: string;
  contactPerson?: string;
  contactEmail: string;
  contactPhone?: string;
  coaRequested: boolean;
  msdsRequested: boolean;
  sampleRequested: boolean;
  priceRequested: boolean;
  purposeIcons: string[];
  deliveryDateExpected?: string;
  urgency: 'low' | 'medium' | 'high' | 'urgent';
  remarks?: string;
  confidence: 'high' | 'medium' | 'low';
  confidenceScore: number;
  detectedLanguage: string;
  autoDetectedCompany: boolean;
  autoDetectedContact: boolean;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const { emailSubject, emailBody, fromEmail, fromName, receivedDate }: EmailParseRequest = await req.json();

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let actualFromEmail = fromEmail;
    let actualFromName = fromName;
    let isForwarded = false;

    const internalDomain = 'anzen.co.in';
    const fromDomain = fromEmail.split('@')[1]?.toLowerCase();

    if (fromDomain === internalDomain) {
      isForwarded = true;

      const fwdEmailMatch = emailBody.match(/From:\s*([^<\n]+)\s*<([^>]+)>|From:\s*([^\n@]+@[^\n\s]+)/i);
      if (fwdEmailMatch) {
        actualFromEmail = fwdEmailMatch[2] || fwdEmailMatch[3] || fromEmail;
        actualFromName = fwdEmailMatch[1]?.trim() || fromName;
      } else {
        const simpleEmailMatch = emailBody.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
        if (simpleEmailMatch && !simpleEmailMatch[1].includes(internalDomain)) {
          actualFromEmail = simpleEmailMatch[1];
        }
      }
    }

    const domain = actualFromEmail.split('@')[1]?.toLowerCase();
    let companyFromDomain = null;
    let autoDetectedCompany = false;

    if (domain) {
      const { data: domainMapping } = await supabase
        .from('crm_company_domain_mapping')
        .select('company_name, confidence_score')
        .eq('email_domain', domain)
        .maybeSingle();

      if (domainMapping) {
        companyFromDomain = domainMapping.company_name;
        autoDetectedCompany = true;

        await supabase
          .from('crm_company_domain_mapping')
          .update({ 
            match_count: supabase.rpc('increment', { row_id: domain }),
            last_matched: new Date().toISOString() 
          })
          .eq('email_domain', domain);
      }
    }

    const openaiApiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openaiApiKey) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'OpenAI API key not configured. Please add OPENAI_API_KEY to Supabase Edge Function secrets.',
          fallbackData: {
            productName: '',
            specification: null,
            quantity: '',
            companyName: companyFromDomain || 'Unknown Company',
            contactPerson: fromName || null,
            contactEmail: fromEmail,
            coaRequested: false,
            msdsRequested: false,
            sampleRequested: false,
            priceRequested: true,
            purposeIcons: ['price'],
            urgency: 'medium' as const,
            confidence: 'low' as const,
            confidenceScore: 0.3,
            detectedLanguage: 'unknown',
            autoDetectedCompany,
            autoDetectedContact: false,
          }
        }),
        {
          status: 503,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      );
    }

    const systemPrompt = `You are an AI assistant specialized in parsing PHARMACEUTICAL INDUSTRY INQUIRY emails ONLY.

CRITICAL: Only extract data from emails that are legitimate pharmaceutical/chemical product inquiries or quotation requests.

IMPORTANT: Many inquiries contain MULTIPLE PRODUCTS. You must extract ALL products as an array.

REJECT these email types (set isInquiry: false):
- Marketing emails (Amazon, Google, YouTube, Instagram, StackBlitz, etc.)
- Social media notifications
- Promotional content
- Service announcements
- Newsletter subscriptions
- Account confirmations
- Partnership pitches from marketing agencies
- Any email NOT related to pharmaceutical/chemical product purchases

ACCEPT only these:
- Emails requesting price quotations for pharmaceutical/chemical products
- Inquiry emails with product names like APIs, excipients, raw materials
- Emails with pharmaceutical technical terms (API, USP, EP, BP, GMP, COA, MSDS, etc.)
- Business inquiries from pharmaceutical companies, distributors, or manufacturers
- Keywords: "Permintaan Penawaran Harga" (Indonesian for price quotation request), "quotation", "inquiry", "penawaran", "bahan baku"

Extract information for VALID inquiries:

**MULTIPLE PRODUCTS:** Extract ALL products from the email. Many emails contain 2-5 products in a table or list.

For EACH product extract:
1. Product name (e.g., "ESCITALOPRAM OXALATE", "ATRACURIUM BESYLATE (EXPORT)")
2. Specification/Grade (e.g., "BP, Powder", "USP", "EP")
3. Quantity with units (e.g., "25 KG", "6 KG")
4. Item number if in table (e.g., "153109", "117535")
5. ETD/PO date if in table (e.g., "25/01/2026", "15/12/2025")

General inquiry info:
6. Supplier/Manufacturer name if mentioned
7. Country of origin if mentioned
8. Company name from signature
9. Contact person name
10. Whether COA (Certificate of Analysis) is requested
11. Whether MSDS (Material Safety Data Sheet) is requested
12. Whether sample is requested
13. Whether price quotation is requested
14. Expected delivery date (parse formats like "03.04.26", "DD.MM.YY", "DD/MM/YYYY" and convert to YYYY-MM-DD)
15. Urgency level
16. Phone/WhatsApp number
17. Detect language (Indonesian/English)
18. Confidence score (0.0 to 1.0) - Set BELOW 0.4 for non-pharma emails

Common pharmaceutical specifications to extract:
- Pharmacopeia standards: BP (British), USP (US), EP (European), IP (Indian), JP (Japanese)
- Physical forms: Powder, Granules, Liquid, Crystals, Tablets
- Grades: Pharma Grade, Food Grade, Industrial Grade, Technical Grade, GMP Certified
- Combine specification parts: "India BP, Powder 150 KG" → specification: "India BP, Powder"

Return a JSON object:
{
  "isInquiry": boolean,
  "products": [
    {
      "productName": string,
      "specification": string | null,
      "quantity": string,
      "itemNumber": string | null,
      "etdPo": "YYYY-MM-DD" | null
    }
  ],
  "productName": string,
  "specification": string | null,
  "quantity": string,
  "supplierName": string | null,
  "supplierCountry": string | null,
  "companyName": string,
  "contactPerson": string | null,
  "contactPhone": string | null,
  "coaRequested": boolean,
  "msdsRequested": boolean,
  "sampleRequested": boolean,
  "priceRequested": boolean,
  "purposeIcons": string[],
  "deliveryDateExpected": "YYYY-MM-DD" | null,
  "urgency": "low" | "medium" | "high" | "urgent",
  "remarks": string | null,
  "confidence": "high" | "medium" | "low",
  "confidenceScore": number,
  "detectedLanguage": string,
  "rejectionReason": string | null
}

NOTE:
- "products" array contains ALL products found
- "productName", "specification", "quantity" are for backward compatibility (use first product or summary)
- Parse ALL date formats to YYYY-MM-DD

IMPORTANT: deliveryDateExpected must be in YYYY-MM-DD format. Parse dates like "03.04.26" as "2026-04-03".`;

    const allEmailAddresses: string[] = [];
    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    let match;
    while ((match = emailRegex.exec(emailBody)) !== null) {
      const foundEmail = match[1].toLowerCase();
      if (!foundEmail.includes(internalDomain) && !allEmailAddresses.includes(foundEmail)) {
        allEmailAddresses.push(foundEmail);
      }
    }
    if (!allEmailAddresses.includes(actualFromEmail.toLowerCase())) {
      allEmailAddresses.unshift(actualFromEmail.toLowerCase());
    }

    const userPrompt = `Parse this pharmaceutical inquiry email:

SUBJECT: ${emailSubject}
FROM: ${actualFromName || ''} <${actualFromEmail}>
${isForwarded ? `\nNOTE: This email was FORWARDED from internal team. Extract the ORIGINAL sender's details from the forwarded email body.` : ''}
${companyFromDomain ? `\nKNOWN COMPANY (from domain): ${companyFromDomain}` : ''}
${receivedDate ? `\nRECEIVED DATE: ${receivedDate}` : ''}
${allEmailAddresses.length > 1 ? `\nALL EMAIL ADDRESSES FOUND: ${allEmailAddresses.join(', ')}` : ''}

BODY:
${emailBody}

EXTRACT ALL PRODUCTS. If email contains a table with multiple products, extract each row as a separate product in the products array.
${allEmailAddresses.length > 1 ? `\nIMPORTANT: Multiple email addresses found. Extract ALL contact persons from the email. Return an array of contacts with their names and email addresses.` : ''}

Respond with a JSON object containing the extracted information.`;

    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' }
      }),
    });

    if (!openaiResponse.ok) {
      const errorText = await openaiResponse.text();
      throw new Error(`OpenAI API error: ${errorText}`);
    }

    const openaiData = await openaiResponse.json();
    const aiResponse = JSON.parse(openaiData.choices[0].message.content);

    const purposeIcons: string[] = [];
    if (aiResponse.priceRequested || aiResponse.price_requested || aiResponse.price) purposeIcons.push('price');
    if (aiResponse.coaRequested || aiResponse.coa_requested || aiResponse.coa) purposeIcons.push('coa');
    if (aiResponse.msdsRequested || aiResponse.msds_requested || aiResponse.msds) purposeIcons.push('msds');
    if (aiResponse.sampleRequested || aiResponse.sample_requested || aiResponse.sample) purposeIcons.push('sample');
    if (purposeIcons.length === 0) purposeIcons.push('price');

    const extractedCompany = aiResponse.companyName || aiResponse.company_name || aiResponse.company;
    const finalCompanyName = companyFromDomain || extractedCompany || 'Unknown Company';

    if (!companyFromDomain && extractedCompany && domain) {
      await supabase
        .from('crm_company_domain_mapping')
        .insert({
          email_domain: domain,
          company_name: extractedCompany,
          confidence_score: aiResponse.confidenceScore || 0.7,
          is_verified: false,
          match_count: 1,
        })
        .then(() => {
          autoDetectedCompany = false;
        });
    }

    const isValidInquiry = aiResponse.isInquiry !== false &&
                           (aiResponse.confidenceScore || aiResponse.confidence_score || 0.7) >= 0.4 &&
                           (aiResponse.productName || aiResponse.product_name);

    const products = aiResponse.products || [];
    const firstProduct = products[0] || {};

    const parsedInquiry: ParsedInquiry = {
      products: products.map((p: any) => ({
        productName: p.productName || p.product_name || '',
        specification: p.specification || p.spec || p.grade || null,
        quantity: p.quantity || '',
        itemNumber: p.itemNumber || p.item_number || null,
        etdPo: p.etdPo || p.etd_po || p.etd || null,
      })),
      productName: firstProduct.productName || aiResponse.productName || aiResponse.product_name || (products.length > 1 ? 'Multiple Products' : ''),
      specification: firstProduct.specification || aiResponse.specification || aiResponse.spec || aiResponse.grade || null,
      quantity: firstProduct.quantity || aiResponse.quantity || '',
      supplierName: aiResponse.supplierName || aiResponse.supplier_name || aiResponse.supplier || null,
      supplierCountry: aiResponse.supplierCountry || aiResponse.supplier_country || aiResponse.country || null,
      companyName: finalCompanyName,
      contactPerson: aiResponse.contactPerson || aiResponse.contact_person || aiResponse.contact || actualFromName || null,
      contactEmail: actualFromEmail,
      contactPhone: aiResponse.contactPhone || aiResponse.contact_phone || aiResponse.phone || aiResponse.whatsapp || null,
      coaRequested: aiResponse.coaRequested || aiResponse.coa_requested || aiResponse.coa || false,
      msdsRequested: aiResponse.msdsRequested || aiResponse.msds_requested || aiResponse.msds || false,
      sampleRequested: aiResponse.sampleRequested || aiResponse.sample_requested || aiResponse.sample || false,
      priceRequested: aiResponse.priceRequested || aiResponse.price_requested || aiResponse.price || true,
      purposeIcons,
      deliveryDateExpected: aiResponse.deliveryDateExpected || aiResponse.delivery_date || aiResponse.deliveryDate || null,
      urgency: aiResponse.urgency || 'medium',
      remarks: aiResponse.remarks || aiResponse.notes || aiResponse.additional_info || null,
      confidence: isValidInquiry ? (aiResponse.confidence || 'medium') : 'low',
      confidenceScore: isValidInquiry ? (aiResponse.confidenceScore || aiResponse.confidence_score || 0.7) : 0.1,
      detectedLanguage: aiResponse.detectedLanguage || aiResponse.language || 'unknown',
      autoDetectedCompany,
      autoDetectedContact: false,
    };

    return new Response(
      JSON.stringify({
        success: true,
        data: parsedInquiry,
        allEmailAddresses: allEmailAddresses,
        isForwarded: isForwarded,
        rawAiResponse: aiResponse
      }),
      {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error) {
    console.error('Error parsing email:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || 'Failed to parse email'
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }
});