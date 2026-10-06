// Package usecase holds the inventory module's application logic — the
// interactor that turns an accepted sale into stock deductions and reports what
// the operator needs to know about the result.
//
// ── WHAT THIS PACKAGE DECIDES, AND WHAT IT DELIBERATELY DOES NOT ─────────────
//
// It decides three things:
//
//  1. WHICH LINES DEDUCT ANYTHING. A sold variant resolves to at most one tracked
//     article, and an article with `track_stock = false` resolves to none.
//  2. WHAT THE DELTA IS. Delegated wholly to domain.NewSaleDeduction, which is the
//     single place the sign convention exists. An interactor that recomputed a
//     quantity would be a second implementation of that rule.
//  3. WHETHER TO WARN. Read off the balances the adapter returned AFTER commit,
//     never off a prior read — see the note at DeductSale.Execute.
//
// It does NOT decide:
//
//   - whether the article HAS ENOUGH. It never does, and cannot. See the package
//     header in ../domain: a negative balance is committed and reported, because
//     the sale happened and refusing the record would hide it.
//   - how much stock a raw ingredient consumes. There is no Recipe in
//     contracts/openapi.yaml, so there is no recipe to read. A raw ingredient
//     whose recipe this service cannot see deducts NOTHING rather than an invented
//     amount, which under-deducts visibly instead of over-deducting silently.
//
// ── WHY THE PORTS ARE DECLARED HERE AND NOT IN adapter/ ───────────────────────
//
// Dependency inversion, and the reason is mechanical: this package's tests must
// run without a database. A port imported from adapter/postgres would make every
// test here need Postgres, and the arrow would point inward from application
// logic to infrastructure — the direction this architecture exists to prevent.
//
// internal/architecture/layers_test.go fails the build if a `usecase/` package
// ever imports its own `adapter`.
//
// ── WHY THE ORDER MODULE CANNOT CALL THIS DIRECTLY ────────────────────────────
//
// It cannot, and the same guard forbids it: "modules may not depend on another
// module's application layer". So `internal/order/usecase` declares its OWN port
// in its own vocabulary (orderuc.StockLedger) and
// `internal/order/adapter/inventory` implements it over DeductSale.
//
// That inversion is the same one `internal/sync/adapter/order` exists for, and it
// buys the same thing: the ingest pipeline stays testable against a fake, and this
// package stays ignorant of what an order is.
package usecase

import (
	"context"
	"fmt"
	"sort"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	inventory "wal-asri-pos/services/api-backend/internal/inventory/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
)

// ─────────────────────────────────────────────────────────────────────────────
// Ports
// ─────────────────────────────────────────────────────────────────────────────

// ItemLookup resolves a sold product variant to the article whose stock it
// consumes.
//
// SPLIT FROM THE WRITE PORT, and the split is what makes the skip decision
// testable. The lookup is a read that happens once per line BEFORE any write; the
// write happens once for the whole order. If both were one port, "a variant with
// no tracked article is skipped" would be indistinguishable from "the store
// refused", and both would surface as the same error.
type ItemLookup interface {
	// TrackedItemFor returns the tracked article a sold variant consumes.
	//
	// The boolean is false when NO deduction applies, and that is a NORMAL case
	// rather than a failure. Two situations produce it:
	//
	//   - the variant is not stock-tracked at all (a garnish, `track_stock = false`)
	//   - the catalogued variant has no inventory_items row yet
	//
	// An error is reserved for the store genuinely being unavailable — a dropped
	// connection, a query that failed. Conflating "nothing to deduct" with "cannot
	// find out" is how a database outage turns into stock that was silently
	// never deducted, so the two are separate return values.
	TrackedItemFor(ctx context.Context, branchID, productVariantID identity.UUIDv7) (inventory.InventoryItem, bool, error)
}

// StockStore appends movements and derives balances from them.
//
// ONE METHOD, because the transaction boundary is the whole of its contract: a
// deduction that appended its movement without updating its balance — or the
// reverse — would leave the ledger and the projection disagreeing, and the only
// defence against that is that both happen in one transaction this method owns.
type StockStore interface {
	// ApplyDeductions appends every movement and updates every balance in ONE
	// transaction, and returns the balances AS THEY NOW STAND.
	//
	// An empty slice is a success returning an empty slice, not an error: an order
	// whose every line is untracked has genuinely nothing to deduct, and reporting
	// that as a failure would make a legitimate sale look broken.
	//
	// Movements that already exist are skipped rather than rejected, so applying
	// the same deductions twice is a no-op. That is what makes the whole
	// deduction idempotent per order line, and it is why the adapter can be retried
	// safely after a lost connection.
	ApplyDeductions(ctx context.Context, deductions []inventory.Deduction) ([]inventory.StockBalance, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// The request and the result
// ─────────────────────────────────────────────────────────────────────────────

// SaleLine is one sold line, in this module's own vocabulary.
//
// It carries NO order id. The order is the context of the whole deduction, not of
// each line, and repeating it per line would invite a caller to pass lines from
// two different orders in one call — which would produce a set of movements that
// no single receipt justifies.
type SaleLine struct {
	// OrderLineID is the client-generated id of the sold line, and it becomes the
	// movement's primary key. See domain.NewSaleDeduction for why that identity is
	// borrowed rather than minted.
	OrderLineID identity.UUIDv7

	ProductVariantID identity.UUIDv7
	Quantity         Quantity
}

// Quantity is the exact quantity sold, in milli-units.
//
// A type ALIAS for `money.Quantity` rather than a defined type, so a
// `money.Quantity` is accepted without conversion at the call site. The seam
// adapter (internal/order/adapter/inventory) already speaks `money.Quantity`, and
// making it convert would add a step whose only possible effect is an error.
//
// The kernel is reused rather than reimplemented because it already IS this
// concept: internal/money/domain/quantity.go documents a Quantity as "an int64
// count of MILLI-units, so `2.500` is 2500 and `0.005` is 5", with the exact
// decimal grammar the contract's `Quantity` string pattern specifies.
type Quantity = money.Quantity

// SaleRequest is one order's worth of stock to consume.
type SaleRequest struct {
	BranchID identity.UUIDv7
	Lines    []SaleLine
}

// StockWarning is one article that went below zero.
//
// REPORTED, NOT ENFORCED. This is the ratified policy in its entirety: the
// deduction committed, and the shortage travels upward so an operator can act on
// it. The alternative — refusing the sale — would not prevent an oversell that has
// already happened on an offline terminal, and would only make the shortage
// invisible.
type StockWarning struct {
	InventoryItemID identity.UUIDv7
	NameTH          string
	Unit            string

	// OnHandMilli is the committed balance, SIGNED. Negative means oversold.
	//
	// Named `...Milli` and typed as a raw int64 rather than as a Quantity because
	// this struct is serialised into the acknowledgement a terminal receives. A
	// Quantity would marshal as the decimal string "−0.750" under a field called
	// `on_hand`, which is a DIFFERENT wire shape from the one the contract
	// defines for StockBalance — and the acknowledgement is not the place to
	// quietly introduce a second spelling of the same value.
	OnHandMilli int64
}

// Oversold reports whether the committed balance is below zero.
func (w StockWarning) Oversold() bool { return w.OnHandMilli < 0 }

// ─────────────────────────────────────────────────────────────────────────────
// The interactor
// ─────────────────────────────────────────────────────────────────────────────

// DeductSale consumes stock for an accepted sale.
type DeductSale struct {
	items ItemLookup
	store StockStore
	now   func() time.Time
}

// DeductSaleDeps is the constructor's argument bundle, so adding a port does not
// change every call site's arity.
type DeductSaleDeps struct {
	Items ItemLookup
	Store StockStore
	// Now is injected rather than called, so a movement's created_at is
	// reproducible in a test. Every other interactor in this service takes its
	// clock the same way, and for the same reason: an assertion that has to
	// tolerate a tolerance is hiding a bug.
	Now func() time.Time
}

// NewDeductSale wires the interactor.
func NewDeductSale(d DeductSaleDeps) *DeductSale {
	nowFn := d.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	return &DeductSale{items: d.Items, store: d.Store, now: nowFn}
}

// Execute consumes stock for one sale and reports any shortage.
//
// ── THE ORDER OF THE FOUR STEPS, AND WHY ──────────────────────────────────────
//
//  1. RESOLVE every line to a tracked article, skipping the ones that resolve to
//     nothing. All of this is a READ, so doing it first means a sale with no
//     tracked lines never opens a write transaction at all.
//
//  2. BUILD the deductions. domain.NewSaleDeduction owns the sign, and it
//     validates as it builds — a malformed line fails here, before any write.
//
//  3. APPLY them all, in ONE transaction.
//
//  4. WARN from the balances the adapter returned.
//
// Step 4 is the one worth explaining at length, because the obvious
// implementation reads the balance BEFORE the write and compares it afterwards:
//
//	if current.on_hand - deducted < 0 { warn }
//
// That is wrong twice over. It is a TOCTOU window — two terminals draining
// simultaneously would both read "5.000", both conclude "fine", and both write,
// leaving the shelf at -3.500 with nobody warned. And it disagrees with the
// database under exactly that concurrency, so the operator would be told about a
// shortage that the ledger says is in the clear.
//
// So the warning is derived from the balance the adapter returns from inside its
// own transaction, after the write that produced it. Whatever the caller is told
// is what was stored, by construction.
//
// ── AN ERROR IS NOT A WARNING ─────────────────────────────────────────────────
//
// A store failure propagates. The sale is real and the stock was really consumed,
// so the caller must NOT be told the sale succeeded with stock intact — that
// would be the exact silent-gap failure this service refuses elsewhere. The caller
// is expected to fail the ingest, which leaves the order to be retried and, thanks
// to the movement's borrowed id, the retry to be a no-op for anything that landed.
//
// Warnings, by contrast, are the NORMAL outcome of an oversell and travel in the
// result alongside the committed balances.
func (d *DeductSale) Execute(ctx context.Context, req SaleRequest) ([]StockWarning, error) {
	now := d.now().UTC()

	// ── Step 1: resolve, then skip ───────────────────────────────────────────
	items := make([]inventory.InventoryItem, 0, len(req.Lines))
	for i, line := range req.Lines {
		item, tracked, err := d.items.TrackedItemFor(ctx, req.BranchID, line.ProductVariantID)
		if err != nil {
			return nil, fmt.Errorf(
				"inventory: resolving the article behind line %d (variant %s): %w",
				i, line.ProductVariantID, err)
		}
		if !tracked || !item.Tracked() {
			// THE SKIP. Two things land here and both are correct:
			//
			//   - the variant is not stock-tracked (a garnish)
			//   - there is no inventory_items row for it yet
			//
			// The second is a REAL and common gap: a café adds a new drink to the
			// menu on the back office and the terminals sync the catalogue before
			// anybody creates an inventory article for it. Refusing the sale over
			// that would mean a café cannot sell a new item until its stock-keeping
			// is finished — for a product that may not even consume anything.
			//
			// What it must never become is an ERROR. An error here fails the whole
			// ingest and the terminal retries forever.
			continue
		}
		items = append(items, item)
	}

	// ── Step 2: build, validating as we go ────────────────────────────────────
	deductions := make([]inventory.Deduction, 0, len(req.Lines))
	for i, line := range req.Lines {
		item, ok := itemForVariant(items, line.ProductVariantID)
		if !ok {
			continue
		}
		deduction, err := inventory.NewSaleDeduction(item, line.OrderLineID, line.Quantity, now)
		if err != nil {
			return nil, fmt.Errorf("inventory: deducting line %d: %w", i, err)
		}
		deductions = append(deductions, deduction)
	}

	// ── Step 3: one transaction, all of it ────────────────────────────────────
	//
	// An order whose every line is untracked never opens a transaction. That is
	// not an optimisation — it is the difference between "there was nothing to
	// deduct" and "we wrote something and it happened to change nothing", and
	// only the first is true.
	if len(deductions) == 0 {
		return nil, nil
	}

	committed, err := d.store.ApplyDeductions(ctx, deductions)
	if err != nil {
		return nil, fmt.Errorf("inventory: applying %d deduction(s) for branch %s: %w",
			len(deductions), req.BranchID, err)
	}

	// ── Step 4: warn, from what was stored ────────────────────────────────────
	return warningsFrom(items, committed), nil
}

// itemForVariant finds the resolved article for a sold variant.
//
// The schema guarantees at most one article per (branch, variant) —
// `idx_inventory_items_variant` is a partial UNIQUE — so this scan cannot be
// ambiguous. It is a linear scan over the items resolved for THIS order, which is
// a handful of entries, not a table scan.
func itemForVariant(items []inventory.InventoryItem, variantID identity.UUIDv7) (inventory.InventoryItem, bool) {
	for _, item := range items {
		if item.ProductVariantID == nil {
			continue
		}
		if item.ProductVariantID.Compare(variantID) == 0 {
			return item, true
		}
	}
	return inventory.InventoryItem{}, false
}

// warningsFrom turns committed balances into warnings.
//
// DEDUPLICATED BY ARTICLE, and the reason is an order that rings the same article
// twice. A customer ordering two oat lattes is two order lines against one
// article, so an undeduplicated warning would name the same shelf twice — and a
// terminal rendering that as two alerts makes an operator read one shortage as
// two.
//
// The set is ordered by article id so the warning list is stable across runs, and
// so a test asserting on it does not depend on map iteration order.
func warningsFrom(items []inventory.InventoryItem, committed []inventory.StockBalance) []StockWarning {
	if len(committed) == 0 {
		return nil
	}

	byID := make(map[identity.UUIDv7]inventory.InventoryItem, len(items))
	for _, item := range items {
		byID[item.ID] = item
	}

	var warnings []StockWarning
	seen := make(map[identity.UUIDv7]bool, len(committed))
	for _, balance := range committed {
		if seen[balance.InventoryItemID] {
			continue
		}
		seen[balance.InventoryItemID] = true

		if !balance.IsOversold() {
			continue
		}
		item, known := byID[balance.InventoryItemID]
		if !known {
			// The store returned a balance for an article this call did not
			// resolve — which should be impossible, since it only ever receives
			// deductions built from `items`. Skipping rather than panicking keeps
			// a store bug from failing an accepted sale, and the balance is still
			// correct in the database either way.
			continue
		}
		warnings = append(warnings, StockWarning{
			InventoryItemID: item.ID,
			NameTH:          item.NameTH,
			Unit:            item.Unit,
			OnHandMilli:     balance.OnHand.Milli(),
		})
	}

	sort.Slice(warnings, func(i, j int) bool {
		return warnings[i].InventoryItemID.Compare(warnings[j].InventoryItemID) < 0
	})
	return warnings
}
