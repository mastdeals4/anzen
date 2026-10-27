-- Resolve PostgREST ambiguity between the legacy two-argument function and the
-- newer five-argument function whose trailing arguments all have defaults.
-- The canonical five-argument function retains defaults, so existing two-arg
-- callers resolve to it and continue to use the established rounding behavior.
DROP FUNCTION public.apply_receipt_allocation_rounding_adjustment(uuid, uuid);
