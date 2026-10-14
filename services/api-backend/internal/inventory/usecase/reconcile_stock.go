package usecase

import (
	"context"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	inventory "wal-asri-pos/services/api-backend/internal/inventory/domain"
)

// ReconcileStock re-aligns stock balances with the ledger and records an audit.
type ReconcileStock struct {
	store StockStore
	now   func() time.Time
}

// ReconcileStockDeps is the constructor's argument bundle.
type ReconcileStockDeps struct {
	StockStore
	// Now is injected rather than called, so the audit's created_at is
	// reproducible in a test.
	Now func() time.Time
}

// NewReconcileStock wires the interactor.
func NewReconcileStock(d ReconcileStockDeps) *ReconcileStock {
	nowFn := d.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	return &ReconcileStock{store: d.StockStore, now: nowFn}
}

// Execute reconciles the branch's stock balances with the ledger.
func (r *ReconcileStock) Execute(ctx context.Context, branchID identity.UUIDv7) (inventory.ReconcileResult, error) {
	return r.store.ReconcileBalances(ctx, branchID)
}