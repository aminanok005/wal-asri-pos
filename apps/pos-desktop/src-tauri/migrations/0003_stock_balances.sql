-- ============================================================================
-- MIGRATION 0003 — the terminal's local stock balances
-- ============================================================================
--
-- WHAT THIS ADDS
--
-- One table, `stock_balances`, holding the last `StockBalance` snapshot the
-- cloud sent this terminal, so the sell path can answer "is there enough of
-- this in stock?" with the network unplugged.
--
-- The offline case is the whole reason it exists. A POS terminal in Thailand
-- loses its link constantly — a dead router, a dead ISP, a basement branch — and
-- the sell path must not block on the network for anything, including a stock
-- check. The server owns the balance; this table is a READ CACHE of it, not a
-- second source of truth. `inventory/domain/README.md` says so directly:
-- "stock is a ledger of movements, never an overwritten number."
--
-- ── WHAT THIS TABLE DELIBERATELY DOES NOT HAVE ───────────────────────────────
--
-- No `stock_movements` table. No adjustment column. No trigger allowing a
-- client to change a balance. The cloud derives `on_hand` from the movement
-- ledger (`contracts/openapi.yaml`, schema `StockBalance`: "Derived, never
-- written by a client"), and a second write surface on this terminal would make
-- "which number is right?" answerable two ways. Reconciliation is the server's
-- job — see `ARCHITECTURE-DEMO.md` §9, "Conflict rules". This table is written
-- by exactly one command, from exactly one pulled snapshot.
--
-- ── WHY MILLI-UNITS, INSTEAD OF THE DECIMAL STRING THE WIRE CARRIES ─────────
--
-- `on_hand` and `reserved` arrive as `Quantity`: an exact decimal string such
-- as `"2.500"`. The column is `on_hand_milli INTEGER`, the value × 1000.
--
-- The alternative — a TEXT column holding `"2.500"` verbatim — was rejected
-- deliberately, and it is the same trap `0001_init.sql` documents for money:
-- SQLite has no column types, it has type AFFINITY. A column declared
--
--     on_hand_milli TEXT
--
-- accepts the INTEGER `2500` just as happily as the string `"2500"`, and the
-- two are different columns to every comparison in the codebase. `2500 > "100"`
-- is true under NUMERIC affinity and true under TEXT affinity for different
-- reasons, and `SUM(on_hand)` over a mixed column silently ignores the TEXT
-- half rather than erroring. The evidence is gone before a CHECK could see it.
--
-- Milli-units makes the drift unrepresentable in the ARITHMETIC sense: the
-- column is an INTEGER, so `0.1 + 0.2` cannot be written into it at all. The
-- limit of that guarantee — a numeric STRING, which affinity coerces before any
-- CHECK can see it — is stated plainly below rather than glossed over.
--
-- Three decimal places is not a rounding decision, it is the contract's:
-- `on_hand` is `decimal(12,3)`, so a fourth digit is a value the server cannot
-- represent either, and `Quantity.fromWire` refuses it at the bridge rather
-- ── WHAT THE `typeof` CHECK ACTUALLY CATCHES, AND WHAT IT DOES NOT ─────────
--
-- The obvious reading of `CHECK (typeof(col) = 'integer')` is "this rejects a
-- number that arrived as text". It does not, and the difference is worth stating
-- plainly rather than discovering in production:
--
--     INSERT INTO stock_balances (..., on_hand_milli, ...) VALUES (..., '2500', ...)
--     -- COMMITS. typeof() reports 'integer'.
--
-- SQLite applies type AFFINITY BEFORE constraints are evaluated, and an
-- INTEGER-affinity column converts numeric-looking text on the way in. By the
-- time the CHECK runs, the value genuinely is an integer and the evidence that it
-- was ever a string is gone. `test/migrations.test.ts` asserts this behaviour
-- explicitly, so nobody later "strengthens" the CHECK expecting it to catch this.
--
-- So the CHECK is real defence against exactly two things:
--   * REAL — `0.1 + 0.2`, which is 0.30000000000000004 as a double, and is the
--     drift the satang rule exists to prevent. Affinity will NOT convert it.
--   * non-numeric TEXT — 'two and a half', which affinity cannot rescue.
--
-- And what actually guarantees an integer arrives is the string rule in the
-- adapters: `Quantity.toDecimalString()` on the TypeScript side and
-- `parse_milli_quantity` on the Rust side, both of which refuse anything but
-- canonical digits before a statement runs. The column is still declared INTEGER
-- rather than TEXT because of what affinity then does to everything downstream:
-- `SUM(on_hand_milli)` silently IGNORES text values rather than erroring, and
-- comparing '9' with '10' depends on which storage class each side has. Declaring
-- INTEGER makes those operations mean one thing; declaring TEXT makes them mean
-- two things depending on what arrived.
--
-- than truncating it.
--
-- ── WHY THE BALANCE MAY BE NEGATIVE, AND WHY `reserved` MAY NOT ──────────────
--
-- `on_hand_milli` has no `>= 0` CHECK, and that is not an oversight. The
-- contract's own `Quantity` description says a balance may go negative when an
-- offline terminal oversells stock, and the server reconciles it later. Adding
-- the CHECK would make the terminal unable to RECORD the oversell — the one
-- fact an operator needs to see — and would force the reconciliation to happen
-- against a number the terminal refused to store.
--
-- `reserved_milli` IS CHECKed `>= 0`. Reserved means "committed to open orders
-- but not yet deducted", so a negative reservation is not a debt, it is a
-- bookkeeping error: it would report more available stock than physically
-- exists, which is the one direction of drift that sells product a shop does
-- not have.
--
-- ── IDENTITY, NOT A SURROGATE KEY ────────────────────────────────────────────
--
-- The PRIMARY KEY is `(branch_id, inventory_item_id)`, the pair that
-- identifies the thing being counted. The contract also carries a server-
-- assigned `StockBalance.id` (a UUIDv7), stored as `remote_id`.
--
-- The natural key is the primary key because it is what the UI looks a row up
-- by, and because it makes the sync an idempotent UPSERT with no lookup: the
-- same balance pulled twice overwrites itself instead of inserting a duplicate.
-- `remote_id` is retained because the next sync conversation will need to send
-- this identifier back, and deriving it from the wrong column would be a
-- silent data defect.
--
-- `inventory_item_id` and `branch_id` are deliberately NOT foreign keys to
-- local tables, for the same reason `local_order_lines.variant_id` is not: the
-- catalogue is server-owned, and a terminal must be able to record a pulled
-- balance for an article it has never been told about.
--
-- ── `version` IS THE SYNC CURSOR'S COMPANION ────────────────────────────────
--
-- `version` is the server's optimistic-concurrency counter and `updated_at` is
-- the RFC 3339 instant the row last changed, which is also the `since` cursor
-- for the next incremental pull (`contracts/openapi.yaml`, info block). Both
-- are stored because a terminal that keeps only one of them can detect a lost
-- update or cannot resume a pull, and re-downloading the entire branch's stock
-- on every reconnect is how a shop near a dead router spends its shift.
--
-- `synced_at` is the TERMINAL's own clock, not the server's, so a row can be
-- aged on screen ("stock as of 40 minutes ago") without asking anyone to trust
-- that the two clocks agree. They routinely do not: this is a till in Thailand
-- on a network that just came back.
--
-- ── WHY THE IDENTITY COLUMNS ARE IMMUTABLE ─────────────────────────────────
--
-- A trigger, not a convention. `stock_balances_identity_immutable` refuses an
-- UPDATE that moves `id`, `branch_id`, `inventory_item_id` or `remote_id`.
--
-- Those four columns answer "which shelf is this?", and if a sync bug could
-- move one, a balance would be silently re-attributed from one article to
-- another and the shop would believe it has flour it does not. Quantities,
-- `version` and the timestamps ARE rewritable, because that is the entire
-- purpose of the table: a newer server snapshot replaces an older one.

CREATE TABLE stock_balances (
  -- Client-generated UUIDv7 for the LOCAL row. TEXT for the same offline
  -- reason as local_orders.id: creating a cache entry must never require a
  -- server round-trip. Distinct from `remote_id` so a locally-created row and a
  -- server-authored one are both representable.
  id TEXT PRIMARY KEY,

  -- The thing being counted. Server-owned, so NOT a foreign key — see the
  -- header.
  inventory_item_id TEXT NOT NULL,

  -- Balances are per BRANCH, not global. Two branches of the same shop stock
  -- different things.
  branch_id TEXT NOT NULL,

  -- The server's own identifier for this StockBalance, retained for the next
  -- sync conversation. Nullable because a locally-created row has none yet.
  remote_id TEXT,

  -- QUANTITY in MILLI-UNITS. `2.500 kg` is 2500. INTEGER, never REAL — see the
  -- header for the affinity trap this avoids.
  on_hand_milli INTEGER NOT NULL
    CHECK (typeof(on_hand_milli) = 'integer'),

  -- QUANTITY in MILLI-UNITS. Same representation, but unlike `on_hand` this one
  -- is bounded below at zero: a negative reservation would claim more stock is
  -- available than exists.
  reserved_milli INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(reserved_milli) = 'integer' AND reserved_milli >= 0),

  -- Server's optimistic-concurrency counter. A conditional write sends back the
  -- version it read; a mismatch is a conflict, never a silent overwrite.
  version INTEGER NOT NULL DEFAULT 0 CHECK (typeof(version) = 'integer' AND version >= 0),

  -- Server clock, RFC 3339 UTC. Doubles as the `since` cursor for the next
  -- incremental pull.
  updated_at TEXT NOT NULL,

  -- Terminal clock, RFC 3339 UTC. The terminal's own record of when this row was
  -- written, used to age stale stock on screen.
  synced_at TEXT NOT NULL,

  -- UNIQUE on the natural key, not on the PRIMARY KEY: this is what makes the
  -- sync UPSERT rather than an accumulating pile of duplicate rows for the same
  -- article.
  UNIQUE (branch_id, inventory_item_id),

  -- An empty article id or branch id would create a row that belongs to nothing.
  CHECK (length(trim(inventory_item_id)) > 0),
  CHECK (length(trim(branch_id)) > 0)
);

-- Serves the sell path's single question: "how much of this is available?"
--   SELECT on_hand_milli, reserved_milli FROM stock_balances
--    WHERE branch_id = ? AND inventory_item_id = ?
-- The UNIQUE index above already covers exactly this lookup as an index, so
-- SQLite can satisfy it either way; this index exists for the ORDER BY, below.

-- Serves "what is the whole branch's stock, oldest snapshot first", which is how
-- an operator finds the rows that went stale while the terminal was offline:
--   SELECT * FROM stock_balances WHERE branch_id = ? ORDER BY synced_at ASC
CREATE INDEX idx_stock_balances_stale ON stock_balances(branch_id, synced_at);

-- RULE PROTECTED BY stock_balances_identity_immutable:
--   "which shelf is this?" is a fact, not a value that gets restated. If a sync
--   bug could move branch_id or inventory_item_id, a balance computed for one
--   article would be silently re-attributed to another and the cashier would be
--   told flour is in stock when the shelf is empty. `remote_id` is guarded for
--   the same reason: it is the server's own identity for this row, and the next
--   pull must address the same row.
--
--   Quantities, version, updated_at and synced_at are deliberately NOT guarded.
--   Replacing an older server snapshot with a newer one is the only thing this
--   table exists to do, and a trigger that blocked it would break the feature
--   rather than protect it.
CREATE TRIGGER stock_balances_identity_immutable
BEFORE UPDATE ON stock_balances
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN OLD.id                IS NOT NEW.id
      OR OLD.branch_id         IS NOT NEW.branch_id
      OR OLD.inventory_item_id IS NOT NEW.inventory_item_id
      OR OLD.remote_id         IS NOT NEW.remote_id
    THEN RAISE(ABORT, 'stock_balances identity columns are immutable: a balance belongs to one article at one branch, and re-attributing it silently misreports stock')
    ELSE NULL
  END;
END;

PRAGMA user_version = 3;