-- 0004_recipes.sql — recipe-driven ingredient consumption.
--
-- This migration closes the gap documented in internal/inventory/domain/item.go:
-- "No recipe. InventoryItem.is_raw marks an ingredient consumed 'only through a
-- recipe', and DOMAIN.md defines Recipe and RecipeComponent — but contracts/
-- openapi.yaml defines NEITHER, so there is no wire shape to ingest one through
-- and no authoritative definition to cook against."
--
-- ── QUANTITIES ARE BIGINT MILLI-UNITS. NEVER numeric, NEVER float ─────────────
--
-- Same rule as 0002_inventory.sql and the contract's `Quantity` schema:
--   - On the wire: string matching ^-?\d+(\.\d{1,3})?$
--   - In Go: money.Quantity (int64 count of milli-units)
--   - In SQL: BIGINT with _milli suffix
--   - 0.018 kg = 18 milli-units
--
-- The `_milli` suffix is not decoration. It is what stops the next writer from
-- inserting 18 instead of 18000 because the type would have accepted either.
--
-- ── WHY A RECIPE HAS ONE PRODUCT ──────────────────────────────────────────────
--
-- A product is "Iced Latte". A recipe is the formula for that product. One
-- product has at most one active recipe; a recipe has multiple components.
-- The product's `recipe_id` (catalog table) points at this table.
--
-- ── WHY recipe_components.quantity_milli IS PER FINISHED UNIT ─────────────────
--
-- The deduction is: quantity_sold * component.quantity_milli.
-- A coffee recipe uses 0.018 kg beans per shot. A customer buys 2 shots.
-- The deduction is 2 * 18 = 36 milli-units of beans.
-- This is exactly the arithmetic NewSaleDeduction already does for a direct
-- sale, just with an extra multiplication step.

-- ===========================================================================
-- recipes
-- ===========================================================================
-- One recipe per product. The product's recipe_id points here.
CREATE TABLE IF NOT EXISTS recipes (
  -- CLIENT-GENERATED UUIDv7. A branch must be able to record a recipe offline.
  id          UUID        PRIMARY KEY,

  branch_id   UUID        NOT NULL REFERENCES branches(id),

  -- The product this recipe belongs to. One recipe per product.
  -- Not a FK: catalog module owns products, this module owns recipes.
  product_id  UUID        NOT NULL,

  -- Whether this recipe is currently used for ingredient deduction.
  -- A product can have a historical recipe (is_active = false) and a new one.
  is_active   BOOLEAN     NOT NULL DEFAULT true,

  -- Optimistic-concurrency counter. Server increments on every write.
  version     BIGINT      NOT NULL DEFAULT 0 CHECK (version >= 0),

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One active recipe per product per branch.
);

-- Partial unique index: One active recipe per product per branch.
CREATE UNIQUE INDEX IF NOT EXISTS recipes_one_active_per_product
  ON recipes (branch_id, product_id)
  WHERE is_active;

COMMENT ON TABLE recipes IS
  'One recipe per product. The product.recipe_id (catalog) points here. '
  'A recipe has one or more components (recipe_components) that drive '
  'ingredient deduction at sale time.';

COMMENT ON COLUMN recipes.product_id IS
  'The product this recipe belongs to. Not a FK — catalog module owns products. '
  'The catalog module enforces the link on its side.';

CREATE INDEX IF NOT EXISTS idx_recipes_branch
  ON recipes (branch_id);

-- ===========================================================================
-- recipe_components
-- ===========================================================================
-- One ingredient per recipe. quantity_milli is the amount consumed per ONE
-- unit of the finished product.
CREATE TABLE IF NOT EXISTS recipe_components (
  -- CLIENT-GENERATED UUIDv7. A branch must be able to record a component offline.
  id                 UUID        PRIMARY KEY,

  recipe_id          UUID        NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,

  -- The raw ingredient being consumed. Must be is_raw = true.
  inventory_item_id  UUID        NOT NULL REFERENCES inventory_items(id),

  -- Amount consumed per ONE unit of the finished product.
  -- BIGINT milli-units: 0.018 kg = 18.
  -- CHECK matches contract's Quantity pattern: up to 3 decimal places.
  quantity_milli     BIGINT      NOT NULL
                            CHECK (quantity_milli > 0
                                   AND quantity_milli <= 999999999999),

  -- Optimistic-concurrency counter. Server increments on every write.
  version            BIGINT      NOT NULL DEFAULT 0 CHECK (version >= 0),

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One component per ingredient per recipe.
  CONSTRAINT recipe_components_unique
    UNIQUE (recipe_id, inventory_item_id)
);

COMMENT ON TABLE recipe_components IS
  'One ingredient per recipe. quantity_milli is per finished unit. '
  'When 2 units of the product are sold, the deduction is 2 * quantity_milli.';

-- ===========================================================================
-- Triggers
-- ===========================================================================

-- Ensure that all raw ingredients used in recipe_components have is_raw = true.
CREATE OR REPLACE FUNCTION recipe_components_must_be_raw() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM inventory_items
    WHERE id = NEW.inventory_item_id
      AND is_raw = true
  ) THEN
    RAISE EXCEPTION
      'recipe_components: inventory_item % must have is_raw = true (a raw ingredient consumed via a recipe)',
      NEW.inventory_item_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER recipe_components_validate_raw
  BEFORE INSERT OR UPDATE ON recipe_components
  FOR EACH ROW EXECUTE FUNCTION recipe_components_must_be_raw();

-- ===========================================================================
-- View: recipe with aggregated component names (for debugging/reporting)
-- ===========================================================================
CREATE OR REPLACE VIEW recipe_details AS
SELECT
  r.id              AS recipe_id,
  r.branch_id,
  r.product_id,
  r.is_active,
  r.version         AS recipe_version,
  r.updated_at      AS recipe_updated_at,
  rc.id             AS component_id,
  rc.inventory_item_id,
  ii.name_th        AS ingredient_name_th,
  ii.unit           AS ingredient_unit,
  rc.quantity_milli,
  rc.version        AS component_version,
  rc.updated_at     AS component_updated_at
FROM recipes r
JOIN recipe_components rc ON rc.recipe_id = r.id
JOIN inventory_items ii ON ii.id = rc.inventory_item_id;
