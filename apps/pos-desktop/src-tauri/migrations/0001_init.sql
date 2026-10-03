-- 0001_init.sql — local SQLite foundation for the offline-first sell path.
--
-- PURPOSE
--   This migration creates the terminal's entire local write surface: the
--   committed sale (`local_orders`), its lines (`local_order_lines`), and the
--   transactional outbox (`sync_outbox`) that SKILL.md §2.2 requires checkout
--   to fill inside one transaction before any network call is attempted.
--   Nothing here reads from the network, and nothing here is replaced later:
--   see MIGRATION POLICY below.
--
-- MIGRATION POLICY
--   Naming: NNNN_description.sql, four-digit zero-padded, applied strictly in
--   ascending order by the Rust migrator in `src/migrate.rs`.
--   Forward-only. There are NO down migrations. A shipped terminal has already
--   taken real money, so "un-applying" a migration is never safe, and
--   corrections are new migrations (0002_..., 0003_...) that transform data
--   forward. Never edit a migration that has shipped to a device: terminals
--   apply each version exactly once and record it in `PRAGMA user_version`,
--   so an edited 0001 would leave already-upgraded installs on the OLD schema
--   while new installs get the NEW one.
--
-- HOW THIS FILE REACHES THE BINARY
--   `src/migrate.rs` embeds it with `include_str!` and applies it in one
--   transaction per file. The bytes are compiled into the executable, so a
--   terminal in airplane mode on a machine with no source tree can still create
--   its own database.
--
--   (It used to reach the binary the same way, but through
--   `tauri_plugin_sql::Builder::add_migrations`. That plugin is gone — SKILL.md
--   §2.2 requires the checkout's three writes to commit in ONE transaction, and
--   the plugin's frontend API is one statement per call — so the migration
--   runner is now our own, keyed on `PRAGMA user_version`. See the NOTE at the
--   end of this file.)
--
-- TODO(NAMING): SKILL.md §2.2 shows an example table named `outbox_events`,
--   while the name agreed and implemented here is `sync_outbox`. Only ONE table
--   exists, `sync_outbox`. A human must reconcile SKILL.md with the code
--   (either amend the skill's example, or rename the table in a forward
--   migration). Do not create both tables to make the discrepancy disappear.
--
-- ============================================================================
-- THE STRICT MONEY RULE (SKILL.md §2.1) — READ THIS BEFORE ADDING A COLUMN
-- ============================================================================
--
-- Every `*_satang` column in this schema holds an INTEGER number of satang,
-- the minor unit of the Thai baht. There is no stored "baht" column anywhere.
-- ฿45.50 is stored as 4550. ฿0.07 is stored as 7. There is no third decimal.
--
-- FORBIDDEN, without exception, for any monetary value:
--     REAL, FLOAT, DOUBLE, DOUBLE PRECISION, NUMERIC, DECIMAL
-- A float money column is a latent accounting defect. 0.1 + 0.2 !== 0.3 in
-- binary floating point, so a ฿45.50 sale summed as REAL yields 5249.999999999,
-- the receipt does not balance to the satang, and the discrepancy is invisible
-- until a human tries to reconcile the shift.
--
-- WHY EVERY MONEY COLUMN CARRIES `CHECK (typeof(col) = 'integer')`
-- ---------------------------------------------------------------
-- This is NOT belt-and-braces. SQLite has no column types, it has type
-- AFFINITY. A column declared `INTEGER` states a *preference* about how a
-- value should be stored, not a promise that it is. Declaring
--
--     total_satang INTEGER
--
-- and then storing 45.5 succeeds silently: 45.5 is not losslessly convertible
-- to an integer, so SQLite keeps it as-is and records storage class REAL.
-- `SELECT typeof(total_satang)` then answers 'real', the row is in the table,
-- and nothing complained. Declaring NUMERIC or REAL instead is worse rather
-- than better, because those affinities accept 45.5 as the intended value.
--
-- So INTEGER affinity alone does NOT reject a float, and only
-- `CHECK (typeof(col) = 'integer')` does. The `typeof()` half rejects REAL and
-- rejects unconvertible TEXT (a money column can never hold 'abc'), while the
-- `>= 0` half rejects negative satang, which is never a legitimate amount on a
-- sale. A refund or a reversal is a separate row with its own event type, not
-- a negative price.
--
-- THE HONEST LIMIT OF THAT CHECK — numeric strings are still coerced
-- -----------------------------------------------------------------
-- `CHECK (typeof(col) = 'integer')` CANNOT reject a numeric-looking string.
-- SQLite applies INTEGER affinity to the TEXT value '4550', finds it is a
-- well-formed integer literal, converts it, and stores storage class INTEGER.
-- By the time the CHECK runs, the evidence that the caller passed a string is
-- already gone: CHECK constraints observe POST-COERCION values, and there is
-- no way to inspect the original literal from inside a CHECK.
-- apps/pos-desktop/test/migrations.test.ts pins this as an ACCEPTED case on
-- purpose, so that nobody later "fixes" it with a check that cannot work.
--
-- THE CONSEQUENCE IS AN APPLICATION RULE, NOT A SCHEMA ONE:
-- money must never cross into SQL as a string. The real boundary is the
-- `Money` value object in
-- apps/pos-desktop/src/features/payments/domain/money.ts, whose satang count is
-- a `bigint`, since `fromSatang` throws a `MoneyError` on a non-bigint. The
-- second boundary is the Tauri command boundary in `src/commands.rs`.
--
--   A satang value DOES arrive from the frontend as a JSON string, and that is
--   deliberate: a JSON number is a double in JavaScript, so the string form
--   makes it impossible for the bridge to launder a value that is not a
--   canonical integer. `parse_satang` there accepts exactly `^(0|[1-9][0-9]*)$`
--   and rejects a float, a sign, an exponent, surrounding whitespace, a leading
--   zero, or anything past i64 — so by the time a value is bound it is an
--   `i64`, and `Value::Integer` reaches the column. Per SKILL.md §2.3 the Rust
--   core is an adapter only and holds no business rules, so this is the last
--   line of defence rather than the first.
--
--   What this rule cannot do is stop SQLite coercing a numeric string on the way
--   IN, which is why the affinity note above applies to any OTHER path into
--   this file — a support script, a future migration, a hand-run `sqlite3`.
-- ============================================================================

-- Foreign-key enforcement is NOT set here, and the reason is load-bearing:
-- `PRAGMA foreign_keys` is a no-op inside a transaction, and the migration runner
-- wraps this whole file in one so an interrupted `CREATE INDEX` cannot leave a
-- half-built schema. The `PRAGMA foreign_keys = ON` this file used to open with
-- therefore never took effect, for as long as that line existed — foreign keys
-- were silently unenforced on every terminal, while
-- apps/pos-desktop/test/migrations.test.ts reported them as enforced.
--
-- It is set per CONNECTION in `src/db.rs`, immediately after the database is
-- opened and before any command runs. That is the only place it is guaranteed to
-- bind. `the_database_refuses_a_line_whose_order_does_not_exist` in
-- `src/commands.rs` is the test that keeps that honest; do not "tidy" a pragma
-- back in here.

-- ============================================================================
-- TABLE: local_orders — one committed sale (or one in-progress draft) per row.
-- ============================================================================
CREATE TABLE local_orders (
  -- Client-generated UUIDv7 PRIMARY KEY (SKILL.md §2.2). Deliberately TEXT, not
  -- an INTEGER rowid: the terminal must be able to create an order with no
  -- network, so the ID cannot come from a server sequence. UUIDv7 embeds a
  -- millisecond timestamp in its high bits, so ids sort by creation time and a
  -- queue of offline-created ids is still chronologically ordered. A TEXT id
  -- cannot be typeof()-CHECKed either, for the affinity reason in the header.
  id TEXT PRIMARY KEY,

  -- Owning branch. Denormalised onto the row because a reconciliation report
  -- must not need a join to attribute a sale to a branch.
  branch_id TEXT NOT NULL,

  -- Physical terminal that took the sale. Distinct from branch_id: a branch
  -- can have many terminals, and "which till rang this up" is an audit question.
  terminal_id TEXT NOT NULL,

  -- Staff member who rang the sale up, for till variance investigation.
  staff_user_id TEXT NOT NULL,

  -- Sale type, as a closed enum so an unknown value fails at COMMIT rather than
  -- becoming a mystery grouping in the end-of-shift report.
  type TEXT NOT NULL CHECK (type IN ('dine_in','takeaway','delivery')),

  -- Order lifecycle. NOT money: this column is expected to be UPDATEd many
  -- times, and the money-immutability trigger below must never block it.
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','in_preparation','ready','served','completed','void_requested','voided')),

  -- Originating client, so the server can tell a desktop-originated sale from a
  -- tablet or a back-office correction.
  source TEXT NOT NULL CHECK (source IN ('pos_desktop','pos_mobile','admin')),

  -- ISO-4217 alpha-3 code. Every amount on this row is denominated in it. THB
  -- is the default, and the column exists so a future branch in another
  -- currency cannot silently reuse satang arithmetic.
  currency TEXT NOT NULL DEFAULT 'THB' CHECK (length(currency) = 3),

  -- VAT rate in BASIS POINTS (1 bp = 0.01%), default 700 bp = 7.00%. Basis
  -- points rather than a float percentage, so the rate is exact integer
  -- arithmetic and 7 percent is 700, not 6.999999999.
  vat_rate_bp INTEGER NOT NULL DEFAULT 700 CHECK (typeof(vat_rate_bp) = 'integer' AND vat_rate_bp >= 0),

  -- MONEY: sum of line totals before order-level discount. ฿45.50 = 4550.
  subtotal_satang INTEGER NOT NULL CHECK (typeof(subtotal_satang) = 'integer' AND subtotal_satang >= 0),

  -- MONEY: order-level discount, in satang. Capped by subtotal below.
  discount_satang INTEGER NOT NULL CHECK (typeof(discount_satang) = 'integer' AND discount_satang >= 0),

  -- MONEY: the VAT base = subtotal - discount.
  taxable_satang INTEGER NOT NULL CHECK (typeof(taxable_satang) = 'integer' AND taxable_satang >= 0),

  -- MONEY: VAT in satang. Computed from taxable_satang and vat_rate_bp, and the
  -- formula itself is deliberately NOT yet a CHECK. See TODO(TAX-FORMULA).
  tax_satang INTEGER NOT NULL CHECK (typeof(tax_satang) = 'integer' AND tax_satang >= 0),

  -- MONEY: service charge in satang. Zero when the branch has no service
  -- charge, because a non-zero default would mean a charge nobody can explain.
  service_charge_satang INTEGER NOT NULL CHECK (typeof(service_charge_satang) = 'integer' AND service_charge_satang >= 0),

  -- MONEY: satang added or subtracted so the total is payable in the exact cash
  -- and coin denominations sitting in the drawer (Thai baht coins end in 5).
  rounding_adjustment_satang INTEGER NOT NULL CHECK (typeof(rounding_adjustment_satang) = 'integer' AND rounding_adjustment_satang >= 0),

  -- MONEY: the amount actually charged, = taxable + tax + service + rounding.
  total_satang INTEGER NOT NULL CHECK (typeof(total_satang) = 'integer' AND total_satang >= 0),

  -- Why the discount was applied, NULL when there was no discount. Enum so an
  -- unauthorised discount cannot be smuggled in as free text.
  discount_type TEXT CHECK (discount_type IN ('member','promotion','manual_supervisor','staff')),

  -- Loyalty points earned on this sale. A count and not money, hence no
  -- _satang suffix, but still integer-checked for the same silent-affinity
  -- reason as the money columns.
  loyalty_points_earned INTEGER NOT NULL DEFAULT 0 CHECK (typeof(loyalty_points_earned) = 'integer' AND loyalty_points_earned >= 0),

  -- Replay-safety key for checkout (SKILL.md §2.2). UNIQUE because a terminal
  -- offline for an hour may retry the same checkout, and a duplicate must be
  -- rejected rather than sell the drink twice.
  idempotency_key TEXT NOT NULL UNIQUE,

  -- The number printed on the till receipt. Local and monotonic per terminal,
  -- because the server assigns the authoritative receipt number at sync.
  local_receipt_number TEXT NOT NULL,

  -- Sync lifecycle of this row. Mutable delivery state, NOT money, so the
  -- money-immutability trigger leaves it alone.
  sync_state TEXT NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending','synced','conflict','rejected')),

  -- ISO-8601 UTC instant of creation, e.g. '2026-10-02T09:00:00.000Z'. TEXT and
  -- not a timestamp type: SQLite has no timestamp type, so a declared one would
  -- be INTEGER affinity holding epoch units, which is a second silent unit
  -- conversion on a money-bearing row. ISO-8601 UTC text sorts
  -- lexicographically in chronological order and round-trips through JSON
  -- unchanged.
  created_at TEXT NOT NULL,

  -- ISO-8601 UTC instant of the last write, same format and same reasoning as
  -- created_at. NULL until the row is first updated.
  updated_at TEXT,

  -- ARITHMETIC IDENTITIES. Integer satang alone is not enough: an order whose
  -- components disagree with its total is just as wrong as a fractional one,
  -- and wrong invisibly. These make the identities part of the storage
  -- contract, so a bug in the TypeScript cart maths fails at COMMIT time,
  -- inside the same §2.2 transaction, instead of surfacing as an unbalanced
  -- receipt at the end of the shift.
  --
  -- VAT IS INCLUSIVE (docs/02-design/DOMAIN.md §"Money and tax rules", ratified
  -- 2026-10-04). ฿45.50 on the menu is what the customer pays; the VAT sits
  -- INSIDE it. So the tax is EXTRACTED from the amount charged, never added to
  -- it, and `taxable_satang` is the NET value rather than the amount after a
  -- discount. The previous identity `taxable = subtotal - discount` assumed
  -- VAT-exclusive pricing and is deliberately gone.
  --
  --   A discount cannot exceed what it discounts.
  CHECK (discount_satang <= subtotal_satang),
  --   The amount charged is the VAT-inclusive subtotal, less the discount, plus
  --   any cash rounding. `taxable_satang` and `tax_satang` are deliberately NOT
  --   in this equation: under inclusive pricing the tax is already contained in
  --   the amount charged, so adding it here would charge the customer twice.
  CHECK (total_satang = subtotal_satang - discount_satang + service_charge_satang + rounding_adjustment_satang),
  --   The one identity that matters: net + VAT == the amount charged. Derived by
  --   subtraction in the domain, so the two halves cannot drift apart and a
  --   receipt whose parts do not sum to its total cannot be stored.
  CHECK (taxable_satang + tax_satang = total_satang - service_charge_satang - rounding_adjustment_satang),
  --   The extraction rule itself, ratified in DOMAIN.md and implemented by
  --     sales/domain/tax.ts:
  --       net = round_half_up(gross * 10000 / (10000 + vat_rate_bp))
  --       tax = gross - net
  --   The `+ (10000 + vat_rate_bp) / 2` is the round-half-UP step; SQLite
  --   `/` on INTEGERs truncates, so this is exact integer arithmetic with no
  --   float anywhere. `gross` excludes service charge and rounding because the
  --   VAT was extracted from the menu price before either was applied.
  --
  --   Note this is INCLUSIVE extraction: on a VAT-inclusive gross, 700 bp yields
  --   tax worth 7/107 = 6.542% of the price, not 7%. A forward-VAT formula would
  --   disagree with every menu price in the shop.
  CHECK (
    tax_satang = (subtotal_satang - discount_satang) - (
      (subtotal_satang - discount_satang) * 10000
        + (10000 + vat_rate_bp) / 2
    ) / (10000 + vat_rate_bp)
  )
);

-- Serves the end-of-shift and day-in-review queries:
--   SELECT * FROM local_orders WHERE created_at BETWEEN ? AND ? ORDER BY created_at DESC
-- DESC is declared so SQLite can satisfy the ordering from the index itself,
-- with no sort step.
CREATE INDEX idx_local_orders_created_at ON local_orders(created_at DESC);

-- Serves the kitchen and operations board, and the per-status shift counters:
--   SELECT * FROM local_orders WHERE status = 'in_preparation' ORDER BY created_at
CREATE INDEX idx_local_orders_status ON local_orders(status);

-- Serves the sync engine's find-unsynced query:
--   SELECT * FROM local_orders WHERE sync_state = 'pending' ORDER BY created_at
CREATE INDEX idx_local_orders_sync_state ON local_orders(sync_state);

-- ============================================================================
-- TABLE: local_order_lines — the items on a sale, immutable once written.
-- ============================================================================
CREATE TABLE local_order_lines (
  -- Client-generated UUIDv7 PRIMARY KEY, TEXT for the same offline reason as
  -- local_orders.id: no server round-trip may be needed to record a line.
  id TEXT PRIMARY KEY,

  -- Parent order. ON DELETE RESTRICT because a line must never outlive its
  -- sale, and the append-only trigger below is the first line of defence while
  -- this clause is the second.
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

  -- MONEY: VAT attributable to this line, in satang.
  --
  -- ALWAYS ZERO, and the CHECK below enforces it. VAT is rounded ONCE per
  -- order (docs/02-design/DOMAIN.md §"Money and tax rules"), so there is no
  -- per-line VAT to store. A non-zero value here would be a line-level rounding
  -- that the order-level figure does not contain, and the two would disagree by
  -- a satang per line — which is exactly the drift a tax return cannot absorb.
  -- The column is retained so the storage contract keeps its shape; it carries
  -- no business meaning until per-line posting is designed and ratified.
  line_tax_satang INTEGER NOT NULL CHECK (typeof(line_tax_satang) = 'integer' AND line_tax_satang = 0),

  -- MONEY: the line's contribution to the order total, which is unit_price
  -- times quantity, less line_discount, plus line_tax.
  line_total_satang INTEGER NOT NULL CHECK (typeof(line_total_satang) = 'integer' AND line_total_satang >= 0),

  -- ISO-8601 UTC instant of creation, TEXT for the same reason as
  -- local_orders.created_at: no timestamp type, no silent epoch conversion,
  -- lexicographic order equals chronological order.
  created_at TEXT NOT NULL,

  -- ARITHMETIC IDENTITIES — the same two rules the order table enforces, at
  -- line granularity, so that an unbalanced line cannot hide inside a balanced
  -- order total.
  --
  -- `unit_price_satang` is the VAT-INCLUSIVE price shown on the menu, and
  -- `line_total_satang` is that price extended by quantity less the line
  -- discount. The VAT is not in this equation: it is extracted once, at order
  -- level, and posting it here as well would charge it twice.
  CHECK (line_discount_satang <= unit_price_satang * quantity),
  CHECK (line_total_satang = unit_price_satang * quantity - line_discount_satang + line_tax_satang)
);

-- Serves the receipt renderer and the kitchen ticket:
--   SELECT * FROM local_order_lines WHERE order_id = ? ORDER BY created_at
CREATE INDEX idx_local_order_lines_order_id ON local_order_lines(order_id);

-- ============================================================================
-- TABLE: sync_outbox — the transactional outbox of SKILL.md §2.2.
-- Checkout inserts the sale row AND its outbox event in one transaction, and a
-- background drain then pushes events to Go's /sync/push with exponential
-- backoff. The queue is the terminal's proof of what it did while offline.
-- ============================================================================
CREATE TABLE sync_outbox (
  -- Strictly increasing local drain order. INTEGER PRIMARY KEY AUTOINCREMENT:
  -- SQLite would otherwise be free to reuse a rowid after a delete, and
  -- AUTOINCREMENT guarantees monotonicity for the life of the database.
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Client-generated UUIDv7, TEXT because it must be sortable and
  -- collision-free without a server.
  id TEXT NOT NULL UNIQUE,

  -- Which kind of domain object this event is about.
  aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('order','shift','refund','void_request','receipt','stock_movement')),

  -- Primary key of the aggregate named above.
  aggregate_id TEXT NOT NULL,

  -- WHAT happened, as a closed vocabulary. New event types need a forward
  -- migration so the server's contract cannot drift underneath the drain.
  event_type TEXT NOT NULL CHECK (event_type IN ('order_committed','shift_opened','shift_closed','receipt_printed','refund_issued','void_approved','stock_movement_recorded')),

  -- HOW to deliver it: push this aggregate, or pull the given feed.
  action TEXT NOT NULL CHECK (action IN ('push_order','push_shift','pull_catalog','pull_customers','pull_settings')),

  -- The event body, serialised as JSON. CHECKed with json_valid() so a
  -- truncated write (disk full mid-write, or a stringification bug) is rejected
  -- at INSERT rather than drained to the server as unparseable data long after
  -- the terminal believed the sale was safely recorded. json_type() = 'object'
  -- excludes arrays and scalars: a batched-events design is a schema change,
  -- not something to smuggle in through this column.
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),

  -- Replay-safety key for the SERVER-side dedup table. UNIQUE so one terminal
  -- cannot queue the same event twice.
  idempotency_key TEXT NOT NULL UNIQUE,

  -- Delivery state. Mutable, because the drain advances it, unlike the identity
  -- columns above which the append-only trigger below protects.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_flight','done','failed_permanent')),

  -- Number of delivery attempts so far. A counter and not money, hence no
  -- _satang suffix, but integer-checked for the same silent-affinity reason.
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0),

  -- ISO-8601 UTC instant after which the drain may retry. TEXT for the same
  -- reason as every other timestamp here: no timestamp type, no epoch units,
  -- lexicographic order equals chronological order. Drives exponential backoff.
  next_attempt_at TEXT NOT NULL,

  -- Last failure message from the drain, NULL while healthy. Diagnostic only.
  last_error TEXT,

  -- ISO-8601 UTC instant the event was queued, same format and rationale as
  -- next_attempt_at.
  created_at TEXT NOT NULL,

  -- ISO-8601 UTC instant the event reached the server, NULL until then. Same
  -- TEXT format and rationale as created_at.
  processed_at TEXT,

  -- A 'done' row is the server's proof that the event landed. Recording success
  -- without a timestamp would drop the event from the queue with no evidence.
  CHECK (status <> 'done' OR processed_at IS NOT NULL)
);

-- Serves the drain's ready-set scan (§2.2), which runs on a timer:
--   SELECT sequence, id, payload FROM sync_outbox
--   WHERE status IN ('pending','failed_permanent') AND next_attempt_at <= ?
--   ORDER BY sequence LIMIT ?
-- Partial index: it stores only the rows the drain actually reads, and the
-- leading (next_attempt_at, sequence) pair serves both the range test and the
-- ordering.
CREATE INDEX idx_sync_outbox_drain ON sync_outbox(next_attempt_at, sequence) WHERE status IN ('pending','failed_permanent');

-- ============================================================================
-- TRIGGERS
-- ============================================================================
--
-- RULE PROTECTED BY local_orders_money_immutable:
--   "A committed sale is never restated in place." Once checkout has committed
--   inside the §2.2 transaction, the order is what the customer was charged and
--   what the server reconciles against. Correcting it later means a VOID event
--   and a new order, never an UPDATE. This trigger exists so that no code path,
--   be it a bad reconciliation, a "fix" in a support script, a careless
--   db.run("UPDATE local_orders SET ..."), or a SQL string built from UI input,
--   can quietly rewrite money that has already been taken.
--
--   It guards EVERY money column on the table, not just total_satang. Guarding
--   only the total was a real defect: because the table CHECKs already enforce
--   the arithmetic identities, a committed ฿52.50 sale could be restated to
--   ฿60.00 by moving subtotal 4550 to 6000 and discount 0 to 1450 in a single
--   statement. Every CHECK still holds (taxable stays 4550, total stays 5250),
--   so nothing but this trigger can object. All seven *_satang columns are
--   therefore compared.
--
--   Non-money columns (status, sync_state, updated_at, loyalty_points_earned,
--   vat_rate_bp) are deliberately NOT guarded: lifecycle and delivery state are
--   expected to be written many times, and a trigger that blocked them would
--   break the normal path.
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

-- RULE PROTECTED BY local_order_lines_money_immutable:
--   the same append-only-money rule, one level down. A committed line is a
--   receipt line the customer saw, so unit_price_satang, line_discount_satang,
--   line_tax_satang and line_total_satang are all frozen. Guarding only
--   line_total_satang was the same defect as above: quantity 1 to 2 with
--   line_total 4550 to 9100 satisfies the line identity exactly, so a doubled
--   sale line could be written into a completed order without complaint.
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

-- RULE PROTECTED BY local_orders_no_delete:
--   the append-only rule for sales. A row that represents money already taken
--   must not be deletable by any code path. The retention and PDPA pruning
--   policy is still undecided (TODO), so deletion is refused wholesale rather
--   than allowed "temporarily".
CREATE TRIGGER local_orders_no_delete
BEFORE DELETE ON local_orders
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'DELETE on local_orders is forbidden; retention/PDPA pruning policy is undecided (TODO)');
END;

-- RULE PROTECTED BY local_order_lines_no_delete:
--   the same append-only rule for sale lines. A line may not outlive its order,
--   and may not be removed from a receipt that was already printed.
CREATE TRIGGER local_order_lines_no_delete
BEFORE DELETE ON local_order_lines
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'DELETE on local_order_lines is forbidden; retention/PDPA pruning policy is undecided (TODO)');
END;

-- RULE PROTECTED BY sync_outbox_append_only:
--   "an outbox event is WHAT happened, and what happened cannot change." The
--   drain must be able to advance status, attempt_count, next_attempt_at and
--   last_error, because delivery state is legitimately rewritten, but it must
--   never be able to rewrite the event's identity or its meaning. If id or
--   idempotency_key could change, the server's deduplication table would be
--   defeated. If payload or created_at could change, a sale could be
--   retroactively edited in the queue with no audit trail on the orders table.
CREATE TRIGGER sync_outbox_append_only
BEFORE UPDATE ON sync_outbox
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN OLD.id              IS NOT NEW.id
      OR OLD.idempotency_key IS NOT NEW.idempotency_key
      OR OLD.payload         IS NOT NEW.payload
      OR OLD.created_at      IS NOT NEW.created_at
    THEN RAISE(ABORT, 'sync_outbox identity columns are immutable: what happened cannot be rewritten, only delivered or retried')
    ELSE NULL
  END;
END;

PRAGMA user_version = 1;

-- NOTE on PRAGMA user_version above: this IS the migration bookkeeping.
--
-- It was not, originally. `tauri-plugin-sql` kept its OWN table,
-- `_sqlx_migrations`, recording which versions it had applied, and this pragma
-- was explicitly reserved for app-level checks. That plugin is gone — SKILL.md
-- §2.2 requires the checkout to commit the sale and its outbox event inside one
-- transaction, which the plugin's frontend API cannot express — so the driver is
-- owned directly and the plugin's table went with it.
--
-- `src/migrate.rs` reads this pragma to decide which migrations still need
-- applying, and writes it back to the highest version applied after each file
-- commits. It is stored in the DATABASE HEADER, so it is shared state: every
-- connection to the file sees the same value. Two properties make it the right
-- place for this:
--   - it is TRANSACTIONAL. The version is written inside the same transaction as
--     the schema it describes, so a migration that fails part-way rolls the
--     number back with the tables it did not finish creating. A bookkeeping
--     table would need the same care; this gets it for free.
--   - it costs one pragma read instead of a query against a second table that
--     could itself disagree with the first.
--
-- Do not repurpose it for anything else, and do not add a second bookkeeping
-- table beside it.
