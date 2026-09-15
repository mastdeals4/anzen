import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { requireRole } from "../_shared/security.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface DocumentProcessRequest {
  document_id: string;
  force_reprocess?: boolean;
}

const SYSTEM_PROMPT = `You are the Enquiry Brain Document Intelligence engine for a B2B pharmaceutical raw materials trading workflow (Anzen / Sapharmajaya).

Your mission is to read a technical document (COA, MSDS/SDS, Technical Specification sheet) and extract structured parameters with strict evidence grounding.
You produce a PROPOSAL ONLY. You are NOT authoritative and will NEVER directly mutate products, requests, or business records.

EXTRACTION GUIDELINES:
1. CERTIFICATE OF ANALYSIS (COA):
   - Extract: Product Name, Batch/Lot Number, Manufacturer, Manufacturing Date, Expiry/Retest Date, Document Number.
   - Extract individual test parameters (e.g., Assay, Particle Size / Mesh, Moisture / Loss on Drying, pH, Heavy Metals, Related Substances).
   - For each parameter record: parameter name, specification limit, actual result (extracted_value), unit, test method, verbatim evidence quote, and page number.
2. MATERIAL SAFETY DATA SHEET (MSDS / SDS):
   - Extract: Product Name, Manufacturer / Supplier, Document/Revision Date, Hazard Classification (GHS/OSHA), UN Number / Packing Group, Storage & Handling instructions.
3. TECHNICAL SPECIFICATION SHEET:
   - Extract: Product Name, Grade (USP/BP/EP/IP), Specification parameters, limits, units, mesh/particle size, shelf life.

STRICT ACCURACY RULES:
- NEVER infer or hallucinate values not explicitly printed in the document.
- If a parameter is not mentioned, do NOT include it.
- Grounding: Every extracted value MUST include a verbatim quote from the text in the "evidence" field.
- Confidence:
  * "HIGH": Clearly typed, unambiguous text with direct verbatim match.
  * "MEDIUM": Legible but format is irregular or partially obscured.
  * "LOW": Vague, ambiguous, or handwritten. Must set needs_verification = true.

Return a STRICT JSON object matching this schema:
{
  "document_type": "COA" | "MSDS" | "SPEC" | "OTHER",
  "confidence_tier": "HIGH" | "MEDIUM" | "LOW",
  "needs_verification": boolean,
  "product_name": string | null,
  "batch_number": string | null,
  "manufacturer": string | null,
  "manufacturing_date": string | null,
  "expiry_date": string | null,
  "document_number": string | null,
  "hazard_classification": string | null,
  "summary": string,
  "parameters": [
    {
      "parameter": string,
      "extracted_value": string,
      "unit": string | null,
      "specification_limit": string | null,
      "test_method": string | null,
      "evidence": string (verbatim quotation from document),
      "page": number | null,
      "confidence": "HIGH" | "MEDIUM" | "LOW"
    }
  ]
}`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  let adminClient: ReturnType<typeof createClient>;

  if (token && token === supabaseServiceKey) {
    adminClient = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  } else {
    const authResult = await requireRole(
      req,
      supabaseUrl,
      supabaseServiceKey,
      ["admin", "manager", "sales"],
      corsHeaders
    );
    if (!authResult.ok) return authResult.response;
    adminClient = authResult.adminClient;
  }

  let body: DocumentProcessRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: "Invalid JSON request body" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { document_id, force_reprocess = false } = body;
  if (!document_id) {
    return new Response(
      JSON.stringify({ success: false, error: "Missing required parameter: document_id" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // 1. Load document record
  const { data: doc, error: docError } = await adminClient
    .from("crm_product_documents")
    .select("id, inquiry_id, enquiry_request_id, product_name, make, document_type, original_file_name, display_file_name, storage_bucket, storage_path, ai_extraction")
    .eq("id", document_id)
    .maybeSingle();

  if (docError || !doc) {
    return new Response(
      JSON.stringify({ success: false, error: `Document not found: ${document_id}` }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const existingExtraction = doc.ai_extraction as any;

  // 2. Idempotency & Concurrency Checks
  if (
    !force_reprocess &&
    existingExtraction &&
    ["suggested", "no_action", "accepted", "edited", "dismissed"].includes(existingExtraction.status)
  ) {
    return new Response(
      JSON.stringify({
        success: true,
        cached: true,
        document_id: doc.id,
        ai_extraction: existingExtraction,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Concurrency lock check (< 5 min)
  if (!force_reprocess && existingExtraction?.status === "processing" && existingExtraction.started_at) {
    const elapsed = Date.now() - new Date(existingExtraction.started_at).getTime();
    if (elapsed < 5 * 60 * 1000) {
      return new Response(
        JSON.stringify({
          success: true,
          in_progress: true,
          message: "Document extraction already in progress",
          document_id: doc.id,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }

  // Max retries check
  const currentRetryCount = existingExtraction?.retry_count || 0;
  if (!force_reprocess && existingExtraction?.status === "failed" && currentRetryCount >= 3) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Max retries reached (3). Manual re-analysis required.",
        retryable: false,
        document_id: doc.id,
      }),
      { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Set processing lock
  await adminClient
    .from("crm_product_documents")
    .update({
      ai_extraction: {
        status: "processing",
        started_at: new Date().toISOString(),
        retry_count: currentRetryCount,
      },
    })
    .eq("id", doc.id);

  const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiApiKey) {
    const failExtraction = {
      status: "failed",
      error: "OpenAI API key not configured on server",
      retry_count: currentRetryCount + 1,
      retryable: currentRetryCount + 1 < 3,
      attempted_at: new Date().toISOString(),
    };
    await adminClient
      .from("crm_product_documents")
      .update({ ai_extraction: failExtraction })
      .eq("id", doc.id);

    return new Response(
      JSON.stringify({
        success: false,
        error: "OpenAI API key not configured on server",
        retryable: true,
      }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // Download document from private storage bucket using service role credentials
    const bucket = doc.storage_bucket || "crm-documents";
    const { data: fileData, error: dlError } = await adminClient.storage
      .from(bucket)
      .download(doc.storage_path);

    let documentTextContent = "";
    if (!dlError && fileData) {
      // If text/json/csv, read as text
      const mime = fileData.type || "";
      if (mime.includes("text") || mime.includes("json") || mime.includes("csv") || doc.storage_path.endsWith(".txt")) {
        documentTextContent = await fileData.text();
      } else {
        // Fallback or binary file: extract filename and metadata
        documentTextContent = `[File: ${doc.display_file_name || doc.original_file_name}, Type: ${doc.document_type}, Product: ${doc.product_name || "Unknown"}, Make: ${doc.make || "Unknown"}]`;
      }
    } else {
      documentTextContent = `[File Metadata: ${doc.display_file_name || doc.original_file_name}, Declared Type: ${doc.document_type}, Product: ${doc.product_name || "Unknown"}, Make: ${doc.make || "Unknown"}]`;
    }

    const userPrompt = `Document Metadata:
- File Name: ${doc.display_file_name || doc.original_file_name}
- Stated Type: ${doc.document_type}
- Target Product: ${doc.product_name || "Not stated"}
- Manufacturer / Make: ${doc.make || "Not stated"}

Document Content:
${documentTextContent.slice(0, 15000)}

Extract all structured test parameters and metadata according to the system instructions.`;

    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      }),
    });

    if (!openaiResponse.ok) {
      const errText = await openaiResponse.text();
      throw new Error(`OpenAI API error (${openaiResponse.status}): ${errText}`);
    }

    const openaiData = await openaiResponse.json();
    const parsed = JSON.parse(openaiData.choices?.[0]?.message?.content || "{}");

    const extraction = {
      status: "suggested",
      document_type: parsed.document_type || doc.document_type || "OTHER",
      confidence_tier: ["HIGH", "MEDIUM", "LOW"].includes(parsed.confidence_tier) ? parsed.confidence_tier : "MEDIUM",
      needs_verification: !!parsed.needs_verification || parsed.confidence_tier === "LOW",
      product_name: parsed.product_name || doc.product_name || null,
      batch_number: parsed.batch_number || null,
      manufacturer: parsed.manufacturer || doc.make || null,
      manufacturing_date: parsed.manufacturing_date || null,
      expiry_date: parsed.expiry_date || null,
      document_number: parsed.document_number || null,
      hazard_classification: parsed.hazard_classification || null,
      summary: parsed.summary || `Extracted parameters for ${doc.display_file_name}`,
      parameters: Array.isArray(parsed.parameters) ? parsed.parameters : [],
      original_extraction: null, // Populated on human edit
      reviewed_by: null,
      reviewed_at: null,
      extracted_at: new Date().toISOString(),
      model: "gpt-4o-mini",
      retry_count: 0,
      retryable: false,
    };

    // Save to crm_product_documents.ai_extraction ONLY (zero mutations to requests or master data)
    await adminClient
      .from("crm_product_documents")
      .update({
        ai_extraction: extraction,
      })
      .eq("id", doc.id);

    return new Response(
      JSON.stringify({
        success: true,
        document_id: doc.id,
        ai_extraction: extraction,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error(`[enquiry-brain-document] Extraction error for doc ${doc.id}:`, err);

    const newRetry = currentRetryCount + 1;
    const isRetryable = newRetry < 3;
    const failExtraction = {
      status: "failed",
      error: err.message || "Failed to process document",
      retry_count: newRetry,
      retryable: isRetryable,
      attempted_at: new Date().toISOString(),
    };

    await adminClient
      .from("crm_product_documents")
      .update({ ai_extraction: failExtraction })
      .eq("id", doc.id);

    return new Response(
      JSON.stringify({
        success: false,
        error: err.message || "Failed to process document",
        retryable: isRetryable,
        retry_count: newRetry,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
