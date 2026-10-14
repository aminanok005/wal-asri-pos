//! The terminal's local `StockBalance` cache — parse a pulled snapshot and
//! UPSERT it into `stock_balances`.
//!
//! WHAT THIS MODULE IS ──────────────────────────────────────────────────────────
//! Migration 0003 added `stock_balances`: a READ CACHE of the cloud's
//! `StockBalance`, so the sell path can answer "is there enough of this?" with
//! the network unplugged. A Thai branch loses its link constantly, and a stock
//! check that blocks on the network is a till that stops serving customers.
//!
//! The server owns the balance — `contracts/openapi.yaml`, schema `StockBalance`:
//! "Derived, never written by a client" — and this module never invents one. It
//! takes what the pull delivered, converts it, and stores it. `inventory/domain/README.md`
//! states the governing rule: "stock is a ledger of movements, never an
//! overwritten number."
//!
//! ── WHY THE QUANTITY CROSSES AS A STRING ─────────────────────────────────────
//! `on_hand` and `reserved` arrive as `String` and become `i64` milli-units.
//! Both halves of that are deliberate, and they mirror what `commands.rs` does
//! for satang:
//!
//!   * `invoke` serialises through JSON, and a JSON number is an IEEE-754 double
//!     in JavaScript. A quantity is not merely "large" — it is *decimal*: `2.500`
//!     kg of flour has no exact binary representation at all. Sending it as a
//!     number makes the drift a property of the wire format rather than a rule
//!     the caller must remember.
//!   * SQLite has no column types, it has type AFFINITY. A column declared
//!     `INTEGER` accepts the TEXT `"2500"` without complaint, converting it by
//!     coercion, so a string that reached a money-or-quantity column as text is
//!     indistinguishable from a real integer afterwards. Binding `Value::Integer`
//!     makes that failure mode unreachable at the bridge instead of merely
//!     unlikely.
//!
//! So the value reaches SQLite as an `i64` milli-count, never as text, and
//! never as a float.
//!
//! ── WHY MILLI-UNITS ───────────────────────────────────────────────────────────
//! `on_hand` is `decimal(12,3)` in the data model, so three fraction digits is
//! the most this system can represent — a fourth is a value the server cannot
//! store either. [`parse_milli_quantity`] refuses one instead of rounding it:
//! silently truncating a stock count is how a shop sells flour it does not have.
//!
//! The parse is integer string surgery: split on the point, parse the whole and
//! the right-padded fraction separately, then combine them as
//! `whole * 1000 + fraction`. There is no `f64` anywhere on this path, so
//! `0.1 + 0.2` is not a value that can reach a balance column.
//!
//! ── WHAT THE SCHEMA CHECK DOES AND DOES NOT COVER ─────────────────────────────
//!
//! `0003_stock_balances.sql` puts `CHECK (typeof(on_hand_milli) = 'integer')` on
//! each quantity column, and it is worth being precise about its reach, because
//! the obvious reading of it is wrong. It rejects REAL (`0.1 + 0.2`) and
//! non-numeric TEXT. It does **NOT** reject the numeric string `'2500'`, and it
//! cannot: SQLite applies type affinity BEFORE constraints are evaluated, so the
//! value is already an integer by the time the CHECK runs and the evidence that
//! it was ever a string is gone. `test/migrations.test.ts` asserts that
//! behaviour, so it cannot be quietly assumed otherwise.
//!
//! That is not a reason to stop sending strings — it is the reason the string
//! rule lives HERE rather than in the schema. This parser is what actually
//! guarantees an integer arrives.
use rusqlite::types::Value;
use rusqlite::Connection;

use crate::commands::CommandError;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveStockConflictArgs {
    pub inventory_item_id: String,
    pub branch_id: String,
    pub resolved_quantity_milli: i64,
    pub reason: String,
    pub actor_terminal_id: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveStockConflictResult {
    pub inventory_item_id: String,
    pub branch_id: String,
    pub old_quantity_milli: i64,
    pub new_quantity_milli: i64,
    pub requires_reconcile: i32,
    pub updated_at: String,
    pub audit_log_id: String,
}


/// Milli-units per whole unit. Fixed by `decimal(12,3)`, not a choice made here.
pub const MILLI_PER_UNIT: i64 = 1_000;

/// Fraction digits a quantity may carry. One more is unrepresentable, not rounded.
pub const MAX_FRACTION_DIGITS: usize = 3;

/// One pulled `StockBalance`, exactly as the wire delivers it.
///
/// `on_hand` and `reserved` are `String` for the reason in the module header.
/// `deny_unknown_fields` matches `commands.rs`: an extra key is a sign the two
/// sides are at different versions, and silently ignoring it would mean writing
/// a row from a shape this build does not understand.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StockBalanceInput {
  /// The LOCAL row's client-generated UUIDv7. Nullable so a caller that has not
  /// minted one yet can fall back to the natural key — the UPSERT below is keyed
  /// on `(branch_id, inventory_item_id)` and does not need it to decide anything.
  #[serde(default)]
  pub id: Option<String>,
  pub inventory_item_id: String,
  pub branch_id: String,
  /// QUANTITY — exact decimal string, 3 dp. `2.500` → 2500 milli-units.
  pub on_hand: String,
  /// QUANTITY — exact decimal string, 3 dp. `1.250` → 1250 milli-units.
  pub reserved: String,
  #[serde(default)]
  pub remote_id: Option<String>,
  pub version: i64,
  /// Server clock, RFC 3339 UTC. Also the `since` cursor for the next pull.
  pub updated_at: String,
  /// Terminal clock, RFC 3339 UTC — written by the caller, not derived here.
  pub synced_at: String,
}

/// What the UPSERT reports back.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockBalanceWriteResult {
  /// Rows inserted (a natural key seen for the first time).
  pub inserted: usize,
  /// Rows updated (a newer snapshot replaced an older one).
  pub updated: usize,
}

// ─────────────────────────────────────────────────────────────────────────────
// The edge: decimal string → milli-units
// ─────────────────────────────────────────────────────────────────────────────

/// Parse one contract `Quantity` string into an exact count of milli-units.
///
/// The grammar is `^-?(0|[1-9][0-9]*)(\.[0-9]{1,3})?$` — a **tightening** of
/// the contract's `^-?\d+(\.\d{1,3})?$`. The three shapes it refuses and the
/// contract permits are all second spellings of a value that already exists:
///
///   * `"07"` / `"-07"` — a leading zero, which is exactly what a zero-padded
///     formatter emits. Rejected for the same reason `"04550"` satang is; it
///     matches the reasoning already recorded at `parse_satang_with`.
///   * `"-0"` — a sign on zero.
///
/// A `+` is absent from the contract pattern and refused here too. So is
/// `"2."`, `".5"`, `"2.5e3"`, surrounding whitespace, and any fourth fraction
/// digit.
///
/// The arithmetic is integer throughout. `"2.5"` → `2` and `500` → `2500`;
/// `"-0.125"` → `-125`. There is no float step available to be wrong.
pub fn parse_milli_quantity(field: &str, raw: &str) -> Result<i64, CommandError> {
  let (negative, digits) = match raw.strip_prefix('-') {
    Some(rest) => (true, rest),
    None => (false, raw),
  };

  let (whole, fraction, had_point) = match digits.split_once('.') {
    Some((whole, fraction)) => (whole, fraction, true),
    None => (digits, "", false),
  };

  // ── The whole part ────────────────────────────────────────────────────────
  if whole.is_empty() {
    return Err(CommandError::invalid(
      field,
      &format!("{raw:?} has no integer part; a quantity must be written like \"2.500\""),
    ));
  }
  if !whole.bytes().all(|b| b.is_ascii_digit()) {
    return Err(CommandError::invalid(
      field,
      &format!("must be plain base-ten digits, got {raw:?}; an exponent or surrounding whitespace is rejected so no value reaches SQLite as text"),
    ));
  }
  if whole.len() > 1 && whole.starts_with('0') {
    return Err(CommandError::invalid(
      field,
      &format!("has a leading zero ({raw:?}); send the canonical decimal form"),
    ));
  }
  // `-0`, and `-0.000` with a fraction attached, are both second spellings of
  // zero. Refused for the same reason `"00"` is in `parse_satang_with`.
  if negative && whole == "0" && fraction.trim_end_matches('0').is_empty() {
    return Err(CommandError::invalid(
      field,
      &format!("is {raw:?}; negative zero is a second spelling of zero, send \"0.000\""),
    ));
  }

  // ── The fraction ──────────────────────────────────────────────────────────
  // A point with nothing after it. `"2."` is the shape a naive
  // `value.toFixed()`-style formatter emits when it loses the digits, and
  // accepting it would silently mean `2` rather than reporting a broken value.
  if had_point && fraction.is_empty() {
    return Err(CommandError::invalid(
      field,
      &format!("{raw:?} has a decimal point with no digits after it; write it like \"2.500\""),
    ));
  }
  if fraction.len() > MAX_FRACTION_DIGITS {
    return Err(CommandError::invalid(
      field,
      &format!("has {} fraction digits ({raw:?}); `on_hand` is decimal(12,3), so a fourth digit is not a quantity this system can represent — refusing it beats truncating a stock count",
        fraction.len()),
    ));
  }
  if !fraction.bytes().all(|b| b.is_ascii_digit()) {
    return Err(CommandError::invalid(
      field,
      &format!("{raw:?} has a non-numeric fraction; digits only, no exponent and no second point"),
    ));
  }

  // Right-pad to exactly three digits: `"5"` → `"500"`, `"50"` → `"500"`,
  // `"500"` → `"500"`. So `"2.5"` and `"2.50"` are the SAME value, which is what
  // makes them second spellings rather than two quantities.
  let padded = format!("{fraction:0<width$}", width = MAX_FRACTION_DIGITS);

  // Both halves are parsed separately and then combined, so there is no
  // reliance on concatenation being lossless: `2.5` → `2 * 1000 + 500`, and a
  // value with no fraction → `12 * 1000 + 0`. The right-padding to a FIXED
  // width is what makes `2.50` and `2.5` land on the same integer.
  let whole_value: i64 = whole
    .parse()
    .map_err(|_| quantity_overflow(field, raw, "integer part"))?;
  let fraction_value: i64 = padded
    .parse()
    .map_err(|_| quantity_overflow(field, raw, "fraction"))?;

  // The sign is applied HERE, to the combined magnitude, and not to either half
  // separately. Negating the whole part first and then adding a positive
  // fraction would give `-2 * 1000 + 500 == -1500` for `"-2.500"` instead of
  // `-2500` — an error of exactly 1000, which is 1.000 of the article, and it
  // is silent. The `i128` intermediate keeps `i64::MIN` adjacent magnitudes from
  // overflowing while being scaled.
  let milli = (whole_value as i128) * MILLI_PER_UNIT as i128 + fraction_value as i128;
  let milli = if negative { -milli } else { milli };
  if milli > i64::MAX as i128 || milli < i64::MIN as i128 {
    return Err(quantity_overflow(field, raw, "value"));
  }
  Ok(milli as i64)
}

/// One "this does not fit" rejection, worded once so the three call sites above
/// cannot drift into three different explanations of the same problem.
fn quantity_overflow(field: &str, raw: &str, which: &str) -> CommandError {
  CommandError::invalid(
    field,
    &format!(
      "the {which} of {raw:?} does not fit in a signed 64-bit count of milli-units; \
       a balance that large is a parsing bug, not stock"
    ),
  )
}

/// One balance with both quantities already resolved to milli-units.
#[derive(Debug, Clone)]
struct ResolvedBalance {
  id: Option<String>,
  inventory_item_id: String,
  branch_id: String,
  remote_id: Option<String>,
  on_hand_milli: i64,
  reserved_milli: i64,
  version: i64,
  updated_at: String,
  synced_at: String,
}

/// Validate and convert one wire balance, or name the field that failed.
fn resolve(index: usize, input: &StockBalanceInput) -> Result<ResolvedBalance, CommandError> {
  let label = |field: &str| format!("balances[{index}].{field}");

  let on_hand_milli = parse_milli_quantity(&label("onHand"), &input.on_hand)?;
  let reserved_milli = parse_milli_quantity(&label("reserved"), &input.reserved)?;

  // The schema CHECKs `reserved_milli >= 0`, but catching it HERE means the
  // caller gets a `balances[3].reserved` message instead of a bare
  // "CHECK constraint failed" from SQLite with no idea which row was at fault.
  // `on_hand` is deliberately NOT bounded below: the contract says a balance may
  // go negative when an offline terminal oversells, and refusing it would make
  // the terminal unable to RECORD the oversell it needs an operator to see.
  if reserved_milli < 0 {
    return Err(CommandError::invalid(
      &label("reserved"),
      "must not be negative; a negative reservation would report more stock available than physically exists",
    ));
  }
  if input.version < 0 {
    return Err(CommandError::invalid(
      &label("version"),
      "must be zero or positive; it is the server's optimistic-concurrency counter",
    ));
  }
  for (field, value) in [
    ("branchId", &input.branch_id),
    ("inventoryItemId", &input.inventory_item_id),
    ("updatedAt", &input.updated_at),
    ("syncedAt", &input.synced_at),
  ] {
    if value.trim().is_empty() {
      return Err(CommandError::invalid(&label(field), "must not be empty"));
    }
  }

  Ok(ResolvedBalance {
    id: input.id.clone(),
    inventory_item_id: input.inventory_item_id.clone(),
    branch_id: input.branch_id.clone(),
    remote_id: input.remote_id.clone(),
    on_hand_milli,
    reserved_milli,
    version: input.version,
    updated_at: input.updated_at.clone(),
    synced_at: input.synced_at.clone(),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// The write
// ─────────────────────────────────────────────────────────────────────────────

/// UPSERT a pulled snapshot into `stock_balances`, in ONE transaction.
///
/// ## Why one transaction
///
/// A snapshot that half-writes is worse than one that does not write. A
/// cashier asking about flour while the branch's snapshot is landing would see
/// a row from the new pull beside a row from an hour ago and have no way to tell
/// which is current. Either the whole pull is visible or none of it is.
///
/// ## Why an UPSERT and not an INSERT
///
/// The natural key `(branch_id, inventory_item_id)` carries a `UNIQUE`
/// constraint, so re-pulling the same article updates its row instead of
/// accumulating duplicates. That is what makes the sync **idempotent**: a pull
/// interrupted halfway and retried, or a server that returns the same delta
/// twice, converges on the same table instead of doubling the stock.
///
/// ## Why the WHERE clause exists
///
/// `ON CONFLICT ... DO UPDATE SET ... WHERE excluded.version > stock_balances.version`
/// — the older snapshot does not overwrite the newer one. Without it, a replay
/// of a stale pull (a proxy cache, a retried request arriving out of order)
/// would silently roll the terminal's stock backwards to a figure the server has
/// already superseded, and nothing would report it.
///
/// ## Why `id` is not rewritten on conflict
///
/// `stock_balances_identity_immutable` forbids it. The local row's UUIDv7 is
/// minted once and never reassigned; the server's own identifier lives in
/// `remote_id`, which the UPSERT does update, because that is a fact about the
/// same row arriving for the first time rather than a re-attribution.
pub fn apply_stock_balances(
  conn: &mut Connection,
  balances: &[StockBalanceInput],
) -> Result<StockBalanceWriteResult, CommandError> {
  if balances.is_empty() {
    return Ok(StockBalanceWriteResult {
      inserted: 0,
      updated: 0,
    });
  }

  // Every row is validated BEFORE any statement runs, so a malformed quantity in
  // the last row cannot leave the first nineteen written. Same rule as
  // `write_order`: shape is decided at the edge, and it is decided before the
  // database is touched at all.
  let resolved: Vec<ResolvedBalance> = balances
    .iter()
    .enumerate()
    .map(|(index, input)| resolve(index, input))
    .collect::<Result<Vec<_>, _>>()?;

  let tx = conn
    .transaction()
    .map_err(|e| CommandError::storage("begin stock balance transaction", e))?;

  let mut inserted = 0usize;
  let mut updated = 0usize;

  {
    let mut stmt = tx
      .prepare(
        "INSERT INTO stock_balances (
           id, inventory_item_id, branch_id, remote_id,
           on_hand_milli, reserved_milli, version, updated_at, synced_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (branch_id, inventory_item_id) DO UPDATE SET
           remote_id     = excluded.remote_id,
           on_hand_milli = excluded.on_hand_milli,
           reserved_milli = excluded.reserved_milli,
           version       = excluded.version,
           updated_at    = excluded.updated_at,
           synced_at     = excluded.synced_at
         WHERE excluded.version > stock_balances.version",
      )
      .map_err(|e| CommandError::storage("prepare stock balance upsert", e))?;

    for row in &resolved {
      // A locally-created row with no id yet still has to satisfy the PRIMARY
      // KEY, so fall back to the natural key. It is stable and unique, which is
      // all SQLite requires — and if the server later supplies a real UUIDv7 it
      // lands in `remote_id`, where the schema expects it.
      let id = row
        .id
        .clone()
        .unwrap_or_else(|| format!("local:{}:{}", row.branch_id, row.inventory_item_id));

      let params: Vec<Value> = vec![
        Value::Text(id),
        Value::Text(row.inventory_item_id.clone()),
        Value::Text(row.branch_id.clone()),
        match &row.remote_id {
          Some(v) => Value::Text(v.clone()),
          None => Value::Null,
        },
        Value::Integer(row.on_hand_milli),
        Value::Integer(row.reserved_milli),
        Value::Integer(row.version),
        Value::Text(row.updated_at.clone()),
        Value::Text(row.synced_at.clone()),
      ];

      for (offset, value) in params.iter().enumerate() {
        stmt
          .raw_bind_parameter(offset + 1, value)
          .map_err(|e| CommandError::storage("bind stock_balances", e))?;
      }

      // Whether this is an INSERT or an UPDATE has to be decided BEFORE the
      // statement runs. Probing afterwards would always find the row present and
      // report every write as an update, which is exactly the number an operator
      // watches to tell a first pull from a delta.
      let existed: i64 = tx
        .query_row(
          "SELECT EXISTS(SELECT 1 FROM stock_balances WHERE branch_id = ?1 AND inventory_item_id = ?2)",
          rusqlite::params![row.branch_id, row.inventory_item_id],
          |r| r.get(0),
        )
        .map_err(|e| CommandError::storage("probe stock_balances", e))?;

      // `DO UPDATE ... WHERE` reports 0 rows when the incoming snapshot is not
      // newer. That is not a failure and must not be counted as an update, so
      // the count comes from the statement's own report rather than from a
      // before/after SELECT.
      let rows = stmt
        .raw_execute()
        .map_err(|e| CommandError::storage("upsert stock_balances", e))?;
      if rows == 0 {
        continue;
      }

      if existed == 1 {
        updated += 1;
      } else {
        inserted += 1;
      }
    }
  }

  tx.commit()
    .map_err(|e| CommandError::storage("commit stock balances", e))?;

  Ok(StockBalanceWriteResult { inserted, updated })
}

/// Stock conflict item for listing conflicts.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockConflictItem {
    pub inventory_item_id: String,
    pub branch_id: String,
    pub local_quantity_milli: i64,
    pub cloud_quantity_milli: Option<i64>,
    pub requires_reconcile: bool,
    pub updated_at: String,
}

/// One balance as the UI reads it back. Quantities are **strings**, both
/// directions, for the reason at the module header.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockBalanceRecord {
  pub id: String,
  pub inventory_item_id: String,
  pub branch_id: String,
  /// QUANTITY as the canonical 3-dp decimal string, e.g. `"2.500"`.
  pub on_hand: String,
  /// QUANTITY as the canonical 3-dp decimal string, e.g. `"0.000"`.
  pub reserved: String,
  /// `on_hand - reserved`, also a string. Signed on purpose.
  pub available: String,
  pub version: i64,
  pub updated_at: String,
  pub synced_at: String,
}

/// Render milli-units as the canonical contract string. Integer division plus a
/// zero-padded remainder — no `toFixed`, which would go through a double.
///
/// The magnitude is widened to `i128` first so `i64::MIN` negates without
/// overflowing, which is the one value that is both reachable and asymmetric.
fn milli_to_string(milli: i64) -> String {
  let magnitude = milli as i128;
  let negative = magnitude < 0;
  let magnitude = if negative { -magnitude } else { magnitude };
  format!(
    "{sign}{whole}.{fraction:0>width$}",
    sign = if negative { "-" } else { "" },
    whole = magnitude / MILLI_PER_UNIT as i128,
    fraction = magnitude % MILLI_PER_UNIT as i128,
    width = MAX_FRACTION_DIGITS
  )
}

/// Read one article's cached balance, or `None` if it has never been pulled.
///
/// A lookup that returns `None` rather than an error is deliberate: a grid can
/// be mid-render holding an id the last pull has not caught up with, and
/// throwing there would take the register down mid-sale. An article with no
/// cached balance is "unknown offline", which the caller surfaces — it is not
/// the same as "zero in stock", and conflating them is how a shop refuses to
/// sell an item it actually has.
pub fn stock_balance_for(
  conn: &Connection,
  branch_id: &str,
  inventory_item_id: &str,
) -> Result<Option<StockBalanceRecord>, CommandError> {
  let mut stmt = conn
    .prepare(
      "SELECT id, inventory_item_id, branch_id, on_hand_milli, reserved_milli, version, updated_at, synced_at
         FROM stock_balances
        WHERE branch_id = ?1 AND inventory_item_id = ?2",
    )
    .map_err(|e| CommandError::storage("prepare stock balance read", e))?;

  let mut rows = stmt
    .query(rusqlite::params![branch_id, inventory_item_id])
    .map_err(|e| CommandError::storage("read stock balance", e))?;

  let Some(row) = rows.next().map_err(|e| CommandError::storage("read stock balance", e))? else {
    return Ok(None);
  };

  let on_hand_milli: i64 = row.get(3).map_err(|e| CommandError::storage("read on_hand_milli", e))?;
  let reserved_milli: i64 = row.get(4).map_err(|e| CommandError::storage("read reserved_milli", e))?;

  Ok(Some(StockBalanceRecord {
    id: row.get(0).map_err(|e| CommandError::storage("read id", e))?,
    inventory_item_id: row
      .get(1)
      .map_err(|e| CommandError::storage("read inventory_item_id", e))?,
    branch_id: row.get(2).map_err(|e| CommandError::storage("read branch_id", e))?,
    on_hand: milli_to_string(on_hand_milli),
    reserved: milli_to_string(reserved_milli),
    // `on_hand - reserved`, computed here rather than stored — see the schema
    // header. i64 arithmetic: a millisecond-free integer difference cannot
    // overflow for any balance a shop can hold.
    available: milli_to_string(on_hand_milli - reserved_milli),
    version: row.get(5).map_err(|e| CommandError::storage("read version", e))?,
    updated_at: row.get(6).map_err(|e| CommandError::storage("read updated_at", e))?,
    synced_at: row.get(7).map_err(|e| CommandError::storage("read synced_at", e))?,
  }))
}

/// Ensure the given stock balance is not in reconciliation state.
/// Returns CommandError with code "stock_requires_reconcile" if locked.
pub fn ensure_not_reconciling(
    conn: &Connection,
    inventory_item_id: &str,
    branch_id: &str,
) -> Result<(), CommandError> {
    let requires_reconcile: i32 = conn
        .query_row(
            "SELECT COALESCE(requires_reconcile,0) FROM stock_balances WHERE inventory_item_id=?1 AND branch_id=?2",
            rusqlite::params![inventory_item_id, branch_id],
            |x| x.get(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => CommandError::stock_balance_not_found(
                vec![inventory_item_id.to_string()],
                format!("stock balance not found for item {}", inventory_item_id),
            ),
            _ => CommandError::storage("read requires_reconcile", e),
        })?;
    if requires_reconcile == 1 {
        return Err(CommandError::stock_requires_reconcile(
            vec![inventory_item_id.to_string()],
            "stock reconciliation required for item".to_string(),
        ));
    }
    Ok(())
}

/// Transactional variant of ensure_not_reconciling
pub fn ensure_not_reconciling_tx(
    tx: &rusqlite::Transaction,
    inventory_item_id: &str,
    branch_id: &str,
) -> Result<(), CommandError> {
    let requires_reconcile: i32 = tx
        .query_row(
            "SELECT COALESCE(requires_reconcile,0) FROM stock_balances WHERE inventory_item_id=?1 AND branch_id=?2",
            rusqlite::params![inventory_item_id, branch_id],
            |x| x.get(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => CommandError::stock_balance_not_found(
                vec![inventory_item_id.to_string()],
                format!("stock balance not found for item {}", inventory_item_id),
            ),
            _ => CommandError::storage("read requires_reconcile", e),
        })?;
    if requires_reconcile == 1 {
        return Err(CommandError::stock_requires_reconcile(
            vec![inventory_item_id.to_string()],
            "stock reconciliation required for item".to_string(),
        ));
    }
    Ok(())
}

/// Read the latest cloud_updated_at from stock_balances, serving as the cursor for incremental pulls.
pub fn last_cloud_updated_at(conn: &Connection) -> Result<Option<String>, CommandError> {
    let res: Result<Option<String>, rusqlite::Error> = conn.query_row(
        "SELECT MAX(cloud_updated_at) FROM stock_balances",
        [],
        |row| row.get(0),
    );
    match res {
        Ok(v) => Ok(v),
        Err(e) => Err(CommandError::storage("read last cloud updated at", e)),
    }
}

/// List all stock balances that have `requires_reconcile = 1`.
/// If `branch_id` is empty, return conflicts from all branches.
pub fn list_stock_conflicts(
    conn: &Connection,
    branch_id: &str,
) -> Result<Vec<StockConflictItem>, CommandError> {
    let mut query = String::from(
        "SELECT inventory_item_id, branch_id, on_hand_milli, conflict_cloud_quantity_milli, requires_reconcile, updated_at
         FROM stock_balances
        WHERE requires_reconcile = 1",
    );
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if !branch_id.is_empty() {
        query.push_str(" AND branch_id = ?");
        params.push(Box::new(branch_id.to_string()));
    }
    query.push_str(" ORDER BY updated_at DESC");

    let mut stmt = conn.prepare(&query).map_err(|e| CommandError::storage("prepare list stock conflicts", e))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())), |row| {
            let requires_reconcile: i32 = row.get(4)?;
            Ok(StockConflictItem {
                inventory_item_id: row.get(0)?,
                branch_id: row.get(1)?,
                local_quantity_milli: row.get(2)?,
                cloud_quantity_milli: row.get(3)?,
                requires_reconcile: requires_reconcile == 1,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|e| CommandError::storage("query stock conflicts", e))?;

    let mut conflicts = Vec::new();
    for row in rows {
        conflicts.push(row.map_err(|e| CommandError::storage("read stock conflict row", e))?);
    }
    Ok(conflicts)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::commands::CommandErrorKind;
  use crate::migrate;

  const BRANCH: &str = "0199b1a0-0000-7000-8000-000000000001";
  const FLOUR: &str = "0199b1a0-0000-7000-8000-0000000000f1";
  const MILK: &str = "0199b1a0-0000-7000-8000-0000000000f2";

  const SYNCED_AT: &str = "2026-10-05T09:00:00Z";
  const UPDATED_AT: &str = "2026-10-05T08:59:00Z";

  fn conn() -> Connection {
    let mut c = Connection::open_in_memory().expect("open in-memory database");
    migrate::migrate(&mut c).expect("migrate");
    c
  }

  fn balance(item: &str, on_hand: &str, reserved: &str, version: i64) -> StockBalanceInput {
    StockBalanceInput {
      id: Some(format!("local-{item}")),
      inventory_item_id: item.to_owned(),
      branch_id: BRANCH.to_owned(),
      on_hand: on_hand.to_owned(),
      reserved: reserved.to_owned(),
      remote_id: Some(format!("remote-{item}")),
      version,
      updated_at: UPDATED_AT.to_owned(),
      synced_at: SYNCED_AT.to_owned(),
    }
  }

  fn milli_of(c: &Connection, item: &str, column: &str) -> i64 {
    c
      .query_row(
        &format!("SELECT {column} FROM stock_balances WHERE inventory_item_id = ?1"),
        [item],
        |r| r.get(0),
      )
      .unwrap_or_else(|e| panic!("read {column} for {item}: {e}"))
  }

  fn count(c: &Connection, table: &str) -> i64 {
    c
      .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
      .expect("count")
  }

  // ── The parser ────────────────────────────────────────────────────────────

  /// THE test for the whole feature: a decimal quantity becomes an exact
  /// integer milli-count, with no float anywhere on the path.
  #[test]
  fn a_decimal_quantity_becomes_exact_milli_units() {
    assert_eq!(parse_milli_quantity("q", "2.500").unwrap(), 2500);
    assert_eq!(parse_milli_quantity("q", "0.001").unwrap(), 1);
    assert_eq!(parse_milli_quantity("q", "12").unwrap(), 12_000);
    assert_eq!(parse_milli_quantity("q", "0").unwrap(), 0);
    // A trailing zero is a second spelling, and both reach the same value.
    assert_eq!(parse_milli_quantity("q", "2.5").unwrap(), 2500);
    assert_eq!(parse_milli_quantity("q", "2.50").unwrap(), 2500);
  }

  #[test]
  fn a_negative_balance_parses_because_an_offline_terminal_can_oversell() {
    assert_eq!(parse_milli_quantity("q", "-0.125").unwrap(), -125);
    assert_eq!(parse_milli_quantity("q", "-3").unwrap(), -3000);
  }

  /// The drift this class of type exists to make unrepresentable. `0.3` as a
  /// double is `0.299999999999999988897769753748`, and the assertion below is
  /// that the parser never takes that path — it does integer surgery instead.
  #[test]
  fn no_quantity_ever_goes_through_a_binary_float() {
    let sum = parse_milli_quantity("q", "0.1").unwrap() + parse_milli_quantity("q", "0.2").unwrap();
    assert_eq!(sum, 300, "0.1 + 0.2 must be exactly 300 milli-units, not 299.99999999999998");
    assert_ne!(0.1f64 + 0.2f64, 0.3f64, "the float path is the bug, not the expectation");
  }

  #[test]
  fn a_fourth_fraction_digit_is_refused_rather_than_truncated() {
    let error = parse_milli_quantity("q", "2.5001").expect_err("decimal(12,3) cannot hold a 4th digit");
    assert_eq!(error.kind, crate::commands::CommandErrorKind::InvalidPayload);
    assert!(error.message.contains("q:"), "message should name the field: {}", error.message);
  }

  #[test]
  fn a_second_spelling_of_one_value_is_refused() {
    // Leading zeros, signed zero: each is a second spelling, and each is how two
    // terminals end up disagreeing about one shelf.
    for bad in ["07", "-07", "-0", "-0.000", "+5", " 5", "5 "] {
      let rejected = parse_milli_quantity("q", bad);
      assert!(
        rejected.is_err(),
        "{bad:?} must be refused, got {:?}",
        rejected.map(|v| v.to_string())
      );
      if let Err(err) = rejected {
        assert_eq!(err.kind, crate::commands::CommandErrorKind::InvalidPayload, "{bad:?}");
      }
    }
  }

  #[test]
  fn a_float_scientific_or_dotty_spelling_is_refused() {
    for bad in ["2.5e3", "0x11A", "2.", ".5", "2.5.0", "NaN", "Infinity", "", "-", "1,5"] {
      assert!(
        parse_milli_quantity("q", bad).is_err(),
        "{bad:?} must not parse as a quantity"
      );
    }
  }

  // ── The write ─────────────────────────────────────────────────────────────

  #[test]
  fn a_pulled_snapshot_lands_in_the_local_table_as_milli_units() {
    let mut c = conn();
    let result = apply_stock_balances(&mut c, &[balance(FLOUR, "2.500", "0.250", 7)]).unwrap();

    assert_eq!(result, StockBalanceWriteResult { inserted: 1, updated: 0 });
    assert_eq!(milli_of(&c, FLOUR, "on_hand_milli"), 2500);
    assert_eq!(milli_of(&c, FLOUR, "reserved_milli"), 250);
    assert_eq!(milli_of(&c, FLOUR, "version"), 7);
  }

  #[test]
  fn the_whole_snapshot_commits_or_none_of_it_does() {
    let mut c = conn();
    let before = count(&c, "stock_balances");

    // The last row is malformed. If validation did not happen before the writes,
    // the first two rows would already be committed.
    let error = apply_stock_balances(
      &mut c,
      &[
        balance(FLOUR, "2.500", "0.000", 1),
        balance(MILK, "1.000", "0.000", 1),
        balance("0199b1a0-0000-7000-8000-0000000000f3", "not-a-number", "0.000", 1),
      ],
    )
    .expect_err("a malformed quantity must abort the whole pull");

    assert_eq!(error.kind, crate::commands::CommandErrorKind::InvalidPayload);
    assert_eq!(
      count(&c, "stock_balances"),
      before,
      "a half-written snapshot is worse than none: a cashier would see two articles from the new pull beside the rest from an hour ago"
    );
  }

  /// Sync must be idempotent — a retried pull converges on the same table.
  #[test]
  fn pulling_the_same_balance_twice_updates_rather_than_duplicates() {
    let mut c = conn();
    let first = apply_stock_balances(&mut c, &[balance(FLOUR, "2.500", "0.000", 7)]).unwrap();
    let second = apply_stock_balances(&mut c, &[balance(FLOUR, "2.500", "0.000", 8)]).unwrap();

    assert_eq!(first.inserted, 1);
    assert_eq!(second.updated, 1);
    assert_eq!(count(&c, "stock_balances"), 1, "a re-pull must not double the stock");
    assert_eq!(milli_of(&c, FLOUR, "version"), 8);
  }

  /// A stale replay must not roll the terminal's stock backwards.
  #[test]
  fn an_older_snapshot_does_not_overwrite_a_newer_one() {
    let mut c = conn();
    apply_stock_balances(&mut c, &[balance(FLOUR, "2.500", "0.000", 8)]).unwrap();

    // A retried request from before, arriving out of order.
    let stale = apply_stock_balances(&mut c, &[balance(FLOUR, "9.000", "0.000", 7)]).unwrap();

    assert_eq!(stale, StockBalanceWriteResult { inserted: 0, updated: 0 });
    assert_eq!(milli_of(&c, FLOUR, "on_hand_milli"), 2500, "the newer snapshot must win");
  }

  #[test]
  fn an_oversold_balance_is_recorded_rather_than_refused() {
    let mut c = conn();
    apply_stock_balances(&mut c, &[balance(FLOUR, "-1.500", "0.000", 3)]).unwrap();

    assert_eq!(milli_of(&c, FLOUR, "on_hand_milli"), -1500);
  }

  #[test]
  fn a_negative_reservation_is_refused_with_the_field_named() {
    let mut c = conn();
    let error = apply_stock_balances(&mut c, &[balance(FLOUR, "2.500", "-1.000", 1)])
      .expect_err("a negative reservation is a bookkeeping error");

    assert_eq!(error.kind, crate::commands::CommandErrorKind::InvalidPayload);
    assert!(error.message.contains("balances[0].reserved"), "got: {}", error.message);
    assert_eq!(count(&c, "stock_balances"), 0);
  }

  /// The schema's own defence, proven against the real table.
  #[test]
  fn the_database_itself_refuses_a_real_in_a_quantity_column() {
    let c = conn();
    // Go around the parser entirely: this is the affinity trap the CHECK exists
    // for. `0.1 + 0.2` cannot reach here through `apply_stock_balances`, and
    // that is exactly why the CHECK is still worth having.
    let error = c.execute(
      "INSERT INTO stock_balances
         (id, inventory_item_id, branch_id, on_hand_milli, reserved_milli, version, updated_at, synced_at)
       VALUES ('x', ?1, ?2, 0.3, 0, 1, '2026-10-05T08:59:00Z', '2026-10-05T09:00:00Z')",
      rusqlite::params![FLOUR, BRANCH],
    );
    assert!(error.is_err(), "a REAL must never commit into a quantity column");
  }

  #[test]
  fn the_database_refuses_a_balance_re_attributed_to_another_article() {
    let mut c = conn();
    apply_stock_balances(&mut c, &[balance(FLOUR, "2.500", "0.000", 1)]).unwrap();

    let error = c.execute(
      "UPDATE stock_balances SET inventory_item_id = ?1 WHERE inventory_item_id = ?2",
      rusqlite::params![MILK, FLOUR],
    );
    assert!(
      error.is_err(),
      "moving a balance to another article would silently misreport what is on the shelf"
    );
  }

  // ── The read ──────────────────────────────────────────────────────────────

  #[test]
  fn a_cached_balance_reads_back_as_three_decimal_strings() {
    let mut c = conn();
    apply_stock_balances(&mut c, &[balance(FLOUR, "2.500", "0.250", 7)]).unwrap();

    let read = stock_balance_for(&c, BRANCH, FLOUR)
      .unwrap()
      .expect("the balance was just written");

    // STRINGS on the way out, like satang. A `2.5` here would reach a UI as a
    // double and the trailing zero the schema guarantees would be gone.
    assert_eq!(read.on_hand, "2.500");
    assert_eq!(read.reserved, "0.250");
    assert_eq!(read.available, "2.250");
  }

  #[test]
  fn an_unknown_article_is_absent_rather_than_reported_as_zero() {
    let c = conn();
    assert!(
      stock_balance_for(&c, BRANCH, FLOUR).unwrap().is_none(),
      "\"never pulled\" and \"nothing in stock\" are different facts, and conflating them refuses to sell an item the shop has"
    );
  }

  #[test]
  fn available_to_sell_can_be_negative() {
    let mut c = conn();
    // More is reserved than is on hand, so nothing is available. Reported as
    // negative rather than clamped to zero: clamping hides an oversell.
    apply_stock_balances(&mut c, &[balance(FLOUR, "1.000", "1.500", 2)]).unwrap();

    let read = stock_balance_for(&c, BRANCH, FLOUR).unwrap().unwrap();
    assert_eq!(read.available, "-0.500");
  }

  #[test]
  fn an_empty_pull_writes_nothing_and_says_so() {
    let mut c = conn();
    let result = apply_stock_balances(&mut c, &[]).unwrap();

    assert_eq!(result, StockBalanceWriteResult { inserted: 0, updated: 0 });
    assert_eq!(count(&c, "stock_balances"), 0);
  }
}