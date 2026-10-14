package usecase

import (
	"context"
	"time"

	inventory "wal-asri-pos/services/api-backend/internal/inventory/domain"
)

// AdjustStock applies a terminal's claim about a stock article's quantity.
//
// It resolves the article (skipping untracked items), validates the audit id,
// and delegates to the store's AdjustStock method which handles the transaction,
// audit insertion, ledger verification, delta computation, and movement creation.
type AdjustStock struct {
	itemLookup ItemLookup
	audit       AuditStore
	store       StockStore
	now         func() time.Time
}

// AdjustStockDeps is the constructor's argument bundle, so adding a port does not
// change every call site's arity.
type AdjustStockDeps struct {
	ItemLookup
	AuditStore
	StockStore
	// Now is injected rather than called, so the audit's created_at is
	// reproducible in a test. Every other interactor in this service takes its
	// clock the same way, and for the same reason: an assertion that has to
	// tolerate a tolerance is hiding a bug.
	Now func() time.Time
}

// NewAdjustStock wires the interactor.
func NewAdjustStock(d AdjustStockDeps) *AdjustStock {
	nowFn := d.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	return &AdjustStock{
		itemLookup: d.ItemLookup,
		audit:       d.AuditStore,
		store:       d.StockStore,
		now:         nowFn,
	}
}

// Execute applies the terminal claim.
func (a *AdjustStock) Execute(ctx context.Context, req inventory.AdjustStockRequest) (inventory.AdjustStockResult, error) {
	// Step 0: resolve the article, skip if untracked.
	_, ok, err := a.itemLookup.TrackedItemFor(ctx, req.BranchID, req.InventoryItemID)
	if err != nil {
		return inventory.AdjustStockResult{}, err
	}
	if !ok {
		// Untracked — do nothing. The terminal's claim cannot be applied.
		return inventory.AdjustStockResult{}, inventory.ErrUntrackedItem
	}

	// Delegate to the store which handles the transaction, audit, lock, ledger check, and delta.
	return a.store.AdjustStock(ctx, req)
}
