//! The Tauri command surface: the only place the frontend can touch the database.
//!
//! ── What lives here ──────────────────────────────────────────────────────────
//! Three commands, all thin, none clever:
//!
//!   * `save_offline_order` — the three-write checkout, in one transaction.
//!   * `list_recent_orders` — the history screen's projection query.
//!   * `apply_stock_balances` — one pulled stock snapshot into the local cache.
//!     Only the shim lives here: the quantity parse and the UPSERT belong to
//!     `stock_balances.rs`, which owns that table's rules, exactly as this module
//!     owns the checkout's.
//!
//! Per SKILL.md §2.3 this is an adapter. It holds NO business rules: it does not
//! compute tax, does not sum a total, does not decide an order's status. Every
//! number it writes was computed by the TypeScript domain and arrived already
//! decided. The single exception is documented at `parse_satang` and is a
//! *rejection* rule, not a calculation.
//!
//! ── Why satang crosses the bridge as a STRING ───────────────────────────────
//! `invoke` serialises through JSON, and a JSON number is a double in
//! JavaScript. `4550` survives that, and so would any realistic order total —
//! 2^53 satang is about 90 trillion baht. But "survives today" is not the same as
//! "cannot silently become wrong": the migration header
//! (`migrations/0001_init.sql:81-89`) documents SQLite's equivalent trap, where a
//! numeric-looking TEXT value is coerced to INTEGER by affinity and the evidence
//! is gone before the CHECK can see it. Sending money as a string makes that
//! failure mode unreachable at the bridge rather than merely unlikely, and
//! `parse_satang` turns anything that is not a canonical integer into a loud
//! rejection. The value reaches SQLite as an i64, never as text.
//!
//! ── Why the transaction is here and not in the caller ────────────────────────
//! SKILL.md §2.2: checkout writes the sale AND its outbox event in one
//! transaction, or it has not happened. A sale with no outbox event is a sale the
//! server will never learn about; an outbox event with no sale is a phantom. The
//! only place that guarantee can be enforced is the one place that owns the
//! connection.

use rusqlite::types::Value;
use rusqlite::{Connection, Statement};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::AppState;
use crate::recipes::{RecipeInput, RecipeWriteResult};
use crate::stock_balances::{StockBalanceInput, StockBalanceWriteResult};

/// A command failure, shaped for the wire.
///
/// `kind` is a stable machine-readable discriminator and `message` is for a human
/// reading a till log. They are separate because the frontend branches on the
/// first and shows the second, and a frontend that pattern-matches on prose is a
/// frontend that breaks when the prose is reworded.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub kind: CommandErrorKind,
    pub message: String,
    /// Stable error code for client handling (e.g. "stock_balance_not_found").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// Context‑specific details (field name, list of IDs, etc.).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<CommandErrorDetails>,
}

/// Why a command failed. `camelCase` on the wire so TypeScript discriminants read
/// naturally at the call site.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandErrorKind {
    /// A field arrived in a shape the money rules forbid.
    InvalidPayload,
    /// SQLite refused: a CHECK, a UNIQUE, a foreign key, or a locked file.
    Storage,
    /// The blocking worker could not be scheduled or its result lost.
    Worker,
}

/// Extended error information for client‑side display.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandErrorDetails {
    /// For "stock_requires_reconcile": list of inventory item IDs that are blocked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inventory_item_ids: Option<Vec<String>>,
    /// For validation errors: name of the field that failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

impl CommandError {
    /// `pub(crate)`: this module is an adapter like `commands` is, and it must be
    /// able to shape its own rejections the same way — a stock quantity that
    /// arrives malformed is the same class of failure as a satang field that does,
    /// and the frontend branches on `kind` for both.
    pub(crate) fn invalid(field: &str, why: &str) -> Self {
        CommandError {
            kind: CommandErrorKind::InvalidPayload,
            message: format!("{field}: {why}"),
            code: None,
            details: None,
        }
    }

    pub(crate) fn storage(what: &str, e: rusqlite::Error) -> Self {
        CommandError {
            kind: CommandErrorKind::Storage,
            message: format!("{what}: {e}"),
            code: None,
            details: None,
        }
    }

    fn worker(e: impl std::fmt::Display) -> Self {
        CommandError {
            kind: CommandErrorKind::Worker,
            message: format!("database worker did not finish: {e}"),
            code: None,
            details: None,
        }
    }

    /// Stock balance not found error with optional list of inventory item IDs.
    pub(crate) fn stock_balance_not_found(
        ids: Vec<String>,
        message: String,
    ) -> Self {
        CommandError {
            kind: CommandErrorKind::Storage,
            message,
            code: Some("stock_balance_not_found".to_string()),
            details: Some(CommandErrorDetails {
                inventory_item_ids: Some(ids),
                field: None,
            }),
        }
    }

    /// Stock requires reconciliation error for the given inventory items.
    pub(crate) fn stock_requires_reconcile(
        ids: Vec<String>,
        message: String,
    ) -> Self {
        CommandError {
            kind: CommandErrorKind::Storage,
            message,
            code: Some("stock_requires_reconcile".to_string()),
            details: Some(CommandErrorDetails {
                inventory_item_ids: Some(ids),
                field: None,
            }),
        }
    }


}

// ─────────────────────────────────────────────────────────────────────────────
// The wire shape
// ─────────────────────────────────────────────────────────────────────────────

/// One committed sale, as the frontend computed it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrderInput {
    pub id: String,
    pub branch_id: String,
    pub terminal_id: String,
    pub staff_user_id: String,
    /// `type` is a Rust keyword, so in Rust the field is `order_type`.
    ///
    /// On the wire its primary spelling is `orderType` — what
    /// `SaveOfflineOrderInputWire` (`tauriOfflineOrders.ts:78`) actually declares
    /// and what `SalesTerminalView` sends. This struct used to demand `type`
    /// (`rename = "type"`), and with `deny_unknown_fields` below that drift meant
    /// EVERY real checkout died at the bridge: the key sent was unknown, the key
    /// expected was absent. `type` stays as an accepted alias so either spelling
    /// deserialises and neither side's spelling can strand a sale.
    #[serde(alias = "type")]
    pub order_type: String,
    /// Absent means the schema's own default. Rust does not choose a rung: that is
    /// a domain decision, made in `sales/domain/checkout.ts`.
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub vat_rate_bp: Option<i64>,
    pub subtotal_satang: String,
    pub discount_satang: String,
    pub taxable_satang: String,
    pub tax_satang: String,
    pub service_charge_satang: String,
    pub rounding_adjustment_satang: String,
    pub total_satang: String,
    #[serde(default)]
    pub discount_type: Option<String>,
    #[serde(default)]
    pub loyalty_points_earned: Option<i64>,
    pub idempotency_key: String,
    pub local_receipt_number: String,
    pub created_at: String,
}

/// One line of a sale. Money as strings, for the same reason as the order's.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LineInput {
    pub id: String,
    pub variant_id: String,
    #[serde(default)]
    pub product_id: Option<String>,
    #[serde(default)]
    pub sku: Option<String>,
    pub name_th: String,
    #[serde(default)]
    pub name_en: Option<String>,
    /// Not money, but `typeof(quantity) = 'integer'` is CHECKed on the column for
    /// the same affinity reason, so it crosses as a string too.
    pub quantity: String,
    pub unit_price_satang: String,
    pub line_discount_satang: String,
    pub line_tax_satang: String,
    pub line_total_satang: String,
    pub created_at: String,
}

/// The one outbox event checkout must queue in the same transaction.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutboxInput {
    pub id: String,
    #[serde(default)]
    pub aggregate_type: Option<String>,
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub action: Option<String>,
    /// The event body, as JSON text. The column's CHECK rejects anything that is
    /// not a JSON object, so a truncated or array-shaped payload fails at INSERT.
    pub payload: String,
    pub idempotency_key: String,
    /// When the drain may first claim this row.
    ///
    /// The frontend does not choose it: a fresh outbox row is due the moment it
    /// exists, so a missing value defaults to NOW via the crate's single clock
    /// read (`sync_outbox::now_iso`) — the same clock `drain_tick` compares
    /// against, in the one timestamp format the schema stores.
    ///
    /// The default is load-bearing, not a convenience: `SaveOfflineOrderInputWire`
    /// (`tauriOfflineOrders.ts:121-129`) has no `nextAttemptAt` field at all, and
    /// without this default every real checkout failed here while every test that
    /// builds `OutboxInput` by hand kept passing.
    #[serde(default = "default_next_attempt_at")]
    pub next_attempt_at: String,
    pub created_at: String,
}

/// `OutboxInput::next_attempt_at` when the wire omits it: immediately due, in
/// `YYYY-MM-DDTHH:MM:SSZ`.
fn default_next_attempt_at() -> String {
    crate::sync_outbox::now_iso()
}

/// The whole checkout.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveOfflineOrderInput {
    pub order: OrderInput,
    pub lines: Vec<LineInput>,
    pub outbox: OutboxInput,
}

/// What checkout reports back.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOfflineOrderOutput {
    pub order_id: String,
    pub local_receipt_number: String,
    pub line_count: usize,
}

/// One row of the history screen's projection.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderSummary {
    pub id: String,
    pub local_receipt_number: String,
    pub status: String,
    pub sync_state: String,
    pub created_at: String,
    pub line_count: i64,
    /// A string, for the reason at the module header. The TypeScript adapter wraps
    /// it in `Money` at the edge.
    pub total_satang: String,
    /// `local_orders.rounding_adjustment_satang` — SIGNED, unlike everything else
    /// in this struct. Cash rounding moves the payable in both directions
    /// (4547 → 4550 is +3; 4552 → 4550 is −3), so this is the one field where the
    /// sign carries the meaning. Serialized as a string for the same precision
    /// reason as `total_satang`, minus sign included.
    pub rounding_adjustment_satang: String,
    pub currency_code: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// The edge: string → i64
// ─────────────────────────────────────────────────────────────────────────────

/// Parse one satang field, or reject it.
///
/// The grammar is `^(0|[1-9][0-9]*)$` and nothing else. That rejects, in order of
/// how badly each one has bitten this codebase before:
///
///   * `"4550 "` / `" 4550"` — whitespace a formatter added.
///   * `"+4550"` / `"-4550"` — a sign. On a *price*, total, subtotal or tax, a
///     negative is never legitimate: a refund is a separate row with its own event
///     type. `rounding_adjustment_satang` is the single signed exception and has
///     its own parser, [`parse_signed_satang`].
///   * `"4550.0"` — a float that happened to be whole. `Money.fromNumber` throws
///     on it in TypeScript, and the same value must not be laundered through a
///     string to get past that.
///   * `"4.55e3"` / `"0x11A"` — anything that is not base-ten digits.
///   * `"04550"` — a leading zero. It parses, and it is exactly the shape a
///     zero-padded formatter produces, so it is a bug worth reporting rather
///     than absorbing.
///   * anything above `i64::MAX` — would silently wrap if cast.
fn parse_satang(field: &str, raw: &str) -> Result<i64, CommandError> {
    parse_satang_with(field, raw, false)
}

/// Parse the ONE signed money field, `rounding_adjustment_satang`.
///
/// Cash rounding moves the amount charged to the nearest value the drawer can
/// actually pay, and that value sits on either side of the exact total: ฿45.53
/// goes up to ฿45.55 or down to ฿45.50, and both are ordinary. The grammar is
/// therefore `^-?(0|[1-9][0-9]*)$` — identical to [`parse_satang`] except that a
/// single leading `-` is allowed.
///
/// This exists because the gap was silent rather than loud.
/// `cashRounding::round_to_nearest_coin(4553, 25)` returns 4550, so the adjustment
/// is `-3`; parsed with the unsigned grammar that `"-3"` was refused, and a ฿45.53
/// cash sale could not be saved at all. Nothing warned — the feature simply did
/// not work for the totals it was written for.
///
/// Everything else is still refused, and for the same reasons as the unsigned path:
///
///   * `"+3"` — an explicit plus. Only `-` is canonical, so `+3` and `3` would be
///     two spellings of one value.
///   * `"-0"` and `"-03"` — a sign followed by a non-canonical digit run. `-0` is a
///     second spelling of zero for the same reason `"00"` is.
///   * `"-"` and `"--3"` — a sign with no usable magnitude.
///   * whitespace, decimal points and exponents, exactly as unsigned.
///
/// **Scope limit.** This parser makes a negative adjustment *representable* at
/// the bridge. It does not make it *correct*: whether a given negative is
/// economically sensible is not a question a string parser can answer, and the
/// bounds live in SQL (`CHECK (total_satang >= 0)` in
/// `0002_signed_rounding.sql`) rather than here. This function's only job is to
/// refuse the spellings that are not integers.
fn parse_signed_satang(field: &str, raw: &str) -> Result<i64, CommandError> {
    parse_satang_with(field, raw, true)
}

/// The one implementation of the satang digit grammar.
///
/// `signed` admits a single leading `-`. One function rather than two near-copies
/// because a grammar that exists twice is a grammar that eventually disagrees with
/// itself, and a disagreement here is a money field one caller accepts and another
/// refuses — the exact cross-language drift `migrations.test.ts` guards against on
/// the SQL side.
fn parse_satang_with(field: &str, raw: &str, signed: bool) -> Result<i64, CommandError> {
    let (negative, digits) = match raw.strip_prefix('-') {
        Some(rest) if signed => (true, rest),
        _ => (false, raw),
    };

    if digits.is_empty() {
        let detail = if negative {
            "is a bare '-'; satang must be a decimal integer with a magnitude"
        } else {
            "is empty; satang must be a decimal integer"
        };
        return Err(CommandError::invalid(field, detail));
    }
    if !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(CommandError::invalid(
            field,
            &format!(
                "must be plain base-ten digits, got {raw:?}; a decimal point, an exponent or \
         surrounding whitespace is rejected so no value can reach SQLite as text"
            ),
        ));
    }
    if digits.len() > 1 && digits.starts_with('0') {
        return Err(CommandError::invalid(
            field,
            &format!("has a leading zero ({raw:?}); send the canonical integer form"),
        ));
    }
    // `-0` parses to zero and is a second spelling of it, so it is refused for the
    // same reason `"00"` is above.
    if negative && digits == "0" {
        return Err(CommandError::invalid(
            field,
            &format!("is {raw:?}; negative zero is a second spelling of zero, send \"0\""),
        ));
    }

    // The whole string is parsed rather than the magnitude plus a manual negation.
    // `i64::MIN` is the reason: its magnitude is 9223372036854775808, which is one
    // larger than `i64::MAX`, so a positive i64 cannot hold it and negating after
    // the fact would report `i64::MIN` as an overflow. Parsing the sign together
    // with the digits gets that boundary right for free.
    //
    // Safe to hand `raw` rather than `digits`: by this point the grammar above has
    // established that it is either all digits or a single `-` followed by digits,
    // so there is no `+`, sign or whitespace left for the parser to reinterpret.
    raw.parse::<i64>().map_err(|_| {
        CommandError::invalid(
            field,
            &format!("{raw:?} does not fit in a signed 64-bit integer"),
        )
    })
}

/// The four parameter shapes this module ever binds.
///
/// `Value` rather than `&dyn ToSql` because it names the SQLite storage class at
/// the call site — which is the point: it makes visible that a money parameter is
/// `Integer` and can never be bound as `Text`.
fn text(s: String) -> Value {
    Value::Text(s)
}

/// `NULL` for an absent optional column. Explicit rather than an `Option<T>`
/// generic, so binding NULL to a `NOT NULL` column is a compile-time mismatch
/// instead of a runtime constraint failure.
fn opt_text(s: Option<String>) -> Value {
    match s {
        Some(v) => Value::Text(v),
        None => Value::Null,
    }
}

fn int(i: i64) -> Value {
    Value::Integer(i)
}

fn opt_int(i: Option<i64>) -> Value {
    match i {
        Some(v) => Value::Integer(v),
        None => Value::Null,
    }
}

/// Bind `values` to `?1 … ?N` on a prepared statement.
///
/// Done by index rather than by handing rusqlite a parameter list: `Params` is
/// implemented for fixed-size arrays and for `&[&dyn ToSql]`, so an arity that
/// varies by table (21 columns here, 13 on a line, 9 on an outbox event) cannot
/// be expressed as one list without a self-referential borrow. `raw_bind_`
/// sidesteps the trait entirely, and it makes the binding order — the thing that
/// silently shifts a column when someone adds one — visible in the loop.
fn bind_all(stmt: &mut Statement<'_>, values: &[Value]) -> rusqlite::Result<()> {
    for (offset, value) in values.iter().enumerate() {
        stmt.raw_bind_parameter(offset + 1, value)?;
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// The three-write checkout
// ─────────────────────────────────────────────────────────────────────────────

/// Commit a sale, its lines, and its outbox event in ONE transaction.
///
/// Returns the order id on success. On any failure, NOTHING is written — which is
/// the entire point, and is what `rollback_leaves_nothing_behind` in the tests
/// below pins with a deliberately broken line.
///
/// No arithmetic happens here. Every money value is validated for *shape* and
/// inserted; whether the set of them satisfies the schema's identities is
/// SQLite's CHECK to decide, and whether they are *right* is the domain's.
fn write_order(
    conn: &mut Connection,
    input: &SaveOfflineOrderInput,
) -> Result<SaveOfflineOrderOutput, CommandError> {
    let o = &input.order;

    // ── Shape validation, before any statement runs ────────────────────────────
    let subtotal = parse_satang("order.subtotalSatang", &o.subtotal_satang)?;
    let discount = parse_satang("order.discountSatang", &o.discount_satang)?;
    let taxable = parse_satang("order.taxableSatang", &o.taxable_satang)?;
    let tax = parse_satang("order.taxSatang", &o.tax_satang)?;
    let service = parse_satang("order.serviceChargeSatang", &o.service_charge_satang)?;
    // The ONLY signed money field. ฿45.53 rounding down to ฿45.50 is -3 satang, and
    // `round_to_nearest_coin` produces exactly that, so parsing this with the
    // unsigned grammar made a ฿45.53 cash sale unsavable. Every other money field
    // above stays unsigned: a negative price, total or tax is a lost sign.
    let rounding = parse_signed_satang(
        "order.roundingAdjustmentSatang",
        &o.rounding_adjustment_satang,
    )?;
    let total = parse_satang("order.totalSatang", &o.total_satang)?;

    if input.lines.is_empty() {
        return Err(CommandError::invalid(
            "lines",
            "is empty; an order with no lines cannot be reconciled against a receipt",
        ));
    }

    let mut lines = Vec::with_capacity(input.lines.len());
    for (index, l) in input.lines.iter().enumerate() {
        let quantity = parse_satang(&format!("lines[{index}].quantity"), &l.quantity)?;
        if quantity <= 0 {
            return Err(CommandError::invalid(
                &format!("lines[{index}].quantity"),
                "must be greater than zero; a zero-quantity line is a mistake, not a void",
            ));
        }
        lines.push(ValidatedLine {
            id: l.id.clone(),
            variant_id: l.variant_id.clone(),
            product_id: l.product_id.clone(),
            sku: l.sku.clone(),
            name_th: l.name_th.clone(),
            name_en: l.name_en.clone(),
            quantity,
            unit_price_satang: parse_satang(
                &format!("lines[{index}].unitPriceSatang"),
                &l.unit_price_satang,
            )?,
            line_discount_satang: parse_satang(
                &format!("lines[{index}].lineDiscountSatang"),
                &l.line_discount_satang,
            )?,
            line_tax_satang: parse_satang(
                &format!("lines[{index}].lineTaxSatang"),
                &l.line_tax_satang,
            )?,
            line_total_satang: parse_satang(
                &format!("lines[{index}].lineTotalSatang"),
                &l.line_total_satang,
            )?,
            created_at: l.created_at.clone(),
        });
    }

    let payload = input.outbox.payload.clone();

    // ── The transaction ────────────────────────────────────────────────────────
    // `transaction()` opens BEGIN DEFERRED and rolls back when the guard is
    // dropped without a commit, so every `?` above and every error below leaves
    // the database exactly as it was found.
    let tx = conn
        .transaction()
        .map_err(|e| CommandError::storage("begin transaction", e))?;

    // rusqlite's `Params` is implemented for a SLICE of `ToSql`, not for a `Vec`
    // of either `Value` or trait objects, so the parameter list is bound to a
    // local and passed by slice.
    let order_params: Vec<Value> = vec![
        text(o.id.clone()),
        text(o.branch_id.clone()),
        text(o.terminal_id.clone()),
        text(o.staff_user_id.clone()),
        text(o.order_type.clone()),
        opt_text(o.status.clone()),
        opt_text(o.source.clone()),
        opt_text(o.currency.clone()),
        opt_int(o.vat_rate_bp),
        int(subtotal),
        int(discount),
        int(taxable),
        int(tax),
        int(service),
        int(rounding),
        int(total),
        opt_text(o.discount_type.clone()),
        opt_int(o.loyalty_points_earned),
        text(o.idempotency_key.clone()),
        text(o.local_receipt_number.clone()),
        text(o.created_at.clone()),
    ];

    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO local_orders (
           id, branch_id, terminal_id, staff_user_id, type, status, source, currency,
           vat_rate_bp, subtotal_satang, discount_satang, taxable_satang, tax_satang,
           service_charge_satang, rounding_adjustment_satang, total_satang, discount_type,
           loyalty_points_earned, idempotency_key, local_receipt_number, sync_state,
           created_at, updated_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5,
           COALESCE(?6, 'draft'), COALESCE(?7, 'pos_desktop'), COALESCE(?8, 'THB'),
           COALESCE(?9, 700), ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
           COALESCE(?18, 0), ?19, ?20, 'pending', ?21, NULL
         )",
            )
            .map_err(|e| CommandError::storage("prepare local_orders insert", e))?;

        bind_all(&mut stmt, &order_params)
            .map_err(|e| CommandError::storage("bind local_orders", e))?;
        stmt.raw_execute()
            .map_err(|e| CommandError::storage("insert local_orders", e))?;
    }

    {
        let mut insert = tx
            .prepare(
                "INSERT INTO local_order_lines (
           id, order_id, variant_id, product_id, sku, name_th, name_en, quantity,
           unit_price_satang, line_discount_satang, line_tax_satang, line_total_satang,
           created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            )
            .map_err(|e| CommandError::storage("prepare line insert", e))?;

        for l in &lines {
            let line_params: Vec<Value> = vec![
                text(l.id.clone()),
                text(o.id.clone()),
                text(l.variant_id.clone()),
                opt_text(l.product_id.clone()),
                opt_text(l.sku.clone()),
                text(l.name_th.clone()),
                opt_text(l.name_en.clone()),
                int(l.quantity),
                int(l.unit_price_satang),
                int(l.line_discount_satang),
                int(l.line_tax_satang),
                int(l.line_total_satang),
                text(l.created_at.clone()),
            ];
            bind_all(&mut insert, &line_params)
                .map_err(|e| CommandError::storage("bind local_order_lines", e))?;
            insert
                .raw_execute()
                .map_err(|e| CommandError::storage("insert local_order_lines", e))?;
        }
    }

    let ob = &input.outbox;
    let outbox_params: Vec<Value> = vec![
        text(ob.id.clone()),
        text(
            ob.aggregate_type
                .clone()
                .unwrap_or_else(|| "order".to_owned()),
        ),
        text(o.id.clone()),
        text(
            ob.event_type
                .clone()
                .unwrap_or_else(|| "order_committed".to_owned()),
        ),
        text(ob.action.clone().unwrap_or_else(|| "push_order".to_owned())),
        text(payload),
        text(ob.idempotency_key.clone()),
        text(ob.next_attempt_at.clone()),
        text(ob.created_at.clone()),
    ];

    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO sync_outbox (
           id, aggregate_type, aggregate_id, event_type, action, payload,
           idempotency_key, status, attempt_count, next_attempt_at, last_error,
           created_at, processed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', 0, ?8, NULL, ?9, NULL)",
            )
            .map_err(|e| CommandError::storage("prepare sync_outbox insert", e))?;

        bind_all(&mut stmt, &outbox_params)
            .map_err(|e| CommandError::storage("bind sync_outbox", e))?;
        stmt.raw_execute()
            .map_err(|e| CommandError::storage("insert sync_outbox", e))?;
    }

    tx.commit()
        .map_err(|e| CommandError::storage("commit checkout", e))?;

    Ok(SaveOfflineOrderOutput {
        order_id: o.id.clone(),
        local_receipt_number: o.local_receipt_number.clone(),
        line_count: lines.len(),
    })
}

/// A line whose money and quantity are known-good integers.
struct ValidatedLine {
    id: String,
    variant_id: String,
    product_id: Option<String>,
    sku: Option<String>,
    name_th: String,
    name_en: Option<String>,
    quantity: i64,
    unit_price_satang: i64,
    line_discount_satang: i64,
    line_tax_satang: i64,
    line_total_satang: i64,
    created_at: String,
}

/// The history projection. Mirrors `OfflineOrderSummary` in TypeScript.
fn query_recent(conn: &Connection, limit: i64) -> Result<Vec<OrderSummary>, CommandError> {
    if limit <= 0 {
        return Err(CommandError::invalid(
            "limit",
            "must be a positive integer; returning an empty list would look like a till with no sales",
        ));
    }

    // ORDER BY created_at DESC, id DESC — the same tie-break the TypeScript port
    // documents at offlineOrders.ts:252-267. A correlated COUNT rather than a
    // JOIN, so a 50-row page is 50 index seeks and not a 50-row aggregate over
    // every line in the shift.
    let mut stmt = conn
        .prepare(
            "SELECT o.id, o.local_receipt_number, o.status, o.sync_state, o.created_at,
              o.total_satang, o.rounding_adjustment_satang, o.currency,
              (SELECT COUNT(*) FROM local_order_lines l WHERE l.order_id = o.id) AS line_count
       FROM local_orders o
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT ?1",
        )
        .map_err(|e| CommandError::storage("prepare history query", e))?;

    let rows = stmt
        .query_map([limit], |row| {
            Ok(OrderSummary {
                id: row.get(0)?,
                local_receipt_number: row.get(1)?,
                status: row.get(2)?,
                sync_state: row.get(3)?,
                created_at: row.get(4)?,
                total_satang: row.get::<_, i64>(5)?.to_string(),
                // i64 and NOT u64: this column carries a minus sign, and reading it as
                // an unsigned type would either error or silently flip −3 into a huge
                // positive number. `to_string()` is what preserves the sign on the wire.
                rounding_adjustment_satang: row.get::<_, i64>(6)?.to_string(),
                currency_code: row.get(7)?,
                line_count: row.get(8)?,
            })
        })
        .map_err(|e| CommandError::storage("read history", e))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| CommandError::storage("read history row", e))
}

// ─────────────────────────────────────────────────────────────────────────────
// The Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

/// Run blocking database work off the async runtime.
///
/// `rusqlite` is synchronous. Calling it directly from an `async` command would
/// block the runtime's worker thread, and on a single-threaded executor that is
/// the UI thread — which is how a 20 ms `synchronous = FULL` fsync becomes a
/// visible stutter on a till being used at speed.
async fn blocking<T, F>(app: AppHandle, work: F) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce(&mut Connection) -> Result<T, CommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // The Mutex is held for the length of one statement group, which is what
        // SQLite requires anyway: one writer at a time. `lock()` recovers from
        // poisoning rather than panicking, because a poisoned lock here means some
        // earlier command panicked mid-transaction — and the rollback that unwound
        // it still left the database in the correct state.
        let mut conn = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        work(&mut conn)
    })
    .await
    .map_err(CommandError::worker)?
}

/// Commit a completed checkout. See `write_order`.
#[tauri::command]
pub async fn save_offline_order(
    app: AppHandle,
    input: SaveOfflineOrderInput,
) -> Result<SaveOfflineOrderOutput, CommandError> {
    blocking(app, move |conn| write_order(conn, &input)).await
}

/// Read the most recent orders, newest first.
#[tauri::command]
pub async fn list_recent_orders(
    app: AppHandle,
    limit: i64,
) -> Result<Vec<OrderSummary>, CommandError> {
    blocking(app, move |conn| query_recent(conn, limit)).await
}

/// Store one pulled stock snapshot in the local `stock_balances` cache.
///
/// A shim and nothing more, deliberately. Every quantity string is parsed, every
/// row is probed for insert-vs-update, and the whole batch is written in ONE
/// transaction by [`crate::stock_balances::apply_stock_balances`] — code that
/// has its own tests and its own header explaining why the quantities cross as
/// strings. Duplicating any of that here would put the rule in two places, and
/// the two copies would drift.
///
/// The one thing this layer decides is threading the managed connection through
/// `blocking`, because `rusqlite` is synchronous and a snapshot of a few hundred
/// balances held on the async runtime is a visible stall on a till.
#[tauri::command]
pub async fn apply_stock_balances(
    app: AppHandle,
    balances: Vec<StockBalanceInput>,
) -> Result<StockBalanceWriteResult, CommandError> {
    blocking(app, move |conn| {
        crate::stock_balances::apply_stock_balances(conn, &balances)
    })
    .await
}

/// Store one pulled recipe snapshot in the local recipe cache.
#[tauri::command]
pub async fn apply_recipes(
    app: AppHandle,
    recipes: Vec<RecipeInput>,
) -> Result<RecipeWriteResult, CommandError> {
    blocking(app, move |conn| {
        crate::recipes::apply_recipes(conn, &recipes)
    })
    .await
}

// ─────────────────────────────────────────────────────────────────────────────
// Offline refund: request_order_void
// ─────────────────────────────────────────────────────────────────────────────

/// Wire input for an offline void request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoidRequestInput {
    pub order_id: String,
    /// Raw receipt token string, transferred verbatim across the bridge.
    pub receipt_token: String,
    pub idempotency_key: String,
    #[serde(default = "default_next_attempt_at")]
    pub next_attempt_at: String,
    #[serde(default = "default_now_iso")]
    pub created_at: String,
}

fn default_now_iso() -> String {
    crate::sync_outbox::now_iso()
}

/// Wire output for an offline void request.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoidRequestOutput {
    pub order_id: String,
    pub outbox_id: String,
}

/// One reversal line for the void payload.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoidLine {
    variant_id: String,
    quantity: i64,
}

/// Commit a void request: update order status and queue a reversal outbox event.
fn write_void_request(
    conn: &mut Connection,
    input: &VoidRequestInput,
) -> Result<VoidRequestOutput, CommandError> {
    if input.order_id.is_empty() {
        return Err(CommandError::invalid("order_id", "must not be empty"));
    }
    if input.receipt_token.is_empty() {
        return Err(CommandError::invalid("receipt_token", "must not be empty"));
    }
    if input.idempotency_key.is_empty() {
        return Err(CommandError::invalid("idempotency_key", "must not be empty"));
    }

    let outbox_id = format!("void:{}", input.idempotency_key);

    let tx = conn
        .transaction()
        .map_err(|e| CommandError::storage("begin transaction", e))?;

    // Load current status to prevent double void.
    let current_status: String = tx
        .query_row(
            "SELECT status FROM local_orders WHERE id = ?1",
            [input.order_id.as_str()],
            |row| row.get(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => CommandError::invalid(
                "order_id",
                "no such order; a void request must reference a committed sale",
            ),
            other => CommandError::storage("read order status", other),
        })?;

    if current_status == "void_requested" || current_status == "voided" {
        return Err(CommandError::invalid(
            "order_id",
            "order is already void_requested or voided; a second void request is not allowed",
        ));
    }

    // Fetch reversal lines for the payload.
    let mut stmt = tx
        .prepare(
            "SELECT variant_id, quantity FROM local_order_lines WHERE order_id = ?1 ORDER BY id",
        )
        .map_err(|e| CommandError::storage("prepare line query", e))?;

    let lines: Vec<VoidLine> = stmt
        .query_map([input.order_id.as_str()], |row| {
            Ok(VoidLine {
                variant_id: row.get(0)?,
                quantity: row.get(1)?,
            })
        })
        .map_err(|e| CommandError::storage("read lines", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| CommandError::storage("read line row", e))?;

    drop(stmt);

    // Update order status to void_requested.
    tx.execute(
        "UPDATE local_orders SET status = 'void_requested', updated_at = ?1 WHERE id = ?2",
        [input.created_at.as_str(), input.order_id.as_str()],
    )
    .map_err(|e| CommandError::storage("update order status", e))?;

    // Build payload: raw receipt token + reversal lines.
    let payload = serde_json::json!({
        "order_id": input.order_id,
        "local_receipt_number": input.order_id,
        "receipt_token": input.receipt_token,
        "lines": lines,
    })
    .to_string();

    tx.execute(
        "INSERT INTO sync_outbox (
            id, aggregate_type, aggregate_id, event_type, action, payload,
            idempotency_key, status, attempt_count, next_attempt_at, last_error,
            created_at, processed_at
        ) VALUES (?1, 'void_request', ?2, 'void_approved', 'push_order', ?3,
                  ?4, 'pending', 0, ?5, NULL, ?6, NULL)",
        [
            outbox_id.as_str(),
            input.order_id.as_str(),
            payload.as_str(),
            input.idempotency_key.as_str(),
            input.next_attempt_at.as_str(),
            input.created_at.as_str(),
        ],
    )
    .map_err(|e| CommandError::storage("insert outbox", e))?;

    tx.commit()
        .map_err(|e| CommandError::storage("commit void request", e))?;

    Ok(VoidRequestOutput {
        order_id: input.order_id.clone(),
        outbox_id,
    })
}

/// Request an offline refund: mark the order void_requested and queue a
/// reversal outbox event for cloud sync.
#[tauri::command]
pub async fn request_order_void(
    app: AppHandle,
    input: VoidRequestInput,
) -> Result<VoidRequestOutput, CommandError> {
    blocking(app, move |conn| write_void_request(conn, &input)).await
}

// ─────────────────────────────────────────────────────────────────────────────
// Terminal identity
// ─────────────────────────────────────────────────────────────────────────────

/// Who this terminal is, as its environment declares it.
///
/// `camelCase` on the wire for the same reason as every other command's
/// payload (`SaveOfflineOrderOutput`, `CommandError`): the frontend reads
/// `terminalId` / `branchId`, not snake_case.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalIdentity {
    pub terminal_id: String,
    pub branch_id: String,
}

/// The two variables this command reads. Neither has a default: a silent
/// fallback would attribute a sale to a till or a branch nobody chose, and the
/// server's `terminal_id` is client-asserted precisely because this crate is
/// the only thing that ever states it.
const TERMINAL_ID_ENV: &str = "WAL_ASRI_TERMINAL_ID";
const BRANCH_ID_ENV: &str = "WAL_ASRI_BRANCH_ID";

/// Which till, which branch — asked of the environment, not of the database.
///
/// Unlike the commands above, this one is synchronous: there is nothing to hand
/// to `blocking`, because it reads no SQLite and takes no lock.
///
/// `WAL_ASRI_BRANCH_ID` is a NEW variable, and it exists because the checkout
/// screen currently hard-codes `branch-siam` — a value the Go ingester refuses
/// (`invalid_branch_id`, permanent). Once the UI calls this command, both ids
/// come from one validated place instead of two literals in a React file.
///
/// Failure is loud and named: an unset or malformed variable is an error
/// carrying the VARIABLE's name, never a quiet empty string or placeholder.
#[tauri::command]
pub fn get_terminal_identity() -> Result<TerminalIdentity, CommandError> {
    identity_from_env(
        std::env::var(TERMINAL_ID_ENV).ok().as_deref(),
        std::env::var(BRANCH_ID_ENV).ok().as_deref(),
    )
}

#[tauri::command]
pub async fn sync_stock_balances(
    _app: AppHandle,
    _balances: Vec<crate::stock_balances::StockBalanceInput>,
) -> Result<crate::stock_balances::StockBalanceWriteResult, CommandError> {
    // To be implemented in Phase 1.2
    // For now, a placeholder that returns an error to indicate not yet implemented.
    Err(CommandError::invalid(
        "sync_stock_balances",
        "command not yet implemented",
    ))
}

#[tauri::command]
pub async fn list_stock_conflicts(
    _app: AppHandle,
    _branch_id: String,
) -> Result<Vec<crate::stock_balances::StockBalanceRecord>, CommandError> {
    // To be implemented in Phase 1.2
    Err(CommandError::invalid(
        "list_stock_conflicts",
        "command not yet implemented",
    ))
}

#[tauri::command]
pub async fn resolve_stock_conflict(
    _app: AppHandle,
    _args: crate::stock_balances::ResolveStockConflictArgs,
) -> Result<crate::stock_balances::ResolveStockConflictResult, CommandError> {
    // To be implemented in Phase 1.2
    Err(CommandError::invalid(
        "resolve_stock_conflict",
        "command not yet implemented",
    ))
}

/// The environment values, validated.
///
/// Split from the command so tests pass values as arguments: `std::env::set_var`
/// is `unsafe` in edition 2024, and mutating the process environment from a
/// test suite that runs in parallel is a race nobody needs to debug.
/// Delegates to `crate::terminal_identity::load_and_validate_from_values` for
/// shared validation logic (single source of truth for UUIDv7 rules).
fn identity_from_env(
    terminal_id: Option<&str>,
    branch_id: Option<&str>,
) -> Result<TerminalIdentity, CommandError> {
    let validated = crate::terminal_identity::load_and_validate_from_values(terminal_id, branch_id)
        .map_err(|e| match e {
            crate::terminal_identity::IdentityError::Missing { var } => CommandError::invalid(
                var,
                "is not set; this command never invents an identity — launch the terminal with it configured",
            ),
            crate::terminal_identity::IdentityError::InvalidFormat { var, value } => CommandError::invalid(
                var,
                &format!("must be a UUIDv7 like 0192f6c4-7c1e-7a3f-9b2d-4e6f8a1b2c3d; got {value:?}"),
            ),
        })?;

    Ok(TerminalIdentity {
        terminal_id: validated.terminal_id,
        branch_id: validated.branch_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrate::migrate;
    use crate::sync_outbox::claim_ready;

    fn conn() -> Connection {
        let mut c = Connection::open_in_memory().expect("open in-memory database");
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&mut c).expect("migrate");
        c
    }

    /// A checkout that satisfies every CHECK in the schema.
    fn good_input() -> SaveOfflineOrderInput {
        SaveOfflineOrderInput {
            order: OrderInput {
                id: "018f3c2a-0000-7000-8000-000000000001".into(),
                branch_id: "branch-1".into(),
                terminal_id: "terminal-1".into(),
                staff_user_id: "staff-1".into(),
                order_type: "takeaway".into(),
                status: Some("submitted".into()),
                source: None,
                currency: None,
                vat_rate_bp: Some(700),
                // VAT-INCLUSIVE (docs/02-design/DOMAIN.md §"Money and tax rules").
                // ฿45.50 is what the customer pays; the tax sits inside it.
                //   net = round_half_up(4550 * 10000 / 10700) = round_half_up(4252.336) = 4252
                //   tax = 4550 - 4252 = 298   (฿2.98 — NOT the ฿3.19 forward VAT would give)
                //   total = 4550, the subtotal itself; the tax is already inside it
                subtotal_satang: "4550".into(),
                discount_satang: "0".into(),
                taxable_satang: "4252".into(),
                tax_satang: "298".into(),
                service_charge_satang: "0".into(),
                rounding_adjustment_satang: "0".into(),
                total_satang: "4550".into(),
                discount_type: None,
                loyalty_points_earned: None,
                idempotency_key: "idem-1".into(),
                local_receipt_number: "R-0001".into(),
                created_at: "2026-10-03T09:00:00.000Z".into(),
            },
            lines: vec![LineInput {
                id: "line-1".into(),
                variant_id: "variant-1".into(),
                product_id: Some("product-1".into()),
                sku: Some("BEV-LATTE".into()),
                name_th: "ลาเต้".into(),
                name_en: Some("Latte".into()),
                quantity: "1".into(),
                unit_price_satang: "4550".into(),
                line_discount_satang: "0".into(),
                // VAT is posted once per order, so a line carries none. The schema
                // enforces `line_tax_satang = 0` and rejects this row otherwise — which
                // is the point of that CHECK.
                line_tax_satang: "0".into(),
                line_total_satang: "4550".into(),
                created_at: "2026-10-03T09:00:00.000Z".into(),
            }],
            outbox: OutboxInput {
                id: "outbox-1".into(),
                aggregate_type: None,
                event_type: None,
                action: None,
                payload: r#"{"order_id":"018f3c2a-0000-7000-8000-000000000001"}"#.into(),
                idempotency_key: "idem-outbox-1".into(),
                next_attempt_at: "2026-10-03T09:00:00.000Z".into(),
                created_at: "2026-10-03T09:00:00.000Z".into(),
            },
        }
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap_or_else(|e| panic!("count {table}: {e}"))
    }

    // ── THE BRIDGE: the JSON the checkout screen actually sends ────────────────
    //
    // Every other test here builds `SaveOfflineOrderInput` BY HAND — which is
    // exactly how two wire drifts survived the whole suite while breaking every
    // real checkout: the screen sends `orderType` where serde demanded `type`,
    // and it sends no `nextAttemptAt` at all. Hand-built structs cannot catch a
    // spelling mismatch they never spell. These tests push the REAL wire shape
    // through real `serde` and into a real transaction instead.

    /// Byte-for-byte the object `SalesTerminalView` + `toWireInput` produce:
    /// `orderType` as the type key, an outbox with NO `nextAttemptAt`, satang as
    /// strings, `null` for the optional outbox trio. Source of truth:
    /// `tauriOfflineOrders.ts:72-130` (wire type) and `SalesTerminalView.tsx:424-509`.
    const UI_CHECKOUT_JSON: &str = r#"{
    "order": {
      "id": "018f3c2a-0000-7000-8000-000000000001",
      "branchId": "branch-siam",
      "terminalId": "terminal-01",
      "staffUserId": "staff-01",
      "orderType": "takeaway",
      "status": "submitted",
      "source": "pos_desktop",
      "currency": null,
      "vatRateBp": 700,
      "subtotalSatang": "4550",
      "discountSatang": "0",
      "taxableSatang": "4252",
      "taxSatang": "298",
      "serviceChargeSatang": "0",
      "roundingAdjustmentSatang": "0",
      "totalSatang": "4550",
      "idempotencyKey": "idem-018f3c2a-0000-7000-8000-000000000001",
      "localReceiptNumber": "R-1",
      "createdAt": "2026-10-03T09:00:00.000Z"
    },
    "lines": [{
      "id": "line-1",
      "variantId": "variant-1",
      "productId": null,
      "sku": "BEV-LATTE",
      "nameTh": "กาแฟลาเต้",
      "nameEn": null,
      "quantity": "1",
      "unitPriceSatang": "4550",
      "lineDiscountSatang": "0",
      "lineTaxSatang": "0",
      "lineTotalSatang": "4550",
      "createdAt": "2026-10-03T09:00:00.000Z"
    }],
    "outbox": {
      "id": "outbox-1",
      "aggregateType": null,
      "eventType": null,
      "action": null,
      "payload": "{\"order_id\":\"018f3c2a-0000-7000-8000-000000000001\"}",
      "idempotencyKey": "idem-outbox-1",
      "createdAt": "2026-10-03T09:00:00.000Z"
    }
  }"#;

    #[test]
    fn the_json_the_screen_actually_saves_deserialises_and_commits() {
        let input: SaveOfflineOrderInput = serde_json::from_str(UI_CHECKOUT_JSON).expect(
      "the real wire shape must deserialise — a failure here is a checkout the till cannot save",
    );

        // `orderType` is the spelling the screen sends; the field reads back as its
        // Rust name because that is what the SQL binds.
        assert_eq!(input.order.order_type, "takeaway");

        // Absent on the wire → defaulted to the crate's one clock read, not "".
        // Shape, not equality with a fresh `now_iso()`: the default was taken a
        // few microseconds ago and the second may have rolled over since.
        let defaulted = &input.outbox.next_attempt_at;
        assert_eq!(
            defaulted.len(),
            20,
            "must be YYYY-MM-DDTHH:MM:SSZ, got {defaulted}"
        );
        assert!(defaulted.ends_with('Z'), "must be UTC, got {defaulted}");

        let mut c = conn();
        write_order(&mut c, &input).expect("checkout commits");
        assert_eq!(count(&c, "local_orders"), 1);
        assert_eq!(count(&c, "local_order_lines"), 1);
        assert_eq!(count(&c, "sync_outbox"), 1);

        // THE POINT OF THE DEFAULT: the row must be claimable by the very next
        // drain tick. A next_attempt_at in the future would leave the sale sitting
        // in the queue with no delivery scheduled by anyone.
        let now = crate::sync_outbox::now_iso();
        let claimed = claim_ready(&mut c, 10, &now).expect("claim");
        assert_eq!(claimed.len(), 1, "a fresh outbox row is due immediately");
        assert_eq!(claimed[0].idempotency_key, "idem-outbox-1");
    }

    #[test]
    fn the_older_type_spelling_still_deserialises() {
        // `type` was this struct's declared wire name before the TS side settled on
        // `orderType`. Both must keep working: fixtures and tests built against
        // either spelling must not be stranded by which side moves first.
        let json = UI_CHECKOUT_JSON.replace("\"orderType\"", "\"type\"");
        let input: SaveOfflineOrderInput =
            serde_json::from_str(&json).expect("`type` remains an accepted alias");
        assert_eq!(input.order.order_type, "takeaway");
    }

    #[test]
    fn an_explicit_next_attempt_at_is_stored_verbatim() {
        // The default must never override a value the wire DID choose.
        let json = UI_CHECKOUT_JSON.replace(
      "\"idempotencyKey\": \"idem-outbox-1\",",
      "\"nextAttemptAt\": \"2026-10-03T09:00:00.000Z\",\n      \"idempotencyKey\": \"idem-outbox-1\",",
    );
        let input: SaveOfflineOrderInput =
            serde_json::from_str(&json).expect("an explicit nextAttemptAt is a known field");
        assert_eq!(input.outbox.next_attempt_at, "2026-10-03T09:00:00.000Z");

        let mut c = conn();
        write_order(&mut c, &input).expect("checkout commits");
        let stored: String = c
            .query_row("SELECT next_attempt_at FROM sync_outbox", [], |r| r.get(0))
            .expect("row exists");
        assert_eq!(stored, "2026-10-03T09:00:00.000Z");
    }

    // ── get_terminal_identity ───────────────────────────────────────────────────

    /// Both valid: version nibble `7` at index 14, variant nibble in `89ab` at
    /// index 19, hex and hyphens everywhere the layout demands.
    const ID_TERMINAL: &str = "0192f6c4-7c1e-7a3f-9b2d-4e6f8a1b2c3d";
    const ID_BRANCH: &str = "0192f6c5-1a2b-7c4d-8e5f-0123456789ab";

    #[test]
    fn terminal_identity_serialises_camel_case_for_the_frontend() {
        let id = identity_from_env(Some(ID_TERMINAL), Some(ID_BRANCH)).expect("both set and valid");
        assert_eq!(id.terminal_id, ID_TERMINAL);
        assert_eq!(id.branch_id, ID_BRANCH);

        let json = serde_json::to_string(&id).expect("serialises");
        // THE EXACT WIRE SHAPE LUE 3 WILL READ — printed so a `--nocapture` run
        // puts the real bytes in the report rather than a hand-copied claim.
        println!("get_terminal_identity → {json}");
        assert_eq!(
            json,
            r#"{"terminalId":"0192f6c4-7c1e-7a3f-9b2d-4e6f8a1b2c3d","branchId":"0192f6c5-1a2b-7c4d-8e5f-0123456789ab"}"#
        );
    }

    #[test]
    fn a_missing_terminal_id_names_the_variable_and_never_falls_back() {
        let err = identity_from_env(None, Some(ID_BRANCH)).expect_err("unset must fail");
        assert_eq!(err.kind, CommandErrorKind::InvalidPayload);
        assert!(
            err.message.contains("WAL_ASRI_TERMINAL_ID"),
            "{}",
            err.message
        );
        assert!(err.message.contains("is not set"), "{}", err.message);
    }

    #[test]
    fn a_missing_branch_id_names_the_variable_and_never_falls_back() {
        let err = identity_from_env(Some(ID_TERMINAL), None).expect_err("unset must fail");
        assert_eq!(err.kind, CommandErrorKind::InvalidPayload);
        assert!(
            err.message.contains("WAL_ASRI_BRANCH_ID"),
            "{}",
            err.message
        );
    }

    #[test]
    fn a_blank_value_counts_as_missing() {
        let err = identity_from_env(Some("   "), Some(ID_BRANCH)).expect_err("blank is not an id");
        assert!(
            err.message.contains("WAL_ASRI_TERMINAL_ID"),
            "{}",
            err.message
        );
    }

    #[test]
    fn a_non_uuid_identity_is_refused_with_the_shape_it_expected() {
        // The literal the checkout screen hard-codes today.
        let err = identity_from_env(Some("terminal-01"), Some(ID_BRANCH)).expect_err("not a uuid");
        assert_eq!(err.kind, CommandErrorKind::InvalidPayload);
        assert!(err.message.contains("UUIDv7"), "{}", err.message);
        assert!(err.message.contains("terminal-01"), "{}", err.message);
    }

    #[test]
    fn both_the_version_and_the_variant_nibble_are_checked() {
        // Version 4 — otherwise a perfect UUID shape.
        let v4 = "0192f6c4-7c1e-4a3f-9b2d-4e6f8a1b2c3d";
        assert!(
            identity_from_env(Some(v4), Some(ID_BRANCH)).is_err(),
            "version nibble"
        );

        // Variant 0 — not the RFC 9562 `10xx` variant.
        let variant_zero = "0192f6c4-7c1e-7a3f-0b2d-4e6f8a1b2c3d";
        assert!(
            identity_from_env(Some(variant_zero), Some(ID_BRANCH)).is_err(),
            "variant nibble"
        );

        // Uppercase variant letters spell the SAME variant and must pass.
        let upper = "0192f6c4-7c1e-7a3f-Bb2d-4e6f8a1b2c3d";
        assert!(
            identity_from_env(Some(upper), Some(ID_BRANCH)).is_ok(),
            "uppercase variant is valid"
        );

        // Wrong length.
        assert!(identity_from_env(Some("0192f6c4-7c1e-7a3f-9b2d"), Some(ID_BRANCH)).is_err());
    }

    // ── satang parsing ────────────────────────────────────────────────────────

    #[test]
    fn canonical_integers_parse() {
        assert_eq!(parse_satang("f", "0").unwrap(), 0);
        assert_eq!(parse_satang("f", "4550").unwrap(), 4550);
    }

    #[test]
    fn a_float_that_happens_to_be_whole_is_rejected() {
        // The value a `Money.fromNumber` call would have thrown on. It must not be
        // laundered through a string to get past that check.
        assert!(parse_satang("f", "4550.0").is_err());
    }

    #[test]
    fn a_negative_amount_is_rejected() {
        // A refund is a separate row with its own event type, never a negative price.
        assert!(parse_satang("f", "-1").is_err());
    }

    #[test]
    fn a_signed_value_is_rejected_rather_than_coerced() {
        assert!(parse_satang("f", "+4550").is_err());
    }

    #[test]
    fn whitespace_around_a_number_is_rejected() {
        assert!(parse_satang("f", " 4550").is_err());
        assert!(parse_satang("f", "4550 ").is_err());
        assert!(parse_satang("f", "4550\n").is_err());
    }

    #[test]
    fn non_base_ten_notations_are_rejected() {
        assert!(parse_satang("f", "4.55e3").is_err());
        assert!(parse_satang("f", "0x11A").is_err());
        assert!(parse_satang("f", "1_000").is_err());
        assert!(parse_satang("f", "").is_err());
    }

    #[test]
    fn a_leading_zero_is_reported_because_it_means_a_zero_padded_formatter() {
        assert!(parse_satang("f", "04550").is_err());
    }

    #[test]
    fn a_value_beyond_i64_is_rejected_rather_than_wrapping() {
        assert!(parse_satang("f", &"9".repeat(19)).is_err());
        assert!(parse_satang("f", &"9".repeat(30)).is_err());
    }

    // ── the one signed money field ─────────────────────────────────────────────

    #[test]
    fn a_negative_rounding_adjustment_parses() {
        // ฿45.53 rounds DOWN to ฿45.50 at a ฿0.25 step, so the adjustment is -3. This
        // is the exact value `round_to_nearest_coin` produces, and it is what made a
        // ฿45.53 cash sale unsavable while the feature read as working.
        assert_eq!(parse_signed_satang("f", "-3").unwrap(), -3);
        assert_eq!(parse_signed_satang("f", "-4550").unwrap(), -4550);
        assert_eq!(parse_signed_satang("f", "-1").unwrap(), -1);
    }

    #[test]
    fn the_signed_parser_still_accepts_a_non_negative_value() {
        // A rounding adjustment of 0 is the overwhelmingly common case, so the signed
        // parser must not be a second, subtly different dialect of the same grammar.
        assert_eq!(parse_signed_satang("f", "0").unwrap(), 0);
        assert_eq!(parse_signed_satang("f", "2").unwrap(), 2);
        assert_eq!(parse_signed_satang("f", "4550").unwrap(), 4550);
    }

    #[test]
    fn only_a_leading_minus_is_a_valid_sign() {
        // `+3` and `3` would be two spellings of one value, so only the canonical `-`
        // is admitted. `--3` is a sign with no usable magnitude.
        assert!(parse_signed_satang("f", "+3").is_err());
        assert!(parse_signed_satang("f", "-+3").is_err());
        assert!(parse_signed_satang("f", "--3").is_err());
        assert!(parse_signed_satang("f", "-").is_err());
        assert!(parse_signed_satang("f", "").is_err());
    }

    #[test]
    fn negative_zero_is_refused_as_a_second_spelling_of_zero() {
        // Same reason "00" is refused on the unsigned path.
        assert!(parse_signed_satang("f", "-0").is_err());
        assert!(parse_satang("f", "0").is_ok());
    }

    #[test]
    fn the_signed_parser_enforces_the_same_digit_rules_as_the_unsigned_one() {
        // The whole reason the two share `parse_satang_with`. If either drifted, a
        // money field would be accepted on one path and refused on the other.
        for bad in [
            "-04550", "-4550.0", "-4.55e3", "- 4550", "-4550 ", "-0x11A", "-1_000",
        ] {
            assert!(
                parse_signed_satang("f", bad).is_err(),
                "{bad:?} was accepted"
            );
            assert!(
                parse_satang("f", bad).is_err(),
                "{bad:?} was accepted unsigned"
            );
        }
    }

    #[test]
    fn the_unsigned_parser_still_refuses_every_negative() {
        // The sign exception is scoped to ONE field. If this ever passes, a negative
        // price or total has become writable and the exception has leaked.
        for bad in ["-1", "-4550", "-0", "-"] {
            assert!(
                parse_satang("f", bad).is_err(),
                "{bad:?} was accepted by the unsigned parser"
            );
        }
    }

    #[test]
    fn i64_min_parses_rather_than_being_reported_as_an_overflow() {
        // -9223372036854775808 fits in an i64 exactly. Its magnitude is one larger
        // than i64::MAX, so parsing it as a positive i64 first would fail and the
        // error would be a lie.
        assert_eq!(
            parse_signed_satang("f", "-9223372036854775808").unwrap(),
            i64::MIN
        );
        assert_eq!(parse_satang("f", "9223372036854775807").unwrap(), i64::MAX);
        // One below i64::MIN genuinely does not fit.
        assert!(parse_signed_satang("f", "-9223372036854775809").is_err());
    }

    // ── the transaction ───────────────────────────────────────────────────────

    #[test]
    fn a_good_checkout_writes_the_order_its_lines_and_one_outbox_event() {
        let mut c = conn();
        let out = write_order(&mut c, &good_input()).expect("checkout should commit");

        assert_eq!(out.line_count, 1);
        assert_eq!(count(&c, "local_orders"), 1);
        assert_eq!(count(&c, "local_order_lines"), 1);
        // Exactly one, not "at least one": the whole point of §2.2 is that the event
        // is queued with the sale, so an unqueued sale can never be a thing.
        assert_eq!(count(&c, "sync_outbox"), 1);
    }

    #[test]
    fn a_cash_sale_rounded_down_commits_with_a_negative_adjustment() {
        // THE test for the signed-rounding bridge fix, and it goes through the real
        // save path rather than the parser alone.
        //
        // ฿45.53 is the motivating total: baht coins end in 5 satang, so at a ฿0.25
        // step `round_to_nearest_coin` returns 4550 and the adjustment is -3. Before
        // `parse_signed_satang` existed, the unsigned grammar refused "-3" and this
        // exact sale could not be recorded at all — a feature that read as working
        // and silently was not, for the totals it was written for.
        //
        // The figures below satisfy every CHECK in `0002_signed_rounding.sql`:
        //   gross = 4553 - 0            = 4553
        //   total = 4553 + 0 + (-3)     = 4550
        //   taxable + tax = 4255 + 298 = 4553 = gross   (VAT is unaffected by rounding)
        //   total >= 0
        let mut c = conn();
        let mut input = good_input();
        input.order.subtotal_satang = "4553".into();
        input.order.taxable_satang = "4255".into();
        input.order.tax_satang = "298".into();
        input.order.rounding_adjustment_satang = "-3".into();
        input.order.total_satang = "4550".into();

        write_order(&mut c, &input).expect("a sale rounded DOWN must commit");

        let (rounding, total): (i64, i64) = c
            .query_row(
                "SELECT rounding_adjustment_satang, total_satang FROM local_orders WHERE id = ?1",
                [&input.order.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the order row should be readable");

        // Stored as a NEGATIVE INTEGER, not as the text "-3". A value that reached
        // SQLite as TEXT would defeat every `typeof(...) = 'integer'` CHECK the
        // schema relies on to keep floats out of money columns.
        assert_eq!(
            rounding, -3,
            "the adjustment must be stored as a signed integer"
        );
        assert_eq!(total, 4550);
    }

    #[test]
    fn a_negative_price_is_still_refused_end_to_end() {
        // The counterweight to the test above. The sign exception is scoped to
        // `rounding_adjustment_satang`; if this ever commits, the exception has leaked
        // into the other money columns.
        let mut c = conn();
        let mut input = good_input();
        input.order.total_satang = "-4550".into();

        let error = write_order(&mut c, &input).expect_err("a negative total must not commit");

        assert_eq!(error.kind, CommandErrorKind::InvalidPayload);
        assert_eq!(count(&c, "local_orders"), 0);
    }

    #[test]
    fn a_broken_line_leaves_nothing_behind() {
        // THE test for SKILL.md §2.2. A line whose total does not satisfy the
        // schema's arithmetic identity — exactly what a bug in the TypeScript cart
        // maths produces — is rejected by the CHECK on the line insert. The order
        // row was already written by then. If the three writes were not in one
        // transaction, this database would now hold a committed sale with no lines
        // and no outbox event: money taken, nothing queued, nothing to sync.
        let mut c = conn();
        let mut input = good_input();
        input.lines[0].line_total_satang = "9999".into(); // 4550 - 0 + 319 = 4869

        let error = write_order(&mut c, &input).expect_err("a broken line must fail the checkout");

        assert_eq!(error.kind, CommandErrorKind::Storage);
        assert_eq!(
            count(&c, "local_orders"),
            0,
            "the order row must have rolled back"
        );
        assert_eq!(count(&c, "local_order_lines"), 0);
        assert_eq!(
            count(&c, "sync_outbox"),
            0,
            "no event may be queued for a sale that did not happen"
        );
    }

    #[test]
    fn a_second_checkout_with_the_same_idempotency_key_is_rejected() {
        let mut c = conn();
        write_order(&mut c, &good_input()).expect("first checkout");

        let error =
            write_order(&mut c, &good_input()).expect_err("a replay must not sell the drink twice");
        assert_eq!(error.kind, CommandErrorKind::Storage);
        assert_eq!(
            count(&c, "local_orders"),
            1,
            "the duplicate must not become a second sale"
        );
    }

    #[test]
    fn an_order_with_no_lines_is_rejected_before_any_statement_runs() {
        let mut c = conn();
        let mut input = good_input();
        input.lines.clear();

        write_order(&mut c, &input).expect_err("an order with no lines is not reconcilable");

        assert_eq!(count(&c, "local_orders"), 0);
    }

    #[test]
    fn a_zero_quantity_line_is_rejected() {
        let mut c = conn();
        let mut input = good_input();
        input.lines[0].quantity = "0".into();

        let error = write_order(&mut c, &input).expect_err("a zero-quantity line must be refused");
        assert_eq!(error.kind, CommandErrorKind::InvalidPayload);
        assert_eq!(count(&c, "local_orders"), 0);
    }

    #[test]
    fn a_malformed_satang_field_is_rejected_before_anything_is_written() {
        let mut c = conn();
        let mut input = good_input();
        input.order.total_satang = "48.69".into();

        let error = write_order(&mut c, &input).expect_err("a float must not reach the database");
        assert_eq!(error.kind, CommandErrorKind::InvalidPayload);
        assert!(error.message.contains("totalSatang"));
        assert_eq!(count(&c, "local_orders"), 0);
    }

    #[test]
    fn the_database_refuses_a_line_whose_order_does_not_exist() {
        // Proves the foreign-key pragma at src/db.rs is actually in force. It was
        // silently OFF for the life of migration 0001, which set
        // `PRAGMA foreign_keys = ON` inside the migration's own transaction.
        let c = conn();
        c.execute(
            "INSERT INTO local_order_lines (id, order_id, variant_id, name_th, quantity,
         unit_price_satang, line_discount_satang, line_tax_satang, line_total_satang, created_at)
       VALUES ('l1', 'no-such-order', 'v1', 'กาแฟ', 1, 100, 0, 0, 100, '2026-10-03T09:00:00.000Z')",
            [],
        )
        .expect_err("a line must not outlive its order");
    }

    #[test]
    fn a_committed_sale_cannot_be_deleted_or_restated() {
        // The money-immutability trigger, from the write path's side: once checkout
        // has returned, the only correction is void-and-re-ring.
        let mut c = conn();
        write_order(&mut c, &good_input()).expect("checkout");

        c.execute("DELETE FROM local_orders", [])
            .expect_err("a sale may not be deleted");
        c.execute(
            "UPDATE local_orders SET total_satang = 1 WHERE id = ?1",
            ["018f3c2a-0000-7000-8000-000000000001"],
        )
        .expect_err("a committed sale may not be restated");
    }

    // ── the history query ─────────────────────────────────────────────────────

    #[test]
    fn an_empty_database_reads_as_an_empty_list_not_an_error() {
        let c = conn();
        assert!(
            query_recent(&c, 50)
                .expect("query on an empty database")
                .is_empty()
        );
    }

    #[test]
    fn history_returns_newest_first_with_its_line_count_and_satang_as_a_string() {
        let mut c = conn();
        write_order(&mut c, &good_input()).expect("first checkout");

        let mut second = good_input();
        second.order.id = "018f3c2a-0000-7000-8000-000000000002".into();
        second.order.local_receipt_number = "R-0002".into();
        second.order.idempotency_key = "idem-2".into();
        second.order.created_at = "2026-10-03T10:00:00.000Z".into();
        second.lines[0].id = "line-2".into();
        // The outbox row's own identity needs distinct values too: `sync_outbox`
        // carries its own UNIQUE `idempotency_key`, and reusing the first checkout's
        // is refused — which is the replay protection working, not a test artefact.
        second.outbox.id = "outbox-2".into();
        second.outbox.idempotency_key = "idem-outbox-2".into();
        write_order(&mut c, &second).expect("second checkout");

        let rows = query_recent(&c, 50).expect("history");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].local_receipt_number, "R-0002", "newest first");
        assert_eq!(rows[1].local_receipt_number, "R-0001");
        assert_eq!(rows[0].line_count, 1);
        // VAT-inclusive: the stored total is the ฿45.50 charged, tax included.
        // Under the old exclusive rule this read 4869 (4550 + 319).
        assert_eq!(rows[0].total_satang, "4550");
        assert_eq!(rows[0].currency_code, "THB");
        assert_eq!(rows[0].sync_state, "pending");
    }

    /// A NEGATIVE rounding adjustment must survive disk → history projection with
    /// its sign intact.
    ///
    /// This is the round-DOWN direction, and it is the case that breaks if the
    /// column is read as unsigned: −3 read through a `u64` does not come back as
    /// −3, and a shift lead reconciling a drawer that was 3 satang SHORT would be
    /// shown a 6-satang error instead.
    ///
    /// The figures satisfy BOTH identities in migration 0002:
    ///   total = 4550 − 0 + 0 + (−3) = 4547
    ///   taxable + tax = 4547 − 0 − (−3) = 4550   (4252 + 298)
    /// Getting either wrong would fail the CHECK rather than run, which is the
    /// point of having written them down here.
    #[test]
    fn history_returns_a_negative_rounding_adjustment_with_its_sign() {
        let mut c = conn();

        let mut input = good_input();
        input.order.total_satang = "4547".into();
        input.order.rounding_adjustment_satang = "-3".into();
        // Distinct replay keys — `sync_outbox.idempotency_key` is UNIQUE, and this
        // database starts empty, so reusing anything would be refused.
        input.order.idempotency_key = "idem-negative-rounding".into();
        input.outbox.idempotency_key = "idem-outbox-negative-rounding".into();
        input.outbox.id = "outbox-negative-rounding".into();

        write_order(&mut c, &input).expect("checkout that rounded DOWN");

        let rows = query_recent(&c, 50).expect("history");
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].rounding_adjustment_satang, "-3",
            "the minus sign must survive the round trip through SQLite and to_string()"
        );
        // The payable is ฿45.47 — LOWER than the ฿45.50 subtotal. If these two ever
        // disagreed the history screen would show an adjustment that does not
        // reconcile with the total beside it.
        assert_eq!(rows[0].total_satang, "4547");
        assert_eq!(rows[0].currency_code, "THB");
    }

    #[test]
    fn history_honours_its_limit() {
        let mut c = conn();
        write_order(&mut c, &good_input()).expect("checkout");

        assert_eq!(query_recent(&c, 1).expect("history").len(), 1);
    }

    #[test]
    fn a_non_positive_limit_is_an_error_rather_than_an_empty_list() {
        let c = conn();
        for bad in [0, -1] {
            let error = query_recent(&c, bad).expect_err("a broken page size must be loud");
            assert_eq!(error.kind, CommandErrorKind::InvalidPayload);
        }
    }

    #[test]
    fn migration_is_idempotent_against_a_database_that_already_has_the_schema() {
        // What happens when the app is launched twice, or recovers from a crash
        // between opening the file and finishing startup.
        let mut c = conn();
        migrate(&mut c).expect("second migration pass");
        write_order(&mut c, &good_input()).expect("checkout still works");
    }

    #[test]
    fn request_order_void_marks_order_as_void_requested_and_queues_outbox_event() {
        let mut c = conn();
        write_order(&mut c, &good_input()).expect("checkout");
        let order_id = "018f3c2a-0000-7000-8000-000000000001";
        
        let input = VoidRequestInput {
            order_id: order_id.into(),
            receipt_token: "token-1".into(),
            idempotency_key: "void-idem-1".into(),
            next_attempt_at: "2026-10-03T10:00:00.000Z".into(),
            created_at: "2026-10-03T10:00:00.000Z".into(),
        };
        
        write_void_request(&mut c, &input).expect("void request commits");
        
        let status: String = c.query_row("SELECT status FROM local_orders WHERE id = ?1", [order_id], |r| r.get(0)).unwrap();
        assert_eq!(status, "void_requested");
        
        let outbox_count: i64 = c.query_row("SELECT COUNT(*) FROM sync_outbox WHERE id = 'void:void-idem-1'", [], |r| r.get(0)).unwrap();
        assert_eq!(outbox_count, 1);
    }
}
