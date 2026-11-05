-- Migration: Create crm_contact_phones table for multi-phone management per company and contact
-- Migration ID: 20261103020000_create_crm_contact_phones_table.sql

CREATE TABLE IF NOT EXISTS public.crm_contact_phones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id UUID NOT NULL REFERENCES public.crm_contacts(id) ON DELETE CASCADE,
    company_name TEXT NOT NULL,
    contact_person TEXT,
    department TEXT DEFAULT 'Purchasing', -- Purchasing, Import, QA / QC, Sales, Finance, Management, General Office
    raw_phone TEXT NOT NULL,
    normalized_phone TEXT,
    country_code TEXT DEFAULT '+62',
    country_name TEXT DEFAULT 'Indonesia',
    phone_type TEXT NOT NULL DEFAULT 'valid_mobile', -- 'valid_mobile', 'landline', 'international_number', 'invalid_number'
    is_whatsapp_eligible BOOLEAN NOT NULL DEFAULT false,
    is_primary BOOLEAN NOT NULL DEFAULT false,
    consent_status TEXT NOT NULL DEFAULT 'pending', -- 'opted_in', 'pending', 'opted_out'
    extension TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Indexes for performance & query isolation
CREATE INDEX IF NOT EXISTS idx_crm_contact_phones_contact_id ON public.crm_contact_phones(contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_contact_phones_normalized ON public.crm_contact_phones(normalized_phone);
CREATE INDEX IF NOT EXISTS idx_crm_contact_phones_wa_eligible ON public.crm_contact_phones(is_whatsapp_eligible);
CREATE INDEX IF NOT EXISTS idx_crm_contact_phones_dept ON public.crm_contact_phones(department);

-- Enable Row Level Security
ALTER TABLE public.crm_contact_phones ENABLE ROW LEVEL SECURITY;

-- Policies for Authenticated & Anon Access
CREATE POLICY "Allow authenticated read crm_contact_phones"
    ON public.crm_contact_phones FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Allow authenticated insert crm_contact_phones"
    ON public.crm_contact_phones FOR INSERT
    TO authenticated
    WITH CHECK (true);

CREATE POLICY "Allow authenticated update crm_contact_phones"
    ON public.crm_contact_phones FOR UPDATE
    TO authenticated
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Allow authenticated delete crm_contact_phones"
    ON public.crm_contact_phones FOR DELETE
    TO authenticated
    USING (true);

CREATE POLICY "Allow anon read crm_contact_phones"
    ON public.crm_contact_phones FOR SELECT
    TO anon
    USING (true);

CREATE POLICY "Allow anon insert crm_contact_phones"
    ON public.crm_contact_phones FOR INSERT
    TO anon
    WITH CHECK (true);

CREATE POLICY "Allow anon update crm_contact_phones"
    ON public.crm_contact_phones FOR UPDATE
    TO anon
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Allow anon delete crm_contact_phones"
    ON public.crm_contact_phones FOR DELETE
    TO anon
    USING (true);

CREATE POLICY "Allow service_role all crm_contact_phones"
    ON public.crm_contact_phones FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

