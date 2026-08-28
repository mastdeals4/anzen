/*
  # Add Air Conditioners Fixed Asset Account

  Adds "Air Conditioners" as a fixed asset account under the Fixed Assets group (1200).

  New Accounts:
  - 1203: Air Conditioners (asset type) - for tracking AC units purchased as fixed assets
*/

INSERT INTO chart_of_accounts (code, name, account_type, parent_id, is_active)
SELECT
  '1203',
  'Air Conditioners',
  'asset',
  (SELECT id FROM chart_of_accounts WHERE code = '1200' LIMIT 1),
  true
WHERE NOT EXISTS (
  SELECT 1 FROM chart_of_accounts WHERE code = '1203'
);
