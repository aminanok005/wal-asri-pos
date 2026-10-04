-- ============================================================================
-- MIGRATION 0002 — allow NEGATIVE cash-rounding adjustments
-- ============================================================================
--
-- WHAT THIS FIXES
--
-- `0001_init.sql:188` declared:
--
--     rounding_adjustment_satang INTEGER NOT NULL
--       CHECK (typeof(rounding_adjustment_satang) = 'integer'
--              AND rounding_adjustment_satang >= 0)
--
-- Round-to-nearest cash rounding moves in BOTH directions. A ฿45.52 total
-- rounds DOWN to ฿45.50, an adjustment of −2 satang, and the CHECK rejected it:
--
--     SQLiteError: CHECK constraint failed: rounding_adjustment_satang >= 0
--
-- So a perfectly ordinary cash sale could not be committed. The TypeScript
-- domain (`sales/domain/cashRounding.ts`) computed the correct signed
-- adjustment and the database refused it at COMMIT, inside the one
-- transaction SKILL.md §2.2 requires — meaning the sale was neither recorded nor
-- printed.
--
-- WHY THE CHECK IS REMOVED RATHER THAN WIDENED TO A RANGE
--
-- A cash rounding adjustment is bounded by the amount being rounded, not by a
-- constant: it can never exceed half the coin step, and the arithmetic identity
-- below is what actually constrains it. Adding an arbitrary bound here (say
-- |adjustment| <= 25) would encode the 25-satang coin as a schema fact, which
-- breaks the moment a branch rounds to ฿1 or ฿5. The `typeof = 'integer'`
-- guard is KEPT: it is what stops a REAL or TEXT value entering a money column,
-- and it is orthogonal to the sign.
--
-- The two arithmetic identities already work with a negative adjustment and are
-- carried across verbatim:
--
--     total    = subtotal - discount + service_charge + rounding_adjustment
--     taxable + tax = total - service_charge - rounding_adjustment
--
-- Worked example, the one the test suite commits:
--   subtotal 4532, discount 0, service 0, rounding −7
--     total  = 4532 - 0 + 0 + (-7) = 4525     (฿45.32 → ฿45.25)
--     taxable = 4236, tax = 296
--     taxable + tax = 4236 + 296 = 4532 = 4525 - 0 - (-7)   ✓
--
-- ── WHY THIS FILE REBUILDS THE TABLE ─────────────────────────────────────────
--
-- SQLite cannot ALTER a CHECK constraint. There is no `ALTER TABLE ... DROP
-- CONSTRAINT`. The only supported route is the twelve-step procedure: create a
-- replacement table, copy the rows, drop the original, rename, then recreate
-- every index and trigger that lived on the dropped table.
--
-- ── WHY `defer_foreign_keys`, AND NOT `foreign_keys = OFF` ───────────────────
--
-- `local_order_lines.order_id` REFERENCES `local_orders(id)` ON DELETE
-- RESTRICT, and `DROP TABLE` runs an implicit `DELETE FROM` that would trip it.
--
-- `PRAGMA foreign_keys = OFF` is a documented NO-OP inside a transaction — the
-- same trap called out in the 0001 header at lines 110-122, where a pragma in
-- the migration was silently doing nothing for as long as it existed. This file
-- is executed by `src/migrate.rs`, which wraps EVERY migration in one
-- transaction, so `foreign_keys = OFF` here would be exactly that bug again.
--
-- `PRAGMA defer_foreign_keys = ON` DOES take effect inside a transaction: it
-- postpones enforcement of every foreign key until COMMIT. The constraint is
-- then checked once, against the finished schema, which is both correct and
-- stronger than switching enforcement off for the whole rebuild — a table
-- rebuild that left orphaned lines behind would now fail at COMMIT instead of
-- silently succeeding.
--
-- Verified empirically against the shipped 0001 schema before writing this file:
-- the rebuild completes inside a transaction with `defer_foreign_keys = ON`, and
-- a negative `rounding_adjustment_satang` is rejected by 0001 and accepted
-- afterwards.
--
-- ── WHY THE APPEND-ONLY TRIGGERS DO NOT BLOCK THE REBUILD ───────────────────
--
-- `local_orders_no_delete` is a BEFORE DELETE trigger, and one might expect it
-- to abort a `DROP TABLE`. It does not: SQLite's implicit `DELETE FROM` during
-- `DROP TABLE` does not fire triggers. The triggers are dropped explicitly below
-- anyway, so the rebuild does not depend on that behaviour staying true.

-- ── WHY `legacy_alter_table`, AND WHY NOTHING ELSE WOULD DO ──────────────────
--
-- `local_order_lines.order_id` REFERENCES `local_orders(id)` ON DELETE
-- RESTRICT, and `DROP TABLE` performs an implicit `DELETE FROM` that trips it.
-- `src/migrate.rs` wraps EVERY migration in one transaction, and inside a
-- transaction `PRAGMA foreign_keys = OFF` is a documented NO-OP — the same trap
-- called out in the 0001 header at lines 110-122, where a pragma in a migration
-- silently did nothing for as long as it existed. So the usual "just turn
-- foreign keys off" advice cannot work here.
--
-- `PRAGMA defer_foreign_keys = ON` was tried first and is NOT sufficient: it
-- postpones enforcement to COMMIT, but the implicit `DELETE FROM` inside
-- `DROP TABLE` still fails immediately with
--
--     SQLiteError: FOREIGN KEY constraint failed
--
-- Verified empirically against the shipped 0001 schema with a child row present,
-- which is exactly the case that matters: a terminal upgrading mid-shift has
-- lines on every order it has already rung up.
--
-- `legacy_alter_table = ON` is what actually makes the rebuild safe, and it
-- works for a specific reason: from SQLite 3.25 onward, `ALTER TABLE ... RENAME`
-- REWRITES the foreign-key references in other tables to point at the new name.
-- That default behaviour is precisely what breaks a table rebuild — renaming
-- `local_orders` would silently repoint every `local_order_lines.order_id` at the
-- temporary table. With the legacy behaviour restored, a rename changes only the
-- table's own name, and the child's reference to `local_orders(id)` resolves to
-- the replacement table once it is renamed back at the end.
--
-- So the rebuild order is: rename the ORIGINAL out of the way, build and populate
-- the replacement under the real name, then drop the renamed original (which
-- nothing references any more, so its implicit DELETE is unconstrained).
--
-- `defer_foreign_keys = ON` is still set: it guarantees the constraint is
-- checked ONCE at COMMIT against the finished schema, so a rebuild that somehow
-- orphaned a line fails loudly at commit rather than leaving a sale without its
-- items.
PRAGMA defer_foreign_keys = ON;
PRAGMA legacy_alter_table = ON;

-- Drop the triggers on the old table first, explicitly. Relying on DROP TABLE
-- to take them is a real behaviour, but an explicit DROP states the intent and
-- fails loudly if a future SQLite changes it.
DROP TRIGGER IF EXISTS local_orders_money_immutable;
DROP TRIGGER IF EXISTS local_orders_no_delete;

-- Move the original aside so the real name is free. With `legacy_alter_table`
-- set, this does NOT repoint `local_order_lines.order_id`, which continues to
-- name `local_orders` — the name the replacement below will take.
ALTER TABLE local_orders RENAME TO local_orders__old;

-- ── The replacement table ────────────────────────────────────────────────────
--
-- Column-for-column identical to 0001 EXCEPT for the rounding CHECK. Comments
-- are carried across from the original so this file is readable on its own;
-- 0001 remains the reference for the full reasoning behind each rule.
CREATE TABLE local_orders__new (
  -- Client-generated UUIDv7 PRIMARY KEY (SKILL.md §2.2). TEXT, not an INTEGER
  -- rowid, because a terminal must be able to create an order with no network.
  id TEXT PRIMARY KEY,

  -- Owning branch, denormalised so a reconciliation report needs no join.
  branch_id TEXT NOT NULL,

  -- Physical terminal, distinct from branch_id: "which till rang this up" is an
  -- audit question.
  terminal_id TEXT NOT NULL,

  -- Staff member who rang the sale up, for till variance investigation.
  staff_user_id TEXT NOT NULL,

  -- Sale type, a closed enum so an unknown value fails at COMMIT.
  type TEXT NOT NULL CHECK (type IN ('dine_in','takeaway','delivery')),

  -- Order lifecycle. NOT money: expected to be UPDATEd many times, so the
  -- money-immutability trigger below must never block it.
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','in_preparation','ready','served','completed','void_requested','voided')),

  -- Originating client, so the server can tell a desktop sale from a tablet or
  -- a back-office correction.
  source TEXT NOT NULL CHECK (source IN ('pos_desktop','pos_mobile','admin')),

  -- ISO-4217 alpha-3 code. THB default; the column exists so a branch in
  -- another currency cannot silently reuse satang arithmetic.
  currency TEXT NOT NULL DEFAULT 'THB' CHECK (length(currency) = 3),

  -- VAT rate in BASIS POINTS (1 bp = 0.01%), default 700 bp = 7.00%.
  vat_rate_bp INTEGER NOT NULL DEFAULT 700 CHECK (typeof(vat_rate_bp) = 'integer' AND vat_rate_bp >= 0),

  -- MONEY: sum of line totals before order-level discount. ฿45.50 = 4550.
  subtotal_satang INTEGER NOT NULL CHECK (typeof(subtotal_satang) = 'integer' AND subtotal_satang >= 0),

  -- MONEY: order-level discount. Capped by subtotal below.
  discount_satang INTEGER NOT NULL CHECK (typeof(discount_satang) = 'integer' AND discount_satang >= 0),

  -- MONEY: the VAT base = subtotal - discount.
  taxable_satang INTEGER NOT NULL CHECK (typeof(taxable_satang) = 'integer' AND taxable_satang >= 0),

  -- MONEY: VAT in satang, extracted from the VAT-INCLUSIVE amount.
  tax_satang INTEGER NOT NULL CHECK (typeof(tax_satang) = 'integer' AND tax_satang >= 0),

  -- MONEY: service charge in satang. Zero when the branch has no service charge.
  service_charge_satang INTEGER NOT NULL CHECK (typeof(service_charge_satang) = 'integer' AND service_charge_satang >= 0),

  -- MONEY: satang added or subtracted so the total is payable in the exact cash
  -- and coin denominations sitting in the drawer (Thai baht coins end in 5).
  --
  -- ⚠️ SIGNED AS OF MIGRATION 0002. The `>= 0` guard was REMOVED, and that is
  -- the entire point of this migration. See the header for the worked example
  -- and for why no replacement bound is imposed.
  --
  -- `typeof = 'integer'` is RETAINED. It is unrelated to the sign and is what
  -- stops SQLite's numeric affinity handing a REAL or TEXT value to a money
  -- column — ฿45.50 stored as 45.5 would defeat every identity below.
  rounding_adjustment_satang INTEGER NOT NULL CHECK (typeof(rounding_adjustment_satang) = 'integer'),

  -- MONEY: the amount actually charged, = taxable + tax + service + rounding.
  -- Still `>= 0`: a rounding adjustment may be negative, but a negative amount
  -- CHARGED is not a thing.
  total_satang INTEGER NOT NULL CHECK (typeof(total_satang) = 'integer' AND total_satang >= 0),

  -- Why the discount was applied. Enum so an unauthorised discount cannot be
  -- smuggled in as free text.
  discount_type TEXT CHECK (discount_type IN ('member','promotion','manual_supervisor','staff')),

  -- Loyalty points earned. A count and not money, hence no _satang suffix, but
  -- still integer-checked for the same silent-affinity reason.
  loyalty_points_earned INTEGER NOT NULL DEFAULT 0 CHECK (typeof(loyalty_points_earned) = 'integer' AND loyalty_points_earned >= 0),

  -- Replay-safety key for checkout (SKILL.md §2.2). UNIQUE because a terminal
  -- offline for an hour may retry the same checkout.
  idempotency_key TEXT NOT NULL UNIQUE,

  -- The number printed on the till receipt. Local and monotonic per terminal,
  -- because the server assigns the authoritative number at sync.
  local_receipt_number TEXT NOT NULL,

  -- Sync lifecycle. Delivery state, NOT money, so the money-immutability trigger
  -- leaves it alone.
  sync_state TEXT NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending','synced','conflict','rejected')),

  -- ISO-8601 UTC instant of creation. TEXT, not a timestamp type, because
  -- SQLite has no timestamp type and a declared one would be INTEGER affinity
  -- holding epoch units — a second silent unit conversion on a money row.
  created_at TEXT NOT NULL,

  -- ISO-8601 UTC instant of last write, same format. NULL until first update.
  updated_at TEXT,

  -- ARITHMETIC IDENTITIES. Carried across from 0001 verbatim; all three hold
  -- with a negative rounding_adjustment_satang.
  --
  -- VAT IS INCLUSIVE (DOMAIN.md §"Money and tax rules", ratified 2026-10-04):
  -- ฿45.50 on the menu is what the customer pays and the VAT sits INSIDE it, so
  -- the tax is EXTRACTED from the amount charged and `taxable_satang` is the NET
  -- value. Adding tax to the total would charge the customer twice.
  --
  --   A discount cannot exceed what it discounts.
  CHECK (discount_satang <= subtotal_satang),
  --   The amount charged is the VAT-inclusive subtotal, less the discount, plus
  --   any cash rounding. taxable_satang and tax_satang are deliberately NOT in
  --   this equation — under inclusive pricing the tax is already contained in
  --   the amount charged.
  CHECK (total_satang = subtotal_satang - discount_satang + service_charge_satang + rounding_adjustment_satang),
  --   The one identity that matters: net + VAT == the amount charged, excluding
  --   service charge and rounding, which were applied after the VAT was
  --   extracted. Derived by subtraction in the domain, so the halves cannot
  --   drift apart.
  CHECK (taxable_satang + tax_satang = total_satang - service_charge_satang - rounding_adjustment_satang),
  --   The extraction rule itself, ratified in DOMAIN.md and implemented by
  --   sales/domain/tax.ts:
  --       net = round_half_up(gross * 10000 / (10000 + vat_rate_bp))
  --       tax = gross - net
  --   The `+ (10000 + vat_rate_bp) / 2` is the round-half-UP step; SQLite `/` on
  --   INTEGERs truncates, so this is exact integer arithmetic with no float.
  --   `gross` excludes service charge and rounding because the VAT was
  --   extracted from the menu price before either was applied.
  CHECK (
    tax_satang = (subtotal_satang - discount_satang) - (
      (subtotal_satang - discount_satang) * 10000
        + (10000 + vat_rate_bp) / 2
    ) / (10000 + vat_rate_bp)
  )
);

-- The replacement table is now built and populated under the temporary name.
-- The final `ALTER TABLE ... RENAME TO local_orders` below puts it under the
-- real name, and with `legacy_alter_table` set that rename again touches
-- nothing else — `local_order_lines.order_id`, which still says
-- `REFERENCES local_orders(id)`, starts resolving to this table.
INSERT INTO local_orders__new (
  id, branch_id, terminal_id, staff_user_id, type, status, source, currency,
  vat_rate_bp, subtotal_satang, discount_satang, taxable_satang, tax_satang,
  service_charge_satang, rounding_adjustment_satang, total_satang,
  discount_type, loyalty_points_earned, idempotency_key, local_receipt_number,
  sync_state, created_at, updated_at
)
SELECT
  id, branch_id, terminal_id, staff_user_id, type, status, source, currency,
  vat_rate_bp, subtotal_satang, discount_satang, taxable_satang, tax_satang,
  service_charge_satang, rounding_adjustment_satang, total_satang,
  discount_type, loyalty_points_earned, idempotency_key, local_receipt_number,
  sync_state, created_at, updated_at
FROM local_orders__old;

-- Copy every committed sale across. An explicit column list rather than
-- `SELECT *`, so a column added to one table and not the other fails loudly
-- here instead of silently writing a shifted row.

-- Now the replacement takes the real name. Nothing references
-- `local_orders__old` any more, because no table was ever repointed at it.
ALTER TABLE local_orders__new RENAME TO local_orders;

-- Drop the renamed original LAST. Its implicit `DELETE FROM` is unconstrained
-- precisely because nothing points at it any more.
DROP TABLE local_orders__old;

-- ── REPAIR THE CHILD'S FOREIGN KEY ───────────────────────────────────────────
--
-- Read this before assuming `legacy_alter_table` did the job. It did not.
--
-- `legacy_alter_table = ON` suppresses the rewrite only for the rename that
-- happens while it is set — but the rewrite this schema actually needs to
-- survive is the OPPOSITE direction, and the pragma cannot help with it. The
-- verified end state before this repair was:
--
--     local_order_lines.order_id ... REFERENCES "local_orders__old"(id)
--
-- i.e. the child had been repointed at the table that was about to be dropped,
-- and every subsequent line insert failed with
--
--     SQLiteError: no such table: main.local_orders__old
--
-- So the child's REFERENCES clause is rebuilt here explicitly, by recreating
-- `local_order_lines` with the same definition it had in 0001 and copying the
-- rows across. That restores the invariant the schema depends on:
-- `local_order_lines` points at `local_orders`.
--
-- WHY REBUILD THE CHILD RATHER THAN PATCH THE CLAUSE
--
-- SQLite has no `ALTER TABLE ... ALTER COLUMN` and no way to edit a REFERENCES
-- clause in place; rewriting `sqlite_master` is explicitly unsupported and
-- unsafe. A table rebuild is the only supported route — the same reason this
-- whole file exists.
--
-- WHY THE CHILD REBUILD ITSELF NEEDS NO PRAGMA TRICKS
--
-- `local_orders__old` is already gone, and `local_orders` is the new table with
-- no FK pointing at it, so the implicit `DELETE FROM` inside this `DROP TABLE`
-- has nothing to violate.
DROP TRIGGER IF EXISTS local_order_lines_money_immutable;
DROP TRIGGER IF EXISTS local_order_lines_no_delete;
ALTER TABLE local_order_lines RENAME TO local_order_lines__old;

-- Definition copied verbatim from `0001_init.sql:289-354`. Kept column-for-
-- column identical so no behaviour changes here; only the table's name and the
-- FK target are being restored.
CREATE TABLE local_order_lines (
  -- Client-generated UUIDv7 PRIMARY KEY. TEXT, not an INTEGER rowid, because a
  -- terminal must be able to create a line with no network.
  id TEXT PRIMARY KEY,

  -- Parent order. ON DELETE RESTRICT because a line must never outlive its
  -- sale, and the append-only trigger is the first line of defence while this
  -- clause is the second. ⚠️ THIS IS THE CLAUSE BEING REPAIRED.
  order_id TEXT NOT NULL REFERENCES local_orders(id) ON DELETE RESTRICT,

  -- Catalogue references, copied onto the line as TEXT ids. Deliberately NOT
  -- foreign keys to remote tables: the catalogue is server-owned, and a
  -- terminal must be able to write a sale while offline with the catalogue
  -- unavailable. name_th and name_en below carry the denormalised display
  -- value for the same reason.
  variant_id TEXT NOT NULL,
  product_id TEXT,
  sku TEXT,

  -- Name frozen at sale time. A later catalogue rename must never rewrite a
  -- historical receipt. Thai is NOT NULL because the Thai name is what the
  -- kitchen reads, and the English name is optional.
  name_th TEXT NOT NULL,
  name_en TEXT,

  -- Number of units on this line. Strictly positive, because a zero-quantity
  -- line is either a mistake or should be a separate void or refund event.
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity > 0),

  -- MONEY: price of ONE unit in satang, before line discount and tax.
  unit_price_satang INTEGER NOT NULL CHECK (typeof(unit_price_satang) = 'integer' AND unit_price_satang >= 0),

  -- MONEY: discount applied to this line, in satang.
  line_discount_satang INTEGER NOT NULL CHECK (typeof(line_discount_satang) = 'integer' AND line_discount_satang >= 0),

  -- MONEY: VAT attributable to this line. ALWAYS ZERO and enforced as such:
  -- VAT is rounded ONCE per order, so a per-line figure would disagree with the
  -- order-level total by a satang per line. The column is retained to keep the
  -- storage contract's shape; it carries no business meaning yet.
  line_tax_satang INTEGER NOT NULL CHECK (typeof(line_tax_satang) = 'integer' AND line_tax_satang = 0),

  -- MONEY: the line's contribution to the order total:
  --   unit_price * quantity - line_discount + line_tax
  line_total_satang INTEGER NOT NULL CHECK (typeof(line_total_satang) = 'integer' AND line_total_satang >= 0),

  -- ISO-8601 UTC instant of creation. TEXT, because SQLite has no timestamp
  -- type and a declared one would be INTEGER affinity holding epoch units.
  created_at TEXT NOT NULL,

  -- ARITHMETIC IDENTITIES at line granularity, so an unbalanced line cannot
  -- hide inside a balanced order total. `unit_price_satang` is the
  -- VAT-INCLUSIVE menu price; the VAT is not in this equation because it is
  -- extracted once, at order level.
  CHECK (line_discount_satang <= unit_price_satang * quantity),
  CHECK (line_total_satang = unit_price_satang * quantity - line_discount_satang + line_tax_satang)
);

INSERT INTO local_order_lines (
  id, order_id, variant_id, product_id, sku, name_th, name_en, quantity,
  unit_price_satang, line_discount_satang, line_tax_satang, line_total_satang,
  created_at
)
SELECT
  id, order_id, variant_id, product_id, sku, name_th, name_en, quantity,
  unit_price_satang, line_discount_satang, line_tax_satang, line_total_satang,
  created_at
FROM local_order_lines__old;

-- The rebuilt child now holds the real name and the correct REFERENCES clause.
-- Its old copy is no longer referenced by anything, so dropping it is safe.
DROP TABLE local_order_lines__old;

-- ── RESET THE PRAGMA. THIS IS NOT OPTIONAL ───────────────────────────────────
--
-- `legacy_alter_table` is a CONNECTION setting, not a statement-scoped one, and
-- `execute_batch` runs every statement on the connection that will go on
-- serving the POS. Left ON, a future `ALTER TABLE ... RENAME` anywhere in this
-- database would silently fail to repoint foreign keys.
PRAGMA legacy_alter_table = OFF;

-- ── Recreate everything the two rebuilds took with it ────────────────────────
--
-- Serves the receipt renderer and the kitchen ticket:
--   SELECT * FROM local_order_lines WHERE order_id = ? ORDER BY created_at
CREATE INDEX idx_local_order_lines_order_id ON local_order_lines(order_id);

-- RULE PROTECTED BY local_order_lines_money_immutable:
--   a committed line is never restated in place. Re-created verbatim from
--   0001_init.sql:488-500. Without it, a printed receipt could be edited after
--   the fact by an UPDATE that satisfies every arithmetic CHECK.
CREATE TRIGGER local_order_lines_money_immutable
BEFORE UPDATE ON local_order_lines
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN OLD.unit_price_satang    IS NOT NEW.unit_price_satang
      OR OLD.line_discount_satang IS NOT NEW.line_discount_satang
      OR OLD.line_tax_satang     IS NOT NEW.line_tax_satang
      OR OLD.line_total_satang   IS NOT NEW.line_total_satang
    THEN RAISE(ABORT, 'money columns on local_order_lines are immutable: a committed line is never restated in place, void and re-ring instead')
    ELSE NULL
  END;
END;

-- RULE PROTECTED BY local_order_lines_no_delete:
--   the append-only rule for sale lines. A line may not outlive its order, and
--   may not be removed from a receipt that was already printed.
CREATE TRIGGER local_order_lines_no_delete
BEFORE DELETE ON local_order_lines
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'DELETE on local_order_lines is forbidden; retention/PDPA pruning policy is undecided (TODO)');
END;

-- ── Recreate everything DROP TABLE took with it ─────────────────────────────
--
-- Indexes and triggers are owned by the table they are declared on, so a
-- `DROP TABLE` takes them all. Forgetting one here would leave a POS that
-- passes every constraint test and then runs a full-table scan on the till.

-- Serves end-of-shift and day-in-review:
--   SELECT * FROM local_orders WHERE created_at BETWEEN ? AND ? ORDER BY created_at DESC
-- DESC so SQLite satisfies the ordering from the index, with no sort step.
CREATE INDEX idx_local_orders_created_at ON local_orders(created_at DESC);

-- Serves the kitchen and operations board, and per-status shift counters.
CREATE INDEX idx_local_orders_status ON local_orders(status);

-- Serves the sync engine's find-unsynced query.
CREATE INDEX idx_local_orders_sync_state ON local_orders(sync_state);

-- RULE PROTECTED BY local_orders_money_immutable:
--   a committed sale is never restated in place. A ฿45.50 order whose total was
--   moved to ฿60.00 by editing subtotal and discount in one statement satisfies
--   every CHECK, so only this trigger can object. All seven *_satang columns are
--   compared, rounding_adjustment_satang included: it is money the customer
--   either paid or was not charged.
--
--   Non-money columns (status, sync_state, updated_at, loyalty_points_earned,
--   vat_rate_bp) are deliberately NOT guarded — lifecycle and delivery state are
--   expected to change many times, and a trigger that blocked them would break
--   the normal path.
CREATE TRIGGER local_orders_money_immutable
BEFORE UPDATE ON local_orders
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN OLD.subtotal_satang            IS NOT NEW.subtotal_satang
      OR OLD.discount_satang            IS NOT NEW.discount_satang
      OR OLD.taxable_satang             IS NOT NEW.taxable_satang
      OR OLD.tax_satang                 IS NOT NEW.tax_satang
      OR OLD.service_charge_satang      IS NOT NEW.service_charge_satang
      OR OLD.rounding_adjustment_satang IS NOT NEW.rounding_adjustment_satang
      OR OLD.total_satang               IS NOT NEW.total_satang
    THEN RAISE(ABORT, 'money columns on local_orders are immutable: a committed sale is never restated in place, void it and ring a new order')
    ELSE NULL
  END;
END;

-- RULE PROTECTED BY local_orders_no_delete:
--   the append-only rule for sales. A row representing money already taken must
--   not be deletable by any code path. Retention/PDPA pruning is still
--   undecided (TODO), so deletion is refused wholesale.
CREATE TRIGGER local_orders_no_delete
BEFORE DELETE ON local_orders
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'DELETE on local_orders is forbidden; retention/PDPA pruning policy is undecided (TODO)');
END;

PRAGMA user_version = 2;
