-- 0002_inventory.sql — the stock-keeping articles and the movement ledger behind them.
--
-- ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────────
--
-- `POST /sync/push` ingests an offline sale and, until this migration, stopped at
-- the ledger: re-price, refuse-or-hold, append. Nothing knew that selling a latte
-- consumes anything. That is the gap `ARCHITECTURE-DEMO.md` §9 describes and this
-- file closes.
--
-- ── QUANTITIES ARE BIGINT MILLI-UNITS. NEVER numeric, NEVER float ─────────────
--
-- The same rule `0001_orders.sql` states for satang, with one difference in the
-- arithmetic and none in the discipline.
--
-- SATANG    money.    ฿45.50 is 4550.        Integer count of satang.
-- QUANTITY  a ratio.  0.250 kg is 250 milli-units.  Integer count of milli-units.
--
-- A quantity legitimately needs a decimal point, and a JSON number would place it
-- in binary floating point — the identical drift the satang rule exists to
-- prevent. contracts/openapi.yaml types `Quantity` as a STRING with the pattern
-- `^-?\d+(\.\d{1,3})?$` for exactly that reason, and `money.Quantity` parses it
-- into this scaled integer (internal/money/domain/quantity.go: "a `Quantity` is an
-- int64 count of MILLI-units, so `2.500` is 2500 and `0.005` is 5").
--
-- So the column is an INTEGER at every layer and the SCALE IS IN THE NAME:
--
--     on_hand_milli BIGINT      2.500 kg is 2500
--     quantity_milli BIGINT     a movement of -250 is -0.250 kg
--
-- The `_milli` suffix is not decoration. It is what stops the next writer from
-- inserting 2 instead of 2500 because the type would have accepted either, and it
-- is the same reasoning the terminal reached independently in
-- apps/pos-desktop/src-tauri/migrations/0003_stock_balances.sql, where the failure
-- mode was worse — SQLite has type AFFINITY, so a REAL can commit into a column
-- that looks integral and the evidence is gone before a CHECK could see it.
--
-- There is NO NUMERIC, FLOAT, REAL or DOUBLE PRECISION in this file, and
-- internal/inventory/adapter/postgres/schema_test.go fails the build if one
-- appears. That test needs no database, so the rule is enforced on every `go test`
-- rather than only when someone remembers to point one at a live server.
--
-- ── WHY THE MONEY RULE AND THE QUANTITY RULE DIFFER IN ONE PLACE ONLY ─────────
--
-- `0001_orders.sql` stores money as BIGINT but stores an order LINE's quantity as
-- NUMERIC(12,3), and that is deliberate — its header says so at length. The two
-- rules are not in tension here, because the quantity column in this file is
-- scaled by a factor of 1000 in BOTH directions:
--
--   money    exact integer count of satang;         scale fixed by fiat (100/baht)
--   quantity exact integer count of milli-units;    scale fixed by the contract's
--                                                    3-decimal pattern
--
-- A NUMERIC(12,3) column would carry the same value with the scale implicit, and
-- the implicit part is what this schema refuses: an integer whose unit is written
-- in its name cannot be misread, and cannot be read by a query that forgot it.
-- `scanLine` in internal/order/adapter/postgres is the precedent for reading such
-- a column back — it re-parses the decimal STRING through the money kernel rather
-- than trusting the driver, so the grammar has exactly one implementation here.
--
-- ── WHY stock_movements IS IN THIS FILE, THOUGH THE PLAN NAMED TWO TABLES ──────
--
-- `contracts/openapi.yaml`, schema `StockBalance`, is unambiguous:
--
--     "**Derived, never written by a client.** It is computed server-side from the
--      `StockMovement` ledger. Stock is a ledger of movements rather than an
--      overwritten number"
--
-- and ARCHITECTURE-DEMO.md §9 says the same: "Inventory: stock is a ledger of
-- movements, not an overwritten number; server computes the balance."
--
-- A `stock_balances` row that is read-modify-written directly is the second thing
-- the rule forbids — an overwritten number. It also destroys the only property
-- that makes offline reconciliation possible: after a week of terminals selling
-- flour, the shop needs to know WHY a balance says -0.750 kg, and a number with
-- no history cannot answer that. So the ledger is here, and the balance is
-- written ONLY as a consequence of appending to it, in one transaction
-- (internal/inventory/adapter/postgres/stock_store.go).
--
-- ── WHY A SALE MOVEMENT IS KEYED BY ITS ORDER LINE ─────────────────────────────
--
-- internal/identity/domain/uuidv7.go has no generator and says why at length:
-- "the server may NEVER mint an id for a record the client created". A sale
-- movement is a record the CLIENT created — offline, on a terminal, before the
-- server existed for that order — and its id is already sitting in the payload as
-- `OrderLine.id`.
--
-- So one sale line produces exactly one movement carrying that line's id, and the
-- PRIMARY KEY does the double-deduction guard for free: deducting the same line
-- twice is SQLSTATE 23505, which the adapter turns into a no-op. Inventing a
-- server-side id here would have meant either duplicating the UUIDv7 generator
-- (a second implementation of a rule that exists precisely to have one) or
-- weakening the ledger's own reason for existing.
--
-- The consequence worth stating: the `sale` sign rule and this key together mean
-- one order line can never deduct twice, no matter how many times the terminal
-- retries the batch that carried it.

-- ===========================================================================
-- inventory_items
-- ===========================================================================
-- A stock-keeping article: an ingredient consumed by a recipe, or a finished
-- good sold directly.
CREATE TABLE IF NOT EXISTS inventory_items (
  -- CLIENT-GENERATED UUIDv7, for the same reason `orders.id` is: a branch must be
  -- able to record an article while offline, and a server sequence would block
  -- checkout on the network.
  id          UUID        PRIMARY KEY,

  branch_id   UUID        NOT NULL REFERENCES branches(id),

  -- The sellable variant this article represents. NULL for a raw ingredient,
  -- which has no direct sale and is consumed only through a recipe.
  --
  -- NOT a foreign key: `product_variants` is owned by the catalog module and does
  -- not exist in this schema — `internal/catalog/adapter/postgres` is still a
  -- documented skeleton returning ErrNotImplemented. A foreign key to a table
  -- this database does not hold would make this migration unappliable. The bare
  -- UUID records the fact without inventing a dependency, exactly as
  -- `orders.terminal_id` and `order_lines.product_variant_id` already do.
  --
  -- Which is also why the deduction looks a variant up here rather than joining a
  -- catalogue table: the lookup is this module's own, and it must work before the
  -- catalog module has a working driver.
  product_variant_id UUID,

  sku        TEXT,
  name_th    TEXT        NOT NULL,
  name_en    TEXT,

  -- Free-text unit of measure: `kg`, `g`, `ml`, `pcs`.
  --
  -- ⚠️ THIS IS THE KNOWN WEAKNESS AND IT IS NOT FIXED HERE. The contract marks a
  -- `unit_of_measure_id` foreign key as D-UNIT, "proposed, not approved". Until
  -- someone ratifies it, a TEXT column cannot stop a recipe from adding 0.250 kg
  -- of flour to 0.005 g of saffron. The Go domain refuses a BLANK unit
  -- (domain.InventoryItem.Validate) because a quantity with no unit cannot be
  -- converted or reconciled at all, but it does not pretend to solve kg-vs-g.
  -- Inventing a unit-conversion table here would be a decision nobody made.
  unit        TEXT        NOT NULL CHECK (length(btrim(unit)) > 0),

  -- Whether a StockBalance is maintained for this article. `false` for something
  -- never counted, e.g. a garnish. An untracked article is SKIPPED by the
  -- deduction rather than tracked at zero, so this is what makes that skip.
  track_stock BOOLEAN     NOT NULL DEFAULT true,

  -- `true` for an ingredient consumed via a recipe; `false` for a finished good.
  --
  -- CHECKed against product_variant_id, because the contract states the rule in
  -- words and a rule stated only in prose is a rule the next writer re-derives
  -- differently: "`null` when `is_raw` is true (an ingredient with no direct
  -- sale)".
  is_raw      BOOLEAN     NOT NULL DEFAULT false,

  -- Optimistic-concurrency counter. See the contract's `Version` schema: the
  -- server increments it on every write. Stored for consistency with every other
  -- primary entity, though the deduction path below does not use it — an article
  -- is never conditionally written by a client.
  version     BIGINT      NOT NULL DEFAULT 0 CHECK (version >= 0),

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A raw ingredient has no variant; a sellable article has one. See is_raw above.
  CONSTRAINT inventory_items_raw_has_no_variant
    CHECK (NOT is_raw OR product_variant_id IS NULL)
);

COMMENT ON COLUMN inventory_items.unit IS
  'Free text: kg, g, ml, pcs. A unit_of_measure_id FK is D-UNIT and PROPOSED, NOT '
  'APPROVED, so unit consistency is not enforced here beyond rejecting a blank. A '
  'recipe mixing kg with g is an open, recorded gap rather than a silent one.';

COMMENT ON COLUMN inventory_items.product_variant_id IS
  'Not a foreign key: product_variants is owned by the catalog module, whose driver '
  'is still a skeleton. The sale deduction resolves a variant through THIS table '
  'and must work before the catalog has a working driver.';

-- ONE article per variant per branch.
--
-- The deduction looks a sold `product_variant_id` up in this table and needs
-- exactly one answer. Two articles claiming the same variant would make that
-- lookup ambiguous, and an ambiguous deduction is a deduction that silently picks
-- the wrong shelf — the shop believes it has flour when the empty one is flour.
--
-- Partial, because two raw ingredients legitimately have NULL here and a plain
-- UNIQUE would refuse the second one (NULLs compare distinct in Postgres, so a
-- plain UNIQUE would in fact pass — the partial form states the intent rather
-- than relying on that).
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_items_variant
  ON inventory_items (branch_id, product_variant_id)
  WHERE product_variant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_items_branch
  ON inventory_items (branch_id);

-- ===========================================================================
-- stock_movements
-- ===========================================================================
-- THE LEDGER. Append-only, immutable, and the only thing that may change a
-- balance.
--
-- `quantity_milli` is the SIGNED DELTA TO `on_hand`, not the resulting balance.
-- That choice is what makes the ledger self-checking: `sum(quantity_milli)` over
-- this table for one article equals its `stock_balances.on_hand_milli`, and the
-- integration test asserts exactly that identity against a live database.
--
-- Storing the running balance instead would be a second representation free to
-- disagree with the sum, and a disagreement between "what the movements say" and
-- "what the balance says" is exactly the question an operator opens the database
-- to answer.
CREATE TABLE IF NOT EXISTS stock_movements (
  -- For a `sale`, THIS IS THE ORDER LINE'S ID. See the header. For the movement
  -- types this schema does not yet produce, it is the caller's own identifier.
  id                UUID   PRIMARY KEY,

  inventory_item_id UUID   NOT NULL REFERENCES inventory_items(id),
  branch_id         UUID   NOT NULL REFERENCES branches(id),

  -- DOMAIN.md's `stock_movement_type`, all ten values.
  --
  -- `sale` is the ONLY one this service produces today: the ingest path deducts
  -- stock, and nothing else writes this table. The other nine are listed rather
  -- than omitted so the vocabulary has exactly one definition — the same reason
  -- `order_status` lists all eight rungs instead of the two currently reachable
  -- (internal/order/domain/order.go). A narrower CHECK would make a future
  -- migration, not this one, the place where the vocabulary forks.
  type              TEXT   NOT NULL
                      CHECK (type IN ('sale', 'refund', 'waste', 'purchase',
                                      'adjustment_in', 'adjustment_out',
                                      'transfer_in', 'transfer_out',
                                      'count_correction', 'combo_component')),

  -- SIGNED. Negative is an outflow (stock left the shelf), positive is an inflow.
  -- A `sale` is always an outflow, CHECKed below.
  --
  -- Bounded to decimal(12,3): the same range `money.maxQuantityMilli` accepts and
  -- the same range the contract's `Quantity` string pattern can express. A
  -- movement outside it could not be put on the wire, so storing it would create
  -- history the contract cannot describe.
  quantity_milli    BIGINT NOT NULL
                      CHECK (quantity_milli BETWEEN -999999999999 AND 999999999999),

  -- For a `sale`, the line that consumed the stock. Nullable because the other
  -- movement types are not caused by an order line.
  reference_order_line_id UUID,

  source            TEXT   NOT NULL DEFAULT 'sync_ingest',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID,

  -- ── THE SALE-SPECIFIC RULES ──────────────────────────────────────────────
  --
  -- Two constraints that exist only to make "one order line deducts exactly once"
  -- a property of the DATABASE rather than of a Go caller.
  --
  -- The id rule is what stops a future writer from minting a server-side movement
  -- id for a sale and thereby destroying the natural idempotency key described in
  -- the header. The sign rule is what stops a `sale` from restocking a shelf.
  --
  -- Both are scoped to `type = 'sale'` rather than applied globally: a purchase
  -- is a positive delta and a waste is a negative one, so a global sign rule would
  -- be wrong for half the vocabulary and would have to be relaxed again later.
  CONSTRAINT stock_movements_id_is_the_order_line
    CHECK (type <> 'sale' OR id = reference_order_line_id),

  CONSTRAINT stock_movements_sale_is_an_outflow
    CHECK (type <> 'sale' OR quantity_milli < 0)
);

COMMENT ON COLUMN stock_movements.quantity_milli IS
  'The SIGNED DELTA TO on_hand, in milli-units, NOT the resulting balance. '
  'sum(quantity_milli) for one article equals stock_balances.on_hand_milli, and '
  'that identity is asserted against a live database by the integration suite. A '
  'sale is always negative.';

CREATE INDEX IF NOT EXISTS idx_stock_movements_item_created
  ON stock_movements (inventory_item_id, created_at);

-- Serves the reconciliation question this table exists to answer: "what happened
-- to the flour while the terminals were offline?"
--   SELECT * FROM stock_movements
--    WHERE inventory_item_id = $1 AND created_at > $2 ORDER BY created_at
CREATE INDEX IF NOT EXISTS idx_stock_movements_item_time
  ON stock_movements (inventory_item_id, created_at DESC);

-- ===========================================================================
-- stock_movements is APPEND-ONLY, enforced by the database
-- ===========================================================================
--
-- "Stock is a ledger of movements, never an overwritten number." That is a
-- statement about what the system BELIEVES, and a belief a caller can contradict
-- with an UPDATE is not a rule — it is a convention, and conventions are what
-- `ARCHITECTURE-DEMO.md` §9 means by "an overwritten number".
--
-- So both directions are triggers rather than comments, for the same reason
-- 0001_orders.sql puts them on orders: a service bug must FAIL rather than quietly
-- rewrite history. A stock correction is a NEW `count_correction` movement, which
-- leaves the previous figure readable — which is the entire property that makes
-- "why does the flour say -0.750?" answerable at all.
--
-- Deliberately NOT scoped to `UPDATE OF type`: the identity and the delta are both
-- protected, because a movement whose QUANTITY changes is no longer the movement
-- that happened. `stock_movements_no_update` refuses every UPDATE rather than
-- narrowing one, since this table has no legitimate UPDATE to permit.
CREATE OR REPLACE FUNCTION stock_movements_append_only() RETURNS TRIGGER AS $$
BEGIN
  -- A single string literal, not a concatenation. RAISE's message is one format
  -- string; `||` is not evaluated there, and writing it that way produces
  -- "syntax error at or near \"||\"" — an error that names neither this function nor
  -- the rule it was enforcing.
  RAISE EXCEPTION
    'stock_movements is append-only: a movement that changed stock is a record of something that happened, and rewriting it destroys the ledger the balance is derived from — append a count_correction movement instead (movement %)',
    OLD.id
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_movements_no_update
  BEFORE UPDATE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_append_only();

CREATE TRIGGER stock_movements_no_delete
  BEFORE DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_append_only();

-- ===========================================================================
-- stock_balances
-- ===========================================================================
-- The DERIVED quantity on hand at one branch. One row per tracked article.
--
-- Read by the sell path's single question — "how much of this is available?" —
-- and by GET /inventory/balances, which the contract describes as read-only:
-- "This endpoint is read-only; there is deliberately no `PUT` or `PATCH`."
CREATE TABLE IF NOT EXISTS stock_balances (
  -- SERVER-ASSIGNED, and a documented deviation from the UUIDv7 rule the rest of
  -- this schema follows. `internal/identity/domain/uuidv7.go` has no generator
  -- because "the server may NEVER mint an id for a record the client created" —
  -- and this row is not a record the client created. It is a projection the server
  -- derives from the ledger, exactly as `StockBalance` in the contract says it
  -- must be.
  --
  -- So `gen_random_uuid()` (a v4) rather than a Go-minted v7, for two reasons:
  -- minting a v7 in Go would duplicate the generator that kernel deliberately does
  -- not have, and the id is not a sync cursor — `updated_at` is (see below), and
  -- the contract's `StockBalance.version` is what a client conditionally writes
  -- against, not the id.
  id                UUID   PRIMARY KEY DEFAULT gen_random_uuid(),

  -- THE NATURAL KEY IS THE PRIMARY KEY OF THE LOOKUP, exactly as in the terminal's
  -- own stock_balances table. `(branch_id, inventory_item_id)` is what the sell
  -- path queries and what the UPSERT conflicts on, so putting a surrogate id in
  -- front of it would add a lookup to every deduction to enforce nothing.
  inventory_item_id UUID   NOT NULL UNIQUE
                         REFERENCES inventory_items(id),
  branch_id         UUID   NOT NULL REFERENCES branches(id),

  -- ── ON HAND IS SIGNED, AND THAT IS THE POINT ──────────────────────────────
  --
  -- THERE IS DELIBERATELY NO `CHECK (on_hand_milli >= 0)`. Three layers have
  -- already committed to this, and this file is the fourth to agree:
  --
  --   1. contracts/openapi.yaml, `StockBalance.on_hand`:
  --      "May be negative if an offline terminal oversold before reconciling."
  --   2. apps/pos-desktop/src-tauri/migrations/0003_stock_balances.sql, which
  --      documents the absence at length: "Adding the CHECK would make the
  --      terminal unable to RECORD the oversell — the one fact an operator needs
  --      to see."
  --   3. ARCHITECTURE-DEMO.md §9: inventory is where offline writes genuinely
  --      conflict, and the server reconciles.
  --
  -- The failure this avoids is concrete. An offline terminal in a basement branch
  -- sells the last of the flour. Refusing to store -0.750 kg does not prevent the
  -- oversell — the flour is already gone and the money is taken — it only makes
  -- the shortage invisible, and forces the reconciliation to be argued against a
  -- number the server declined to keep.
  --
  -- SO: the deduction never refuses a real sale for stock. It commits the negative
  -- balance and reports an oversold warning to the operator. That is the ratified
  -- policy, and it is enforced here by the ABSENCE of a constraint.
  on_hand_milli     BIGINT NOT NULL
                      CHECK (on_hand_milli BETWEEN -999999999999 AND 999999999999),

  -- Committed to open orders but not yet deducted. Available-to-sell is
  -- on_hand - reserved, per the contract.
  --
  -- THIS ONE IS CHECKed >= 0, and the asymmetry with the line above is the whole
  -- argument. A negative reservation is not a debt, it is a bookkeeping error: it
  -- reports more available stock than physically exists, which "is the one
  -- direction of drift that sells product a shop does not have" (terminal 0003).
  --
  -- A negative on_hand says "we already oversold, go and buy flour".
  -- A negative on reserved says "our arithmetic is broken, ignore it".
  -- Only one of those is a fact about the shop.
  reserved_milli    BIGINT NOT NULL DEFAULT 0 CHECK (reserved_milli >= 0),

  -- The movement that produced this balance. The contract says of this column:
  -- "The `StockMovement` that produced this balance. Lets a client verify the
  -- derivation." That is precisely its purpose, and it is why the FK points at the
  -- ledger rather than being a free-standing reference.
  last_movement_id  UUID   REFERENCES stock_movements(id),

  -- See the contract's `Version`. Incremented on every write by the deduction.
  version           BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),

  -- The server's clock. Doubles as the `since` cursor for the next incremental
  -- pull, which is why the contract documents it on this schema:
  -- "RFC 3339, UTC. Doubles as the sync cursor for this row."
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── WHY THE UNIQUE KEY IS ON inventory_item_id ALONE ──────────────────────────
--
-- The terminal's local table keys on `(branch_id, inventory_item_id)`. This one
-- keys on `inventory_item_id`, and that is the same key with one fewer column to
-- get wrong rather than a stricter rule: an inventory_item belongs to exactly ONE
-- branch (the FK above), so the two keys are identical by construction.
--
-- Recording the reasoning here matters because the deduction's UPSERT names its
-- conflict target, and if the key ever becomes genuinely composite — one article
-- stocked at several branches — that statement changes with it. Both live in this
-- file, which is why the note is here and not in a commit message.
