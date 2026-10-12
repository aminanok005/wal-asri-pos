-- ============================================================================
-- MIGRATION 0005 — offline refunds (void_requested/voided states)
-- ============================================================================
--
-- The states `void_requested` and `voided` were already defined in the
-- `local_orders` CHECK constraint in 0001_init.sql. This migration serves to
-- officially enable them for the offline refund flow and provide a version
-- bump for the terminal's schema state.
--
-- No DDL changes required as the status check constraint already covers
-- these states.
--

PRAGMA user_version = 5;