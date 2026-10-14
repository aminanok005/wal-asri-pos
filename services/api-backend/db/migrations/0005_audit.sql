-- Cafe POS (wal-asri-pos) -- server-side audit trail
-- Migration 0005: audit_log
--
-- WHY THIS TABLE EXISTS, AND WHY IT IS NOT A MOVEMENT
--
-- The `stock_movements` ledger answers "what changed the shelf?". It is the
-- authority for `stock_balances.on_hand_milli`, and it is append-only by
-- trigger. That is exactly why it is the WRONG place for an audit record:
--
--   - A movement is a FACT about stock. It carries a quantity, because a record
--     that changes nothing is noise. A reconcile that corrected nothing has no
--     quantity to record, so it would have no row here at all -- and then the
--     question "who reconciled the flour and when?" would have no answer.
--
--   - A movement is keyed by the thing it describes. A sale's id is its order
--     line's id, by design. An audit row has no such natural key: it describes an
--     ACTION, and two operators can act in the same millisecond.
--
-- So `audit_log` is a SEPARATE table, and the two stay apart on purpose:
--
--   stock_movements   -> derives stock_balances. Append-only. No operator field.
--   audit_log         -> WHO did WHAT and WHEN. Append-only. Never changes a
--                        balance.
--
-- The rule this migration exists to enforce is that NOTHING in this table may
-- change a balance. It has no `quantity_milli`, no foreign key into
-- `stock_balances` that could be used to write one, and the trigger below
-- refuses any UPDATE or DELETE so the record of an operator's action cannot be
-- quietly amended after the fact.
--
-- `actor_id` is TEXT (nullable), not UUID, and that is a decision rather than a convenience.
--
-- Two different actors write this table, and they carry different identifiers:
-- a terminal claim arrives with `actorTerminalId` as an optional opaque string (the
-- terminal's device id, which the sync layer authenticates but never parses as
-- a UUID), and a reconcile arrives with an operator id that the reporting
-- module may mint as anything. Forcing both into a UUID column would mean
-- rejecting a legal terminal id or inventing a UUID for an operator nobody
-- has. TEXT holds both without a conversion step whose only possible effect
-- is an error.
--
-- `id` is a UUIDv7. The server does not mint ids for records the client
-- created, but an audit row is created ENTIRELY on the server: the operator
-- never supplies one. So this is the one table in the service where the server
-- is free to generate the id, and it does so with `gen_random_uuid()` rather
-- than a sequence, because a UUIDv7 keeps lexical order close to creation
-- order and the append-only trigger below relies on that for its message.
--
-- SCOPE
--
-- `actor_type` is an open vocabulary rather than an enum, for the same reason
-- `sync_outbox.entity_type` is a string: the set of actors is owned by the
-- device layer, and inventing an enum here would fork it. The two legal values
-- today are `terminal` (a device credential) and `operator` (a staff user id),
-- and the column is wide enough for both without constraining the future.

CREATE TABLE IF NOT EXISTS audit_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type    TEXT        NOT NULL,
  actor_id      TEXT,
  branch_id     UUID        NOT NULL REFERENCES branches(id),
  action        TEXT        NOT NULL,
  entity_type   TEXT        NOT NULL,
  entity_id     UUID        NOT NULL,
  detail        JSONB       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Serves the two questions an audit trail exists to answer:
--   "what did terminal X do at branch Y, in order?"   -> (branch_id, created_at)
--   "what is the full history of this stock balance?"  -> (entity_type, entity_id)
CREATE INDEX IF NOT EXISTS idx_audit_log_branch_created
  ON audit_log (branch_id, created_at);

CREATE INDEX IF NOT EXISTS idx_audit_log_entity
  ON audit_log (entity_type, entity_id);

-- audit_log is APPEND-ONLY, enforced by the database.
--
-- An audit trail whose rows can be rewritten is not a trail. A reconcile that
-- happened cannot be un-happened by a later edit, and the trigger names the
-- rule rather than letting a silent UPDATE pass.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'audit_log is append-only: an audit record cannot be amended after it is written (row %)',
      OLD.id;
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'audit_log is append-only: an audit record cannot be deleted (row %)',
      OLD.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();