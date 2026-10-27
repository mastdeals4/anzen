-- Force PostgREST to reload its schema cache so save_payment_voucher_with_purpose is visible.
NOTIFY pgrst, 'reload schema';
