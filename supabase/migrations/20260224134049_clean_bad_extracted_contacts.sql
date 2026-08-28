/*
  # Clean bad extracted contacts data
  
  Remove contacts where:
  - Company is our own company (PT Shubham Anzen Pharma Jaya)
  - Email is mismatched (e.g. Sanbe company with Novapharin email)
  - Email came from mailer-daemon (bounced mail)
  - Customer name is generic like "Sales", "Purchasing", "NOVAPHARIN GRESIK" used as both name and company
  - Emails from our own domain
*/

DELETE FROM extracted_contacts 
WHERE 
  LOWER(company_name) LIKE '%shubham anzen%'
  OR LOWER(company_name) LIKE '%sapharmajaya%'
  OR LOWER(company_name) LIKE '%sa pharma jaya%'
  OR email_ids LIKE '%sapharmajaya.co.id%'
  OR email_ids LIKE '%mailer-daemon%'
  OR email_ids LIKE '%tom@dochub%'
  OR (LOWER(customer_name) IN ('sales', 'purchasing', 'admin', 'marketing', 'accounts') )
  OR (company_name ILIKE '%SANBE%' AND email_ids ILIKE '%novapharin%')
  OR (company_name ILIKE '%Trifa%' AND email_ids NOT ILIKE '%trifa%')
  OR (company_name ILIKE '%Actavis%' AND email_ids NOT ILIKE '%actavis%')
  OR (company_name ILIKE '%Sydna%' AND email_ids NOT ILIKE '%sydna%')
  OR (company_name ILIKE '%Merck%' AND email_ids NOT ILIKE '%merck%')
  OR (company_name = customer_name AND UPPER(company_name) = company_name);
