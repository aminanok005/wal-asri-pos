-- 0001_orders.sql — the authoritative server store for orders pushed from a terminal.
--
-- ── WHY THIS FILE IS THE FOURTH COPY OF THE MONEY RULES ────────────────────────
--
-- The VAT-inclusive rule and the signed-rounding rule now exist in four places:
--
--   1. TypeScript      apps/pos-desktop/src/features/payments/domain/money.ts
--   2. SQLite CHECKs    apps/pos-desktop/src-tauri/migrations/0001_init.sql
--   3. Go kernel        services/api-backend/internal/money/domain
--   4. THIS FILE
--
-- That is one more than is comfortable, and it is deliberate rather than
-- accidental. Copies 1-3 all fail at COMMIT in the terminal's own transaction, so
-- a cart bug cannot become a stored receipt. But they only ever see what a
-- TERMINAL wrote. This file is what makes the server's own ledger impossible to
-- corrupt: a bug in the Go usecase, a hand-run UPDATE, or a future service
-- writing with a different rounding rule is refused by the database rather than
-- becoming a tax figure nobody can reconcile.
--
-- The rule is that the strongest guarantee lives in the layer closest to the
-- bytes. The terminal is offline-first, so its SQLite CHECK is the only thing
-- standing between a cart bug and a printed receipt. This file is the same idea
-- for the server ledger.
--
-- ── SATANG IS BIGINT. NEVER numeric, NEVER float ───────────────────────────────
--
-- The contract (contracts/openapi.yaml) carries satang as a quoted STRING
-- (`Satang`: type: string, pattern ^(0|[1-9][0-9]*)$) because an unquoted value
-- would reach JavaScript as a double and lose precision past 2^53-1. That is a
-- WIRE concern, and it stops at this boundary. On disk a satang is a plain
-- BIGINT, because Postgres `numeric` would bring back exactly the decimal
-- ambiguity the whole design exists to remove, and a float would be worse.
--
-- The conversion happens in internal/order/adapter/postgres: money.Satang's
-- UnmarshalJSON enforces the contract grammar on the way in, and the value is
-- written as an integer on the way out.
--
-- ── VAT-INCLUSIVE, PER ORDER ───────────────────────────────────────────────────
--
-- Menu prices are VAT-INCLUSIVE. The tax sits INSIDE the amount charged, so:
--
--     gross             = subtotal_satang - discount_satang
--     total_satang      = gross + service_charge_satang + rounding_adjustment_satang
--     taxable_satang    = gross - tax_satang          (taxable is the NET)
--     taxable + tax     = gross                       (the invariant, below)
--     tax_satang        = gross - round_half_up(gross * 10000 / (10000 + vat_rate_bp))
--
-- Note what is absent from the last line: no term ADDS tax to the total. Under
-- inclusive pricing the tax is already inside the amount charged, and adding it
-- would bill the customer twice. That is the exact failure the removed
-- `taxable = subtotal - discount` identity used to permit.
--
-- ── WHY taxable_satang + tax_satang IS PINNED TO gross, NOT TO total ───────────
--
-- This is the whole reason a negative rounding adjustment is legal, so it is
-- worth being precise.
--
-- `rounding_adjustment_satang` settles the TENDER. It is not consideration for
-- goods, so it carries no VAT and must not appear in the decomposition. Pinning
-- `taxable + tax` to `gross` says exactly that.
--
-- Pinning it to `total` instead — as
-- `taxable + tax = total - service - rounding` — is ALGEBRAICALLY IDENTICAL while
-- service and rounding are zero, and DIVERGES SILENTLY once rounding goes
-- negative. With gross 4553, tax 298 and rounding -3:
--
--     total            = 4553 + 0 - 3        = 4550
--     taxable + tax    = 4255 + 298          = 4553  = gross   OK
--     but total        = 4550 != 4553                        the two forms disagree
--
-- Written the short way, the invariant holds for every sign of rounding. That is
-- not a cosmetic preference; it is the difference between a schema that permits
-- down-rounding and one that quietly forbids it.
--
-- ── ONE SIGNED COLUMN, AND ONLY ONE ───────────────────────────────────────────
--
-- `rounding_adjustment_satang` is the single negative-capable money column in
-- this schema, and it is negative precisely because cash rounding can land either
-- side of the exact total: ฿45.53 is not payable from a drawer of coins ending
-- in 5, so it goes to ฿45.50 or ฿45.55. Every other money column is CHECKed
-- >= 0, and that asymmetry is the guarantee that a negative PRICE or a negative
-- TOTAL cannot be stored.

-- ===========================================================================
-- branches
-- ===========================================================================
-- The VAT rate lives HERE and is read per ingest, never taken from the payload.
-- A terminal's rate is a client-originated figure: it may be a week stale.
CREATE TABLE IF NOT EXISTS branches (
  id          UUID        PRIMARY KEY,
  name        TEXT        NOT NULL,
  currency    CHAR(3)     NOT NULL DEFAULT 'THB'
                CHECK (currency ~ '^[A-Z]{3}$'),
  -- BASIS POINTS, 1bp = 0.01%, so 7.00% is 700 and is exact integer arithmetic.
  -- A float percentage would make 7% into 6.999999999.
  vat_rate_bp INTEGER     NOT NULL DEFAULT 700
                CHECK (vat_rate_bp >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN branches.vat_rate_bp IS
  'VAT rate in basis points. 700 = 7.00%. Read per ingest; never asserted by a client.';

-- ===========================================================================
-- orders
-- ===========================================================================
CREATE TABLE IF NOT EXISTS orders (
  -- CLIENT-GENERATED UUIDv7, and never a BIGSERIAL.
  --
  -- A terminal must be able to ring up a sale with no network, so the id has to
  -- exist before the server does. A server-assigned sequence would make every
  -- offline order unaddressable until sync, which is exactly when a manager needs
  -- to see it. UUIDv7 rather than UUIDv4 because the primary key is also the
  -- pagination cursor, and v7 is time-ordered so the index stays dense.
  id          UUID        PRIMARY KEY,

  -- Recorded, not derived. The branch a sale happened in is a fact about the sale;
  -- a terminal that is later reassigned must not rewrite the history of what it
  -- sold.
  branch_id   UUID        NOT NULL REFERENCES branches(id),
  terminal_id UUID        NOT NULL,
  staff_user_id UUID,

  -- Recorded when known, NULL when not. Deliberately NOT foreign keys: `terminals`,
  -- `staff_users` and `customers` are owned by other services that do not exist
  -- yet, and a foreign key to a table this database does not hold would make this
  -- migration unappliable. A bare UUID records the fact without inventing a
  -- dependency, and the reference can be constrained when the target tables arrive.
  dining_table_id UUID,
  customer_id     UUID,

  type        TEXT        NOT NULL
                CHECK (type IN ('dine_in', 'takeaway', 'delivery')),
  status      TEXT        NOT NULL
                CHECK (status IN ('draft', 'submitted', 'in_preparation', 'ready',
                                  'served', 'completed', 'void_requested', 'voided')),
  source      TEXT        NOT NULL DEFAULT 'pos_desktop'
                CHECK (source IN ('pos_desktop', 'pos_mobile', 'admin')),

  -- ── money: BIGINT satang, never numeric, never float ────────────────────────
  subtotal_satang      BIGINT NOT NULL CHECK (subtotal_satang      >= 0),
  discount_satang      BIGINT NOT NULL CHECK (discount_satang      >= 0),
  taxable_satang       BIGINT NOT NULL CHECK (taxable_satang       >= 0),
  tax_satang           BIGINT NOT NULL CHECK (tax_satang           >= 0),
  service_charge_satang BIGINT NOT NULL DEFAULT 0
                                        CHECK (service_charge_satang >= 0),
  -- THE signed column, and the ONLY money column with no `>= 0` guard.
  --
  -- Positive rounds the tender up, negative rounds it down, and both are ordinary
  -- because a drawer of notes and Thai coins (which end in 5 satang) cannot make
  -- ฿45.53 exactly. The absence of a CHECK here is the entire feature: every other
  -- money column above is guarded, so a negative PRICE or a negative TOTAL still
  -- cannot be stored.
  rounding_adjustment_satang BIGINT NOT NULL DEFAULT 0,
  total_satang         BIGINT NOT NULL,

  -- Stored WITH the order, not looked up at report time. A receipt must be
  -- re-priceable at the rate it was SOLD at, so a branch changing rate must not
  -- retroactively alter a historical receipt.
  vat_rate_bp INTEGER   NOT NULL CHECK (vat_rate_bp >= 0),

  loyalty_points_earned INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_points_earned >= 0),

  -- Free text for the cashier, e.g. "customer asked for less ice". Never parsed by
  -- code: the contract is explicit that a human-readable field "must not be
  -- parsed", and an end-of-shift report grouping on it would be reading a note as
  -- structured data.
  notes         TEXT,

  -- When `status` last changed. Not derivable from `updated_at`, which moves for
  -- any non-money edit, so a status history could not otherwise be reconstructed.
  status_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ── THE BALANCE INVARIANTS ────────────────────────────────────────────────
  --
  -- A discount cannot exceed what it discounts.
  CONSTRAINT orders_discount_within_subtotal
    CHECK (discount_satang <= subtotal_satang),

  -- total = gross + service_charge + rounding_adjustment
  --
  -- The one that catches a mis-summed order. It is why a negative adjustment is
  -- not merely tolerated but accounted for.
  CONSTRAINT orders_total_is_gross_plus_extras
    CHECK (total_satang = subtotal_satang - discount_satang
                          + service_charge_satang
                          + rounding_adjustment_satang),

  -- taxable + tax = gross, i.e. = subtotal - discount.
  --
  -- Pinned to GROSS, not to total. This is what makes signed rounding safe: the
  -- tender settlement cannot move the VAT base, so the tax halves a receipt
  -- declares are the same whether the total was rounded up, down, or not at all.
  CONSTRAINT orders_taxable_plus_tax_equals_gross
    CHECK (taxable_satang + tax_satang = subtotal_satang - discount_satang),

  -- The extraction formula itself, re-derived in SQL so a wrong tax figure cannot
  -- be STORED even if it somehow reached this table.
  --
  --     tax = gross - round_half_up(gross * 10000 / (10000 + vat_rate_bp))
  --
  -- Half-up on a non-negative ratio is  floor((2a + b) / 2b), so the nudge and the
  -- division below are that formula spelled out.
  --
  -- EVERYTHING here is BIGINT on purpose. An earlier draft cast to NUMERIC to
  -- dodge overflow, and that was a real bug rather than a precaution: NUMERIC
  -- division is exact rather than truncating, so the result was 4255.85... and the
  -- subsequent ::bigint cast ROUNDED it to 4256 — quietly turning the half-up into
  -- a round-half-up of an already-nudged value and rejecting a correct ฿45.53 order
  -- with `tax 298, expected 297`. Money that is BIGINT stays BIGINT all the way
  -- through, so the `/` truncates exactly once.
  --
  -- No guard is needed on the divisor: vat_rate_bp is CHECKed >= 0, so
  -- 10000 + vat_rate_bp >= 10000 and can never be zero.
  CONSTRAINT orders_tax_is_extracted_from_gross
    CHECK (
      tax_satang = (subtotal_satang - discount_satang)
                   - (((subtotal_satang - discount_satang) * 10000 * 2
                       + (10000 + vat_rate_bp))
                      / (2 * (10000 + vat_rate_bp)))
    ),

  -- An order with no lines has no price, so a zero total would be a rounding
  -- artefact rather than an amount. Guaranteed by the repository writing the
  -- header and its lines in ONE transaction, which is the same obligation the
  -- terminal's §2.2 write carries.
  --
  -- NAMED rather than inline so a violation reports which rule was broken. "A
  -- negative total is a refund, which is a separate document" is actionable; a
  -- bare constraint name is not.
  CONSTRAINT orders_total_not_negative CHECK (total_satang >= 0)
);

COMMENT ON COLUMN orders.rounding_adjustment_satang IS
  'THE signed money column. Positive rounds the tender up, negative rounds it '
  'down. Both are ordinary: cash rounding to a payable coin can land either side '
  'of the exact total. Settles the tender, so it carries no VAT and is absent '
  'from the taxable+tax invariant.';

COMMENT ON CONSTRAINT orders_taxable_plus_tax_equals_gross ON orders IS
  'taxable_satang is the NET (VAT-exclusive) extracted from the VAT-inclusive '
  'gross. Pinned to gross rather than total so that a negative rounding '
  'adjustment cannot silently break the VAT base.';

CREATE INDEX IF NOT EXISTS idx_orders_branch_created
  ON orders (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status
  ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_terminal
  ON orders (terminal_id);

-- ===========================================================================
-- order_lines
-- ===========================================================================
CREATE TABLE IF NOT EXISTS order_lines (
  id                 UUID   PRIMARY KEY,
  order_id           UUID   NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  product_variant_id UUID   NOT NULL,

  -- DECIMAL, NOT integer. A café sells 0.005 of a garnish and 1.5 portions, and
  -- rounding a quantity to a whole unit would either overcharge or invent a
  -- portion that was never rung up. NUMERIC(12,3) — three fractional digits is
  -- the contract's Quantity pattern.
  --
  -- This is the ONE place a decimal is correct, and it is worth being explicit
  -- about why it does not contradict "never numeric": the rule is that MONEY is
  -- never a decimal. A quantity is not money; it is multiplied by an integer
  -- satang price and the product is rounded to satang exactly once, by the Go
  -- kernel. A money column as numeric would be ambiguous, because numeric carries
  -- a scale that a reader would have to guess. A quantity as integer would lose
  -- real amounts.
  quantity           NUMERIC(12,3) NOT NULL CHECK (quantity > 0),

  unit_price_satang  BIGINT NOT NULL CHECK (unit_price_satang  >= 0),
  line_discount_satang BIGINT NOT NULL DEFAULT 0
                                   CHECK (line_discount_satang >= 0),
  -- VAT-INCLUSIVE unit price: the menu price the customer is shown.
  --
  -- ALWAYS 0, and CHECKed. Not an oversight: VAT is rounded once per ORDER, so
  -- there is no per-line VAT to store. A non-zero value would be a line-level
  -- rounding the order-level figure does not contain, and the two would disagree
  -- by a satang on some lines — drift a tax return cannot absorb.
  line_tax_satang    BIGINT NOT NULL DEFAULT 0
                        CHECK (line_tax_satang = 0),
  line_total_satang  BIGINT NOT NULL CHECK (line_total_satang  >= 0),

  sequence            INTEGER NOT NULL DEFAULT 0,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A discount cannot exceed the line it discounts.
  CONSTRAINT order_lines_discount_within_line
    CHECK (line_discount_satang <= unit_price_satang * quantity),

  -- The line's own arithmetic, re-derived here.
  --
  --     line_total = round_half_up(unit_price * quantity) - discount + line_tax
  --
  -- `round()` on NUMERIC rounds half AWAY FROM ZERO, which is round-half-up for
  -- the non-negative products this table permits (unit_price CHECKed >= 0,
  -- quantity CHECKed > 0).
  --
  -- An earlier draft spelled the half-up out as `((p*q*2 + 1) / 2)::bigint`, on the
  -- theory that integer division truncates. That theory is wrong the moment
  -- `quantity` is NUMERIC: the expression is evaluated in NUMERIC — where division
  -- is exact rather than truncating — and the ::bigint cast then ROUNDS on top of
  -- the nudge. It reported `1 x 4550` as 4551 and `1.5 x 4550` as 6826, so a
  -- correctly-priced line was rejected. Same trap as the order-level formula above,
  -- caught by comparing the two side by side rather than by reading the arithmetic.
  CONSTRAINT order_lines_total_is_price_minus_discount
    CHECK (
      line_total_satang
        = round(unit_price_satang * quantity)::bigint
          - line_discount_satang
          + line_tax_satang
    )
);

COMMENT ON COLUMN order_lines.line_tax_satang IS
  'ALWAYS 0, CHECKed. VAT is rounded once per order; a per-line figure would be a '
  'second, differently rounded copy of money the order total already contains.';

CREATE INDEX IF NOT EXISTS idx_order_lines_order
  ON order_lines (order_id, sequence);

-- ===========================================================================
-- idempotency_keys
-- ===========================================================================
-- The duplicate-order interceptor.
--
-- The failure it exists to prevent: a terminal pushes a batch, the server commits
-- it, the response is lost on a NAT timeout the terminal cannot distinguish from a
-- crash. The terminal retries the SAME key. Without a store of what it already
-- answered, that retry is a SECOND order — a real duplicate, a real second charge,
-- and a customer at the counter being asked to pay twice.
--
-- The contract on a retry is NOT "do it again". It is: return the ORIGINAL
-- response.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  -- SHA-256 of (terminal_id || client_key), hex. HASHED, never the raw client
  -- key: the key is client-supplied and therefore attacker-supplied, and a raw
  -- key in a unique index is a lookup oracle for "does this key exist" that a
  -- client could point at another terminal's keys.
  key_hash     CHAR(64)   PRIMARY KEY
                 CHECK (key_hash ~ '^[0-9a-f]{64}$'),

  -- NOT NULL and NOT a foreign key to orders, on purpose: the key is recorded
  -- for submissions that were REJECTED too, and those have no order.
  entity_id    UUID        NOT NULL,
  entity_type  TEXT        NOT NULL DEFAULT 'order',

  -- The server-side ledger vocabulary, deliberately NOT the terminal's local
  -- `sync_outbox` values (pending/in_flight/done/failed_permanent). Those are a
  -- different aggregate: the local one asks "has my terminal handed this to the
  -- network", this one asks "has the server durably accepted it".
  state        TEXT        NOT NULL
                 CHECK (state IN ('PENDING', 'IN_FLIGHT', 'ACKNOWLEDGED', 'CONFLICT_HELD')),

  -- The ORIGINAL answer, replayed verbatim on a duplicate.
  --
  -- Stored rather than recomputed because pricing depends on the branch's VAT
  -- rate at the moment of the ORIGINAL sale: re-running the maths today could
  -- return a different total for an order that was already charged.
  response     TEXT        NOT NULL,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,

  -- The 24h window is load-bearing on the READ side: without this index, an
  -- expired row would still be found and a key reused years later would be
  -- refused as a duplicate of a long-dead sale.
  CONSTRAINT idempotency_window_is_sane CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expiry
  ON idempotency_keys (expires_at);

-- ===========================================================================
-- sync_outbox_items
-- ===========================================================================
-- The SERVER-side ledger of what this server has accepted from every terminal.
--
-- Not the terminal's local outbox. The terminal asks "has my terminal handed this
-- to the network yet?"; this asks "has this server durably accepted it?". A
-- submission can leave the terminal's outbox (done) and still be IN_FLIGHT here.
CREATE TABLE IF NOT EXISTS sync_outbox_items (
  id              UUID   PRIMARY KEY,
  entity_id       UUID   NOT NULL,
  entity_type     TEXT   NOT NULL DEFAULT 'order',
  action          TEXT   NOT NULL
                    CHECK (action IN ('push_order', 'push_shift', 'pull_catalog',
                                     'pull_customers', 'pull_settings')),
  terminal_id     UUID   NOT NULL,

  -- The per-COMMAND key, distinct from the batch header key. The batch header
  -- stops a whole batch being reprocessed; this stops a single event being
  -- applied twice when two DIFFERENT batches overlap.
  idempotency_key_hash CHAR(64)
                    CHECK (idempotency_key_hash IS NULL
                           OR idempotency_key_hash ~ '^[0-9a-f]{64}$'),

  state           TEXT   NOT NULL DEFAULT 'PENDING'
                    CHECK (state IN ('PENDING', 'IN_FLIGHT', 'ACKNOWLEDGED', 'CONFLICT_HELD')),
  attempt_count   INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),

  -- For an operator. Never parsed by code: the contract is explicit that a
  -- human-readable message "must not be parsed".
  last_error      TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ,

  -- processed_at is set for exactly the terminal states.
  CONSTRAINT sync_outbox_processed_iff_terminal
    CHECK ((state IN ('ACKNOWLEDGED', 'CONFLICT_HELD')) = (processed_at IS NOT NULL))
);

COMMENT ON TABLE sync_outbox_items IS
  'The SERVER-side ledger. Distinct from the terminal''s local sync_outbox, which '
  'asks a different question about a different aggregate.';

CREATE INDEX IF NOT EXISTS idx_sync_outbox_due
  ON sync_outbox_items (state, due_at);

-- ===========================================================================
-- APPEND-ONLY, enforced by the database
-- ===========================================================================
-- ARCHITECTURE-DEMO.md: "Orders: append-only, never edited, so no conflict."
--
-- That is not a convention a Go caller observes — it has to be a trigger, because
-- a service bug must fail rather than quietly rewrite a sale that happened. The
-- terminal's own schema has the same rule for the same reason.
--
-- Deliberately NOT `UPDATE OF status`-style scoping: the protected columns are
-- the money and the identity. A void is a NEW order plus a transition, and the
-- status ladder is monotonic, so a status change is legitimate — what must never
-- change is what was sold or for how much.
CREATE OR REPLACE FUNCTION orders_money_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.subtotal_satang      IS DISTINCT FROM NEW.subtotal_satang
     OR OLD.discount_satang      IS DISTINCT FROM NEW.discount_satang
     OR OLD.taxable_satang       IS DISTINCT FROM NEW.taxable_satang
     OR OLD.tax_satang           IS DISTINCT FROM NEW.tax_satang
     OR OLD.service_charge_satang IS DISTINCT FROM NEW.service_charge_satang
     OR OLD.rounding_adjustment_satang IS DISTINCT FROM NEW.rounding_adjustment_satang
     OR OLD.total_satang         IS DISTINCT FROM NEW.total_satang
     OR OLD.vat_rate_bp          IS DISTINCT FROM NEW.vat_rate_bp
  THEN
    RAISE EXCEPTION
      'money columns on orders are immutable: a committed sale is never restated '
      'in place — void it and ring a new order (order %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_money_immutable
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_money_immutable();

CREATE OR REPLACE FUNCTION order_lines_money_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.unit_price_satang    IS DISTINCT FROM NEW.unit_price_satang
     OR OLD.line_discount_satang IS DISTINCT FROM NEW.line_discount_satang
     OR OLD.line_tax_satang     IS DISTINCT FROM NEW.line_tax_satang
     OR OLD.line_total_satang   IS DISTINCT FROM NEW.line_total_satang
     OR OLD.quantity             IS DISTINCT FROM NEW.quantity
  THEN
    RAISE EXCEPTION
      'money columns on order_lines are immutable: a committed line is never '
      'restated in place — void and re-ring instead (line %) ', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER order_lines_money_immutable
  BEFORE UPDATE ON order_lines
  FOR EACH ROW EXECUTE FUNCTION order_lines_money_immutable();

-- A committed sale is never deleted. Retention/PDPA pruning is a separate policy
-- decision, and a POS that can silently lose a receipt cannot settle a shift.
CREATE OR REPLACE FUNCTION orders_no_delete() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'DELETE on orders is forbidden; a committed sale is permanent '
    '(retention/PDPA pruning policy is undecided)'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_no_delete
  BEFORE DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_no_delete();

CREATE OR REPLACE FUNCTION order_lines_no_delete() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'DELETE on order_lines is forbidden; retention/PDPA pruning policy is undecided'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER order_lines_no_delete
  BEFORE DELETE ON order_lines
  FOR EACH ROW EXECUTE FUNCTION order_lines_no_delete();

-- The outbox ledger is append-only in identity and mutable in state: the id,
-- action, entity and key are fixed on insert; only the state, attempt count and
-- last error change. "What happened cannot be rewritten, only delivered or
-- retried."
CREATE OR REPLACE FUNCTION sync_outbox_append_only() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.entity_id IS DISTINCT FROM NEW.entity_id
     OR OLD.entity_type IS DISTINCT FROM NEW.entity_type
     OR OLD.action IS DISTINCT FROM NEW.action
     OR OLD.terminal_id IS DISTINCT FROM NEW.terminal_id
     OR OLD.idempotency_key_hash IS DISTINCT FROM NEW.idempotency_key_hash
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION
      'sync_outbox_items is append-only in identity: id, entity, action, terminal '
      'and key are fixed on insert and only the state may change (item %) ', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- And a terminal state is final: a delivery already acknowledged must not be
  -- dragged back to IN_FLIGHT by a concurrent worker.
  IF OLD.state IN ('ACKNOWLEDGED', 'CONFLICT_HELD')
     AND NEW.state IS DISTINCT FROM OLD.state
  THEN
    RAISE EXCEPTION
      'sync_outbox_items item % is already % and cannot move to %; a duplicate '
      'submission must be answered from the idempotency store, not by replaying '
      'the transition', OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sync_outbox_append_only
  BEFORE UPDATE ON sync_outbox_items
  FOR EACH ROW EXECUTE FUNCTION sync_outbox_append_only();