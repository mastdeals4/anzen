/*
  # Fix bank transaction hash to include running balance

  The previous hash only used: bank_account_id | date | debit | credit | description
  This caused collisions when two legitimate transactions have the same date, amount,
  and description (e.g., multiple "BIF BIAYA TXN" fees on the same day).

  Fix: Include running_balance in the hash, making each entry at a unique point
  in the statement uniquely identifiable.

  Note: For entries with no balance (balance=0), we also append a statement upload_id
  to ensure uniqueness within the same upload batch.
*/

CREATE OR REPLACE FUNCTION generate_bank_transaction_hash(
  p_bank_account_id UUID,
  p_transaction_date DATE,
  p_debit_amount NUMERIC,
  p_credit_amount NUMERIC,
  p_description TEXT,
  p_running_balance NUMERIC DEFAULT 0,
  p_upload_id UUID DEFAULT NULL
) RETURNS TEXT AS $$
DECLARE
  v_normalized_desc TEXT;
  v_hash_input TEXT;
BEGIN
  v_normalized_desc := LOWER(TRIM(REGEXP_REPLACE(COALESCE(p_description, ''), '\s+', ' ', 'g')));
  v_normalized_desc := LEFT(v_normalized_desc, 100);

  v_hash_input := p_bank_account_id::TEXT || '|' ||
                  p_transaction_date::TEXT || '|' ||
                  COALESCE(p_debit_amount, 0)::TEXT || '|' ||
                  COALESCE(p_credit_amount, 0)::TEXT || '|' ||
                  v_normalized_desc || '|' ||
                  COALESCE(p_running_balance, 0)::TEXT;

  -- If balance is 0 (not provided) and upload_id is given, use it to distinguish entries
  IF COALESCE(p_running_balance, 0) = 0 AND p_upload_id IS NOT NULL THEN
    v_hash_input := v_hash_input || '|' || p_upload_id::TEXT;
  END IF;

  RETURN md5(v_hash_input);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Update the auto-generate trigger to use the new function signature
CREATE OR REPLACE FUNCTION auto_generate_transaction_hash()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.transaction_hash := generate_bank_transaction_hash(
    NEW.bank_account_id,
    NEW.transaction_date,
    NEW.debit_amount,
    NEW.credit_amount,
    NEW.description,
    NEW.running_balance,
    NEW.upload_id
  );
  RETURN NEW;
END;
$$;
