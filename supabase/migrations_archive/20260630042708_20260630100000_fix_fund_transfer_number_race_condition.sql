CREATE OR REPLACE FUNCTION public.generate_fund_transfer_number()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year   TEXT;
  v_month  TEXT;
  v_prefix TEXT;
  v_max    INT;
  v_number TEXT;
BEGIN
  v_year   := TO_CHAR(CURRENT_DATE, 'YY');
  v_month  := TO_CHAR(CURRENT_DATE, 'MM');
  v_prefix := 'FT' || v_year || v_month;

  PERFORM pg_advisory_xact_lock(
    hashtext('ft_number_' || v_year || v_month)
  );

  SELECT COALESCE(
           MAX(
             CAST(
               SUBSTRING(transfer_number FROM '^FT\d{4}-(\d+)$')
               AS INTEGER
             )
           ),
           0
         ) + 1
    INTO v_max
    FROM fund_transfers
   WHERE transfer_number LIKE v_prefix || '-%';

  v_number := v_prefix || '-' || LPAD(v_max::TEXT, 4, '0');
  RETURN v_number;
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_fund_transfer_number() TO authenticated;
