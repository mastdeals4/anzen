/*
  # Fix bank COA account normal_balance values

  1. Changes
    - Set normal_balance to 'debit' for Bank BCA - IDR (111101)
    - Set normal_balance to 'debit' for Bank BCA - USD (111102)
    - These are asset accounts and must have debit as normal balance

  2. Impact
    - Fixes Account Ledger opening balance calculation for bank accounts
    - Ensures Account Ledger and Bank Ledger show consistent balances
*/

UPDATE chart_of_accounts 
SET normal_balance = 'debit' 
WHERE code IN ('111101', '111102') 
AND normal_balance IS NULL;