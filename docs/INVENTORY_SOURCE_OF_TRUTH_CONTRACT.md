# INVENTORY DATA ACCESS ARCHITECTURE & SOURCE OF TRUTH CONTRACT

## 1. Executive Principle

> **LEGACY DATA CAN EXIST. LEGACY DATA MUST NOT CONTAMINATE OPERATIONAL ANSWERS.**
> **THERE IS EXACTLY ONE OPERATIONAL INVENTORY SOURCE OF TRUTH.**

Historical ledger anomalies, unclassified pre-cutover migrations, and legacy audit compensation records remain in the database strictly for historical forensics and statutory audit. Under no circumstances may AI assistants, analytical dashboards, reporting views, or operational workflows read directly from or aggregate legacy transaction logs to answer operational questions.

---

## 2. Canonical Operational Inventory Sources

The **ONLY** approved sources for live inventory, historical operational movements, and stock analytics are:

| Purpose | Canonical Source | Object Type | Description |
| :--- | :--- | :--- | :--- |
| **Current Stock & Availability** | `public.inventory_v1_stock_summary` | VIEW | Authoritative live stock per active product, usable stock, active reservations, and shortage. |
| **Operational Stock Movement** | `public.inventory_v1_movement_report(p_date_from, p_date_to)` | FUNCTION | Deterministic movement report: `Opening + In - Out = Closing` for any requested date window. |
| **Physical Movement Reconciled Ledger** | `public.inventory_operational_physical_ledger` | VIEW | Reconciled atomic physical movements: certified batch imports (`+`), approved delivery challans (`-`), and canonical returns/adjustments. |
| **AI Operational Current Stock** | `public.ai_inventory_current` | VIEW | Read-only AI interface exposing canonical live stock without legacy contamination. |
| **AI Operational Movement** | `public.ai_inventory_movement(p_date_from, p_date_to)` | FUNCTION | Read-only AI function computing verified period movement without legacy noise. |

---

## 3. Legacy Data Classification (Audit & Forensics Only)

The following tables are classified as **LEGACY INVENTORY HISTORY - AUDIT / FORENSIC ONLY**:
- `public.inventory_transactions`
- `public.inventory_historical_movement_classifications`
- `public.audit_removed_duplicate_sale_inventory_transactions`

### Rules of Engagement:
1. **Do NOT Delete**: Legacy records are preserved for immutable database provenance and forensic audit trail.
2. **Do NOT Treat as Operational Stock**: Never compute operational stock, closing stock, or movement by summing `inventory_transactions`.
3. **No Mixed Queries**: Do NOT combine `batches` + `delivery_challans` + `inventory_transactions` independently in ad-hoc queries. The canonical reporting layer (`inventory_operational_physical_ledger`) handles internal reconciliation to ensure that **one economic movement = exactly one reported movement**.

---

## 4. AI Safety Contract & Query Routing Guidelines

AI agents, chat assistants, and automated reporting workers must strictly adhere to the following dispatch matrix:

```
                      ┌─────────────────────────────────────────┐
                      │   User / Client Inventory Question      │
                      └────────────────────┬────────────────────┘
                                           │
         ┌─────────────────────────────────┴─────────────────────────────────┐
         ▼                                                                   ▼
[Operational Query]                                                 [Historical Audit Query]
- "What is current stock?"                                          - "Show old inventory transactions"
- "What was stock on date X?"                                       - "Show historical inventory corrections"
- "How much came in / went out?"                                    - "Explain legacy stock migration"
- "Are we low on inventory?"                                        - "Audit pre-V1 transaction discrepancies"
         │                                                                   │
         ▼                                                                   ▼
┌─────────────────────────────────┐                                 ┌─────────────────────────────────┐
│ CANONICAL SOURCES ONLY:         │                                 │ FORENSIC AUDIT ACCESS:          │
│ • ai_inventory_current          │                                 │ • Query legacy tables           │
│ • ai_inventory_movement(d1, d2) │                                 │ • Label response:               │
│ • inventory_v1_stock_summary    │                                 │   "LEGACY / HISTORICAL AUDIT"   │
│ • inventory_v1_movement_report  │                                 │ • MUST NOT mix into current or  │
└─────────────────────────────────┘                                 │   operational stock calculations│
                                                                    └─────────────────────────────────┘
```

### Explicit Directives:
- **"What is current stock?"**
  $\rightarrow$ Query `public.ai_inventory_current` (or `public.inventory_v1_stock_summary`).
- **"What was stock on date X?"**
  $\rightarrow$ Call `public.ai_inventory_movement('2025-01-01', X)` and inspect `closing`.
- **"How much came in/out during period?"**
  $\rightarrow$ Call `public.ai_inventory_movement(p_date_from, p_date_to)`.
- **"Why does an old historical record differ?"**
  $\rightarrow$ Query legacy audit tables, but label the output explicitly as `LEGACY / HISTORICAL AUDIT` and state that it has no effect on canonical operational balances.

---

## 5. Mathematical Contract for Operational Inventory

For all operational inventory calculations:

$$\text{Opening} + \text{In} - \text{Out} = \text{Closing}$$

1. **Closing Stock**: The exact stock position at the requested end date (`p_date_to`).
2. **Current Stock**: Live physical stock available today in the warehouse (`total_current_stock`).
3. **Reserved Stock**: Active sales order reservations only (`status = 'active'`).
4. **Available Stock**: Calculated as:
   $$\text{Available Stock} = \text{Usable Current Stock} - \text{Active Reserved Stock}$$
5. **Reservations are NOT Physical Movements**: A reservation allocates stock for a sales order, but does NOT reduce physical batch stock or generate physical dispatch movement until an approved Delivery Challan is created.

---

## 6. Database Permission Design

To guarantee architectural separation:
1. **Dedicated Role**: `reporting_ai_role` is granted `SELECT` on `public.ai_inventory_current` and `EXECUTE` on `public.ai_inventory_movement(date, date)`:
   - View `public.ai_inventory_current` is created with `security_invoker = false` (owned by `postgres`).
   - Function `public.ai_inventory_movement(date, date)` is created with `SECURITY DEFINER` (owned by `postgres`).
   - This design allows `reporting_ai_role` to retrieve canonical live stock and deterministic period movements without requiring broad `SELECT` privileges on raw ERP tables (`products`, `batches`, `so_product_reservations`, `delivery_challan_items`, etc.).
2. **Explicit Revocation on Legacy Tables**: `reporting_ai_role` has **NO** access (`REVOKE ALL`) to legacy tables:
   - `public.inventory_transactions`
   - `public.inventory_historical_movement_classifications`
   - `public.audit_removed_duplicate_sale_inventory_transactions`
3. **Application Safety**: ERP application service roles (`authenticated`, `service_role`) retain required transactional permissions to ensure uninterrupted day-to-day warehouse operations.

---

## 7. External Connector Authentication Note

> [!IMPORTANT]
> **External Connector Privileges (ChatGPT / Supabase MCP)**:
> The external ChatGPT/Supabase connector may use a separate privileged database credential (such as `postgres` or `service_role`).
> Database migrations cannot force an external connector session to assume `reporting_ai_role`.
> 
> Therefore, all operational AI tools, prompts, connectors, and analytical queries **MUST** explicitly target:
> - `public.ai_inventory_current` (for current stock & availability)
> - `public.ai_inventory_movement(p_date_from, p_date_to)` (for historical/period movement)
> 
> and must **NEVER** construct queries against legacy tables (`inventory_transactions`, `inventory_historical_movement_classifications`, `audit_removed_duplicate_sale_inventory_transactions`).

