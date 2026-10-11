//! The terminal's local recipe cache — parse pulled recipes and UPSERT them.
//!
//! Recipes are read cache data: server owns them, terminal stores last snapshot.
//! Decimal quantities cross Tauri as strings and land as i64 milli-units.

use rusqlite::Connection;
use rusqlite::types::Value;

use crate::commands::{CommandError, CommandErrorKind};
use crate::stock_balances::parse_milli_quantity;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecipeInput {
    #[serde(default)]
    pub id: Option<String>,
    pub product_variant_id: String,
    #[serde(default)]
    pub remote_id: Option<String>,
    pub yield_unit: String,
    pub yield_quantity: String,
    pub is_active: bool,
    pub version: i64,
    pub updated_at: String,
    pub synced_at: String,
    #[serde(default)]
    pub components: Vec<RecipeComponentInput>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecipeComponentInput {
    #[serde(default)]
    pub id: Option<String>,
    pub recipe_id: String,
    pub inventory_item_id: String,
    pub quantity: String,
    pub unit: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeWriteResult {
    pub inserted: usize,
    pub updated: usize,
    pub components_inserted: usize,
    pub components_updated: usize,
}

#[derive(Debug, Clone)]
struct ResolvedRecipe {
    id: Option<String>,
    product_variant_id: String,
    remote_id: Option<String>,
    yield_unit: String,
    yield_quantity_milli: i64,
    is_active: bool,
    version: i64,
    updated_at: String,
    synced_at: String,
    components: Vec<ResolvedComponent>,
}

#[derive(Debug, Clone)]
struct ResolvedComponent {
    id: Option<String>,
    recipe_id: String,
    inventory_item_id: String,
    quantity_milli: i64,
    unit: String,
    created_at: String,
}

fn require_non_empty(field: &str, value: &str) -> Result<(), CommandError> {
    if value.trim().is_empty() {
        return Err(CommandError::invalid(field, "must not be empty"));
    }
    Ok(())
}

fn resolve_component(
    recipe_index: usize,
    component_index: usize,
    input: &RecipeComponentInput,
) -> Result<ResolvedComponent, CommandError> {
    let label =
        |field: &str| format!("recipes[{recipe_index}].components[{component_index}].{field}");
    require_non_empty(&label("recipeId"), &input.recipe_id)?;
    require_non_empty(&label("inventoryItemId"), &input.inventory_item_id)?;
    require_non_empty(&label("unit"), &input.unit)?;
    require_non_empty(&label("createdAt"), &input.created_at)?;
    let quantity_milli = parse_milli_quantity(&label("quantity"), &input.quantity)?;
    if quantity_milli <= 0 {
        return Err(CommandError::invalid(
            &label("quantity"),
            "must be greater than zero; a recipe component cannot consume nothing",
        ));
    }

    Ok(ResolvedComponent {
        id: input.id.clone(),
        recipe_id: input.recipe_id.clone(),
        inventory_item_id: input.inventory_item_id.clone(),
        quantity_milli,
        unit: input.unit.clone(),
        created_at: input.created_at.clone(),
    })
}

fn resolve(index: usize, input: &RecipeInput) -> Result<ResolvedRecipe, CommandError> {
    let label = |field: &str| format!("recipes[{index}].{field}");
    require_non_empty(&label("productVariantId"), &input.product_variant_id)?;
    require_non_empty(&label("yieldUnit"), &input.yield_unit)?;
    require_non_empty(&label("updatedAt"), &input.updated_at)?;
    require_non_empty(&label("syncedAt"), &input.synced_at)?;
    if input.version < 0 {
        return Err(CommandError::invalid(
            &label("version"),
            "must be zero or positive; it is the server's optimistic-concurrency counter",
        ));
    }

    let yield_quantity_milli =
        parse_milli_quantity(&label("yieldQuantity"), &input.yield_quantity)?;
    if yield_quantity_milli <= 0 {
        return Err(CommandError::invalid(
            &label("yieldQuantity"),
            "must be greater than zero; a recipe cannot yield nothing",
        ));
    }

    let components = input
        .components
        .iter()
        .enumerate()
        .map(|(component_index, component)| resolve_component(index, component_index, component))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(ResolvedRecipe {
        id: input.id.clone(),
        product_variant_id: input.product_variant_id.clone(),
        remote_id: input.remote_id.clone(),
        yield_unit: input.yield_unit.clone(),
        yield_quantity_milli,
        is_active: input.is_active,
        version: input.version,
        updated_at: input.updated_at.clone(),
        synced_at: input.synced_at.clone(),
        components,
    })
}

pub fn apply_recipes(
    conn: &mut Connection,
    recipes: &[RecipeInput],
) -> Result<RecipeWriteResult, CommandError> {
    if recipes.is_empty() {
        return Ok(RecipeWriteResult {
            inserted: 0,
            updated: 0,
            components_inserted: 0,
            components_updated: 0,
        });
    }

    let resolved = recipes
        .iter()
        .enumerate()
        .map(|(index, input)| resolve(index, input))
        .collect::<Result<Vec<_>, _>>()?;

    let tx = conn
        .transaction()
        .map_err(|e| CommandError::storage("begin recipe transaction", e))?;
    let mut inserted = 0usize;
    let mut updated = 0usize;
    let mut components_inserted = 0usize;
    let mut components_updated = 0usize;

    {
        let mut recipe_stmt = tx
            .prepare(
                "INSERT INTO local_recipes (
         id, product_variant_id, remote_id, yield_unit, yield_quantity_milli,
         is_active, version, updated_at, synced_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT (product_variant_id) DO UPDATE SET
         yield_unit           = excluded.yield_unit,
         yield_quantity_milli = excluded.yield_quantity_milli,
         is_active            = excluded.is_active,
         version              = excluded.version,
         updated_at           = excluded.updated_at,
         synced_at            = excluded.synced_at
       WHERE excluded.version > local_recipes.version",
            )
            .map_err(|e| CommandError::storage("prepare recipe upsert", e))?;

        let mut component_stmt = tx
            .prepare(
                "INSERT INTO local_recipe_components (
         id, recipe_id, inventory_item_id, quantity_milli, unit, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (recipe_id, inventory_item_id) DO UPDATE SET
         quantity_milli = excluded.quantity_milli,
         unit           = excluded.unit,
         created_at     = excluded.created_at",
            )
            .map_err(|e| CommandError::storage("prepare recipe component upsert", e))?;

        for recipe in &resolved {
            let existed: i64 = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM local_recipes WHERE product_variant_id = ?1)",
                    rusqlite::params![recipe.product_variant_id],
                    |row| row.get(0),
                )
                .map_err(|e| CommandError::storage("probe local_recipes", e))?;

            let id = recipe
                .id
                .clone()
                .unwrap_or_else(|| format!("local:recipe:{}", recipe.product_variant_id));
            let params = vec![
                Value::Text(id),
                Value::Text(recipe.product_variant_id.clone()),
                recipe
                    .remote_id
                    .clone()
                    .map(Value::Text)
                    .unwrap_or(Value::Null),
                Value::Text(recipe.yield_unit.clone()),
                Value::Integer(recipe.yield_quantity_milli),
                Value::Integer(if recipe.is_active { 1 } else { 0 }),
                Value::Integer(recipe.version),
                Value::Text(recipe.updated_at.clone()),
                Value::Text(recipe.synced_at.clone()),
            ];
            for (offset, value) in params.iter().enumerate() {
                recipe_stmt
                    .raw_bind_parameter(offset + 1, value)
                    .map_err(|e| CommandError::storage("bind local_recipes", e))?;
            }
            let rows = recipe_stmt
                .raw_execute()
                .map_err(|e| CommandError::storage("upsert local_recipes", e))?;
            if rows > 0 {
                if existed == 1 {
                    updated += 1;
                } else {
                    inserted += 1;
                }
            }

            for component in &recipe.components {
                let component_existed: i64 = tx.query_row(
          "SELECT EXISTS(SELECT 1 FROM local_recipe_components WHERE recipe_id = ?1 AND inventory_item_id = ?2)",
          rusqlite::params![component.recipe_id, component.inventory_item_id],
          |row| row.get(0),
        ).map_err(|e| CommandError::storage("probe local_recipe_components", e))?;

                let component_id = component.id.clone().unwrap_or_else(|| {
                    format!(
                        "local:component:{}:{}",
                        component.recipe_id, component.inventory_item_id
                    )
                });
                let params = vec![
                    Value::Text(component_id),
                    Value::Text(component.recipe_id.clone()),
                    Value::Text(component.inventory_item_id.clone()),
                    Value::Integer(component.quantity_milli),
                    Value::Text(component.unit.clone()),
                    Value::Text(component.created_at.clone()),
                ];
                for (offset, value) in params.iter().enumerate() {
                    component_stmt
                        .raw_bind_parameter(offset + 1, value)
                        .map_err(|e| CommandError::storage("bind local_recipe_components", e))?;
                }
                let rows = component_stmt
                    .raw_execute()
                    .map_err(|e| CommandError::storage("upsert local_recipe_components", e))?;
                if rows > 0 {
                    if component_existed == 1 {
                        components_updated += 1;
                    } else {
                        components_inserted += 1;
                    }
                }
            }
        }
    }

    tx.commit()
        .map_err(|e| CommandError::storage("commit recipes", e))?;
    Ok(RecipeWriteResult {
        inserted,
        updated,
        components_inserted,
        components_updated,
    })
}

pub const INVALID_RECIPE_QUANTITY_KIND: CommandErrorKind = CommandErrorKind::InvalidPayload;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrate;

    const VARIANT: &str = "0199b1a0-0000-7000-8000-00000000a001";
    const RECIPE: &str = "0199b1a0-0000-7000-8000-00000000b001";
    const FLOUR: &str = "0199b1a0-0000-7000-8000-0000000000f1";
    const MILK: &str = "0199b1a0-0000-7000-8000-0000000000f2";
    const SYNCED_AT: &str = "2026-10-05T09:00:00Z";
    const UPDATED_AT: &str = "2026-10-05T08:59:00Z";

    fn conn() -> Connection {
        let mut c = Connection::open_in_memory().expect("open in-memory database");
        migrate::migrate(&mut c).expect("migrate");
        c
    }

    fn component(item: &str, quantity: &str) -> RecipeComponentInput {
        RecipeComponentInput {
            id: Some(format!("component-{item}")),
            recipe_id: RECIPE.to_owned(),
            inventory_item_id: item.to_owned(),
            quantity: quantity.to_owned(),
            unit: "kg".to_owned(),
            created_at: UPDATED_AT.to_owned(),
        }
    }

    fn recipe(
        yield_quantity: &str,
        version: i64,
        components: Vec<RecipeComponentInput>,
    ) -> RecipeInput {
        RecipeInput {
            id: Some("local-recipe".to_owned()),
            product_variant_id: VARIANT.to_owned(),
            remote_id: Some(RECIPE.to_owned()),
            yield_unit: "pcs".to_owned(),
            yield_quantity: yield_quantity.to_owned(),
            is_active: true,
            version,
            updated_at: UPDATED_AT.to_owned(),
            synced_at: SYNCED_AT.to_owned(),
            components,
        }
    }

    fn count(c: &Connection, table: &str) -> i64 {
        c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .expect("count")
    }

    fn milli_of(c: &Connection, table: &str, column: &str) -> i64 {
        c.query_row(
            &format!("SELECT {column} FROM {table} LIMIT 1"),
            [],
            |row| row.get(0),
        )
        .expect("milli")
    }

    #[test]
    fn a_recipe_snapshot_lands_as_milli_units() {
        let mut c = conn();
        let result = apply_recipes(
            &mut c,
            &[recipe("1.000", 7, vec![component(FLOUR, "0.125")])],
        )
        .unwrap();

        assert_eq!(
            result,
            RecipeWriteResult {
                inserted: 1,
                updated: 0,
                components_inserted: 1,
                components_updated: 0
            }
        );
        assert_eq!(milli_of(&c, "local_recipes", "yield_quantity_milli"), 1000);
        assert_eq!(
            milli_of(&c, "local_recipe_components", "quantity_milli"),
            125
        );
    }

    #[test]
    fn malformed_component_aborts_the_whole_snapshot() {
        let mut c = conn();
        let before = count(&c, "local_recipes");
        let error = apply_recipes(
            &mut c,
            &[recipe(
                "1.000",
                1,
                vec![component(FLOUR, "0.125"), component(MILK, "0.0001")],
            )],
        )
        .expect_err("fourth fraction digit fails");

        assert_eq!(error.kind, INVALID_RECIPE_QUANTITY_KIND);
        assert_eq!(count(&c, "local_recipes"), before);
        assert_eq!(count(&c, "local_recipe_components"), 0);
    }

    #[test]
    fn pulling_the_same_recipe_twice_updates_rather_than_duplicates() {
        let mut c = conn();
        let first = apply_recipes(
            &mut c,
            &[recipe("1.000", 7, vec![component(FLOUR, "0.125")])],
        )
        .unwrap();
        let second = apply_recipes(
            &mut c,
            &[recipe("2.000", 8, vec![component(FLOUR, "0.250")])],
        )
        .unwrap();

        assert_eq!(first.inserted, 1);
        assert_eq!(second.updated, 1);
        assert_eq!(count(&c, "local_recipes"), 1);
        assert_eq!(count(&c, "local_recipe_components"), 1);
        assert_eq!(milli_of(&c, "local_recipes", "yield_quantity_milli"), 2000);
        assert_eq!(
            milli_of(&c, "local_recipe_components", "quantity_milli"),
            250
        );
    }

    #[test]
    fn stale_recipe_snapshot_does_not_overwrite_newer_recipe() {
        let mut c = conn();
        apply_recipes(&mut c, &[recipe("2.000", 8, vec![])]).unwrap();
        let stale = apply_recipes(&mut c, &[recipe("9.000", 7, vec![])]).unwrap();

        assert_eq!(
            stale,
            RecipeWriteResult {
                inserted: 0,
                updated: 0,
                components_inserted: 0,
                components_updated: 0
            }
        );
        assert_eq!(milli_of(&c, "local_recipes", "yield_quantity_milli"), 2000);
    }

    #[test]
    fn database_refuses_real_quantity_columns() {
        let c = conn();
        let error = c.execute(
      "INSERT INTO local_recipes
         (id, product_variant_id, yield_unit, yield_quantity_milli, is_active, version, updated_at, synced_at)
       VALUES ('x', ?1, 'pcs', 0.3, 1, 1, ?2, ?3)",
      rusqlite::params![VARIANT, UPDATED_AT, SYNCED_AT],
    );
        assert!(
            error.is_err(),
            "a REAL must never commit into a recipe quantity column"
        );
    }
}
