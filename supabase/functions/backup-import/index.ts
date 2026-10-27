import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const BACKUP_VERSION = "1.0";

const REQUIRED_TABLES = [
  "products",
  "customers",
  "batches",
  "sales_invoices",
  "sales_invoice_items",
  "delivery_challans",
  "delivery_challan_items",
  "inventory_transactions",
] as const;

type TableName = typeof REQUIRED_TABLES[number];

const INSERT_ORDER: TableName[] = [
  "products",
  "customers",
  "batches",
  "sales_invoices",
  "delivery_challans",
  "sales_invoice_items",
  "delivery_challan_items",
  "inventory_transactions",
];

const TRUNCATE_ORDER = [
  "delivery_challan_items",
  "sales_invoice_items",
  "inventory_transactions",
  "delivery_challans",
  "sales_invoices",
  "batches",
  "customers",
  "products",
];

interface BackupEnvelope {
  version: string;
  exported_at: string;
  data: Record<TableName, Record<string, unknown>[]>;
}

function validateEnvelope(body: unknown): BackupEnvelope {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Payload must be a JSON object");
  }
  const obj = body as Record<string, unknown>;

  if (!("version" in obj)) {
    throw new Error("Invalid backup version");
  }
  if (obj["version"] !== BACKUP_VERSION) {
    throw new Error(`Invalid backup version: expected "${BACKUP_VERSION}", got "${obj["version"]}"`);
  }

  if (typeof obj["data"] !== "object" || obj["data"] === null || Array.isArray(obj["data"])) {
    throw new Error('Backup must contain a "data" object');
  }

  const data = obj["data"] as Record<string, unknown>;
  for (const table of REQUIRED_TABLES) {
    if (!(table in data)) {
      throw new Error(`Missing required table in backup data: ${table}`);
    }
    if (!Array.isArray(data[table])) {
      throw new Error(`Table "${table}" must be an array`);
    }
  }

  return obj as unknown as BackupEnvelope;
}

function buildInsertQuery(
  table: string,
  rows: Record<string, unknown>[]
): { text: string; values: unknown[] } | null {
  if (rows.length === 0) return null;

  const keys = Object.keys(rows[0]);
  const IDENT_RE = /^[a-zA-Z0-9_]+$/;
  for (const key of keys) {
    if (!IDENT_RE.test(key)) {
      throw new Error(`Invalid column name in backup for table ${table}: ${key}`);
    }
  }
  if (keys.length === 0) return null;

  const columnList = keys.map((k) => `"${k}"`).join(", ");
  const placeholderRows: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  for (const row of rows) {
    const placeholders = keys.map(() => `$${idx++}`).join(", ");
    placeholderRows.push(`(${placeholders})`);
    for (const key of keys) {
      const val = row[key];
      values.push(val === undefined ? null : val);
    }
  }

  const text = `INSERT INTO "${table}" (${columnList}) VALUES ${placeholderRows.join(", ")}`;
  return { text, values };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: profile } = await adminClient
      .from("user_profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    if (!profile || profile.role !== "admin") {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const envelope = validateEnvelope(body);

    const dbUrl = Deno.env.get("SUPABASE_DB_URL");
    if (!dbUrl) {
      throw new Error("Database URL not configured");
    }

    const sql = postgres(dbUrl, { max: 1 });

    try {
      await sql.begin(async (tx) => {
        for (const table of TRUNCATE_ORDER) {
          await tx.unsafe(`TRUNCATE TABLE "${table}" CASCADE`);
        }

        for (const table of INSERT_ORDER) {
          const rows = envelope.data[table] ?? [];
          if (rows.length === 0) continue;
          const query = buildInsertQuery(table, rows);
          if (!query) continue;
          await tx.unsafe(query.text, query.values as never[]);
        }

        for (const table of INSERT_ORDER) {
          await tx.unsafe(`
            DO $$
            DECLARE
              seq_name text;
              max_id bigint;
            BEGIN
              SELECT pg_get_serial_sequence('"${table}"', 'id') INTO seq_name;
              IF seq_name IS NOT NULL THEN
                SELECT COALESCE(MAX(id::bigint), 0) INTO max_id FROM "${table}";
                PERFORM setval(seq_name, GREATEST(max_id, 1));
              END IF;
            EXCEPTION WHEN others THEN
              NULL;
            END $$;
          `);
        }
      });
    } finally {
      await sql.end();
    }

    const counts: Record<string, number> = {};
    for (const table of INSERT_ORDER) {
      counts[table] = envelope.data[table]?.length ?? 0;
    }

    return new Response(
      JSON.stringify({ success: true, imported: counts }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const message = (err as Error).message ?? "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
