-- ============================================================================
-- MIGRATION 0004 — the terminal's local recipe cache
-- ============================================================================
--
-- WHAT THIS ADDS
--
-- Two tables: `local_recipes` and `local_recipe_components`, holding the last
-- recipe snapshot the cloud sent this terminal, so the sell path can answer
-- "what ingredients does this combo consume?" with the network unplugged.
-- A Thai branch loses its link constantly — a dead router, a dead ISP, a
-- basement branch — and the sell path must not block on the network for
-- anything, including recipe lookups. The server owns the recipe; these tables
-- are a READ CACHE of it, not a second source of truth.
--
-- ── WHY MILLI-UNITS FOR YIELD_QUANTITY AND QUANTITY ──────────────────────────
--
-- `yield_quantity` and `quantity` arrive as exact decimal strings (3 dp) such
-- as `"2.500"`. The columns are `yield_quantity_milli INTEGER` and
-- `quantity_milli INTEGER`, the value × 1000.
--
-- The alternative — a TEXT column holding `"2.500"` verbatim — was rejected
-- deliberately, and it is the same trap `0001_init.sql` documents for money:
-- SQLite has no column types, it has type AFFINITY. A column declared
--
--     yield_quantity_milli TEXT
--
-- accepts the INTEGER `2500` just as happily as the string `"2500"`, and the
-- two are different columns to every comparison in the codebase. `2500 > "100"`
-- is true under NUMERIC affinity and true under TEXT affinity for different
-- reasons, and `SUM(yield_quantity_milli)` over a mixed column silently ignores
-- the TEXT half rather than erroring. The evidence is gone before a CHECK could
-- see it.
--
-- Milli-units makes the drift unrepresentable in the ARITHMETIC sense: the
-- column is an INTEGER, so `0.1 + 0.2` cannot be written into it at all. The
-- limit of that guarantee — a numeric STRING, which affinity coerces before any
-- CHECK can see it — is stated plainly below rather than glossed over.
--
-- Three decimal places is not a rounding decision, it is the contract's:
-- `quantity` is `decimal(10,3)` and `yield_quantity` is `decimal(10,3)`, so a
-- fourth digit is a value the server cannot represent either, and
-- `Quantity.fromWire` refuses it at the bridge rather than truncating it.
--
-- ── WHAT THE `typeof` CHECK ACTUALLY CATCHES, AND WHAT IT DOES NOT ──────────
--
-- The obvious reading of `CHECK (typeof(col) = 'integer')` is "this rejects a
-- number that arrived as text". It does not, and the difference is worth stating
-- plainly rather than discovering in production:
--
--     INSERT INTO local_recipes (..., yield_quantity_milli, ...) VALUES (..., '2500', ...)
--     -- COMMITS. typeof() reports 'integer'.
--
-- SQLite applies type AFFINITY BEFORE constraints are evaluated, and an
-- INTEGER-affinity column converts numeric-looking text on the way in. By the
-- time the CHECK runs, the value genuinely is an integer and the evidence that it
-- was ever a string is gone.
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
-- `SUM(yield_quantity_milli)` silently IGNORES text values rather than erroring,
-- and comparing '9' with '10' depends on which storage class each side has.
-- Declaring INTEGER makes those operations mean one thing; declaring TEXT makes
-- them mean two things depending on what arrived.
--
-- ── IDENTITY, NOT A SURROGATE KEY ─────────────────────────────────────────────
--
-- The PRIMARY KEY of `local_recipes` is `id` (client-generated UUIDv7). The
-- natural lookup key is `product_variant_id` (what the sell path asks by).
-- The server's own `remote_id` is retained for the next sync conversation.
--
-- The PRIMARY KEY of `local_recipe_components` is `id` (client-generated UUIDv7).
-- The natural unique key is `(recipe_id, inventory_item_id)` — one component
-- per inventory item per recipe.
--
-- `recipe_id` is deliberately NOT a foreign key to `local_recipes.id`, for the
-- same reason `local_order_lines.variant_id` is not: the catalogue is
-- server-owned, and a terminal must be able to record a pulled recipe for a
-- product it has never been told about.
--
-- `inventory_item_id` is deliberately NOT a foreign key either.
--
-- ── `version` IS THE SYNC CURSOR'S COMPANION ─────────────────────────────────
--
-- `version` is the server's optimistic-concurrency counter and `updated_at` is
-- the RFC 3339 instant the row last changed, which is also the `since` cursor
-- for the next incremental pull. Both are stored because a terminal that keeps
-- only one of them can detect a lost update or cannot resume a pull, and
-- re-downloading the entire branch's recipes on every reconnect is how a shop
-- near a dead router spends its shift.
--
-- `synced_at` is the TERMINAL's own clock, not the server's, so a row can be
-- aged on screen ("recipe as of 40 minutes ago") without asking anyone to trust
-- that the two clocks agree. They routinely do not: this is a till in Thailand
-- on a network that just came back.
--
-- ── WHY THE IDENTITY COLUMNS ARE IMMUTABLE ──────────────────────────────────
--
-- Triggers, not conventions. `local_recipes_identity_immutable` and
-- `local_recipe_components_identity_immutable` refuse an UPDATE that moves
-- identity columns.
--
-- Those columns answer "which recipe is this?" and "which component is this?",
-- and if a sync bug could move one, a recipe would be silently re-attributed
-- from one product to another and the shop would believe it has the wrong
-- ingredients. Quantities, `version` and the timestamps ARE rewritable, because
-- that is the entire purpose of these tables: a newer server snapshot replaces
-- an older one.

-- ============================================================================
-- TABLE: local_recipes — one recipe per product variant
-- ============================================================================
CREATE TABLE local_recipes (
  -- Client-generated UUIDv7 for the LOCAL row. TEXT for the same offline
  -- reason as local_orders.id: creating a cache entry must never require a
  -- server round-trip. Distinct from `remote_id` so a locally-created row and a
  -- server-authored one are both representable.
  id TEXT PRIMARY KEY,

  -- The sellable variant this recipe belongs to. Server-owned, so NOT a foreign
  -- key — see the header.
  product_variant_id TEXT NOT NULL,

  -- The server's own identifier for this Recipe, retained for the next
  -- sync conversation. Nullable because a locally-created row has none yet.
  remote_id TEXT,

  -- Unit of measure for the yield (e.g. "pcs", "ml", "g"). Free text as the
  -- server schema uses a free-text unit field.
  yield_unit TEXT NOT NULL,

  -- QUANTITY in MILLI-UNITS. `2.500 pcs` is 2500. INTEGER, never REAL — see the
  -- header for the affinity trap this avoids.
  yield_quantity_milli INTEGER NOT NULL
    CHECK (typeof(yield_quantity_milli) = 'integer'),

  -- Whether this recipe is active. Inactive recipes do not drive stock
  -- consumption.
  is_active INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(is_active) = 'integer' AND is_active IN (0, 1)),

  -- Server's optimistic-concurrency counter. A conditional write sends back the
  -- version it read; a mismatch is a conflict, never a silent overwrite.
  version INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(version) = 'integer' AND version >= 0),

  -- Server clock, RFC 3339 UTC. Doubles as the `since` cursor for the next
  -- incremental pull.
  updated_at TEXT NOT NULL,

  -- Terminal clock, RFC 3339 UTC. The terminal's own record of when this row was
  -- written, used to age stale recipes on screen.
  synced_at TEXT NOT NULL,

  -- UNIQUE on the natural lookup key: one recipe per product variant per branch.
  -- Branch is implicitly the terminal's branch; a terminal only pulls its own
  -- branch's recipes.
  UNIQUE (product_variant_id),

  -- An empty product_variant_id would create a row that belongs to nothing.
  CHECK (length(trim(product_variant_id)) > 0),
  CHECK (length(trim(yield_unit)) > 0)
);

-- Serves the sell path's single question: "what is the recipe for this variant?"
--   SELECT * FROM local_recipes WHERE product_variant_id = ?
-- The UNIQUE index above already covers exactly this lookup as an index.
CREATE INDEX idx_local_recipes_variant ON local_recipes(product_variant_id);

-- Serves "what is the whole branch's recipes, oldest snapshot first", which is how
-- an operator finds the rows that went stale while the terminal was offline:
--   SELECT * FROM local_recipes ORDER BY synced_at ASC
CREATE INDEX idx_local_recipes_stale ON local_recipes(synced_at);

-- RULE PROTECTED BY local_recipes_identity_immutable:
--   "which product variant is this recipe for?" is a fact, not a value that gets
--   restated. If a sync bug could move product_variant_id, a recipe would be
--   silently re-attributed from one variant to another and the cashier would be
--   told the wrong ingredients. `remote_id` is guarded for the same reason: it
--   is the server's own identity for this row, and the next pull must address
--   the same row.
--
--   Quantities, is_active, version, updated_at and synced_at are deliberately
--   NOT guarded. Replacing an older server snapshot with a newer one is the
--   only thing this table exists to do, and a trigger that blocked it would
--   break the feature rather than protect it.
CREATE TRIGGER local_recipes_identity_immutable
BEFORE UPDATE ON local_recipes
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN OLD.id                IS NOT NEW.id
      OR OLD.product_variant_id IS NOT NEW.product_variant_id
      OR OLD.remote_id         IS NOT NEW.remote_id
    THEN RAISE(ABORT, 'local_recipes identity columns are immutable: a recipe belongs to one product variant, and re-attributing it silently misreports ingredients')
    ELSE NULL
  END;
END;

-- ============================================================================
-- TABLE: local_recipe_components — ingredients consumed by a recipe
-- ============================================================================
CREATE TABLE local_recipe_components (
  -- Client-generated UUIDv7 for the LOCAL row. TEXT for the same offline
  -- reason as local_orders.id: creating a cache entry must never require a
  -- server round-trip.
  id TEXT PRIMARY KEY,

  -- Parent recipe. The natural key is (recipe_id, inventory_item_id). NOT a
  -- foreign key — see the header for local_recipes.
  recipe_id TEXT NOT NULL,

  -- The inventory item consumed. Server-owned, so NOT a foreign key.
  inventory_item_id TEXT NOT NULL,

  -- QUANTITY in MILLI-UNITS. `0.250 kg` is 250. INTEGER, never REAL — see the
  -- header for the affinity trap this avoids.
  quantity_milli INTEGER NOT NULL
    CHECK (typeof(quantity_milli) = 'integer'),

  -- Unit of measure for this component (e.g. "kg", "g", "ml", "pcs").
  -- Free text as the server schema uses a free-text unit field.
  unit TEXT NOT NULL,

  -- ISO-8601 UTC instant of creation, TEXT for the same reason as every other
  -- timestamp here: no timestamp type, no epoch units, lexicographic order
  -- equals chronological order.
  created_at TEXT NOT NULL,

  -- UNIQUE on the natural key: one component per inventory item per recipe.
  UNIQUE (recipe_id, inventory_item_id),

  -- An empty id would create a row that belongs to nothing.
  CHECK (length(trim(recipe_id)) > 0),
  CHECK (length(trim(inventory_item_id)) > 0),
  CHECK (length(trim(unit)) > 0)
);

-- Serves the sell path's question: "what ingredients does this recipe consume?"
--   SELECT * FROM local_recipe_components WHERE recipe_id = ?
CREATE INDEX idx_local_recipe_components_recipe ON local_recipe_components(recipe_id);

-- RULE PROTECTED BY local_recipe_components_identity_immutable:
--   "which ingredient is this component?" is a fact. If a sync bug could move
--   recipe_id or inventory_item_id, a component would be silently re-attributed
--   from one recipe to another and the shop would consume the wrong stock.
--
--   quantity_milli, unit, created_at are deliberately NOT guarded. Replacing an
--   older server snapshot with a newer one is the only thing this table exists
--   to do.
CREATE TRIGGER local_recipe_components_identity_immutable
BEFORE UPDATE ON local_recipe_components
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN OLD.id                IS NOT NEW.id
      OR OLD.recipe_id         IS NOT NEW.recipe_id
      OR OLD.inventory_item_id IS NOT NEW.inventory_item_id
    THEN RAISE(ABORT, 'local_recipe_components identity columns are immutable: a component belongs to one recipe and one inventory item, and re-attributing it silently misreports stock consumption')
    ELSE NULL
  END;
END;

PRAGMA user_version = 4;