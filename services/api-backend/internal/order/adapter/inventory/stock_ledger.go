// Package inventory adapts the inventory module to the order module's StockLedger
// port.
//
// ── WHY THIS SEAM EXISTS ──────────────────────────────────────────────────────
//
// `internal/order/usecase` may not import `internal/inventory/usecase` —
// internal/architecture/layers_test.go forbids one module's application layer from
// depending on another's, and the rule is what keeps the two modules independently
// testable.
//
// So the ORDER module declares its own port in its own vocabulary
// (orderuc.StockLedger, in internal/order/usecase/ingest_order.go) and this package
// implements it over the inventory interactor.
//
// This is the same seam `internal/sync/adapter/order` exists for, and it buys the
// same thing: the ingest pipeline stays testable against a fake, and neither
// application layer knows the other's types.
//
// ── WHAT IT TRANSLATES, AND NOTHING ELSE ──────────────────────────────────────
//
// Three mappings, each of which is a rename rather than a computation:
//
//	orderuc.SaleStockLine  →  inventoryuc.SaleLine
//	orderuc.StockWarning   ←  inventoryuc.StockWarning
//	the order's BRANCH      →  the deduction's branch
//
// Notably it does NOT translate QUANTITIES. `orderuc.SaleStockLine.Quantity` is
// `money.Quantity` and `inventoryuc.SaleLine.Quantity` is an alias for the same
// type, so the value crosses by assignment.
//
// That is deliberate and it is the reason no arithmetic appears in this file: the
// quantity the terminal priced with is the quantity deducted, and a conversion in
// between is a step whose only possible effect is to change a number. The
// authoritative sign lives in inventory's domain.NewSaleDeduction and is reached
// through one call; there is exactly one implementation of it in the service.
package inventory

import (
	"context"
	"fmt"

	inventoryuc "wal-asri-pos/services/api-backend/internal/inventory/usecase"
	orderuc "wal-asri-pos/services/api-backend/internal/order/usecase"
)

// StockLedger implements orderuc.StockLedger over the inventory interactor.
//
// Stateless. Everything it needs arrives in the argument, which is what lets the
// composition root build one and share it, and what lets a test build one over a
// fake store without any setup.
type StockLedger struct {
	deduct *inventoryuc.DeductSale
}

// NewStockLedger wires the adapter.
func NewStockLedger(deduct *inventoryuc.DeductSale) *StockLedger {
	return &StockLedger{deduct: deduct}
}

// InterfaceCheck fails to compile if the port drifts from this type.
var _ orderuc.StockLedger = (*StockLedger)(nil)

// DeductForSale consumes stock for one accepted order and reports any shortage.
//
// A FAILURE PROPAGATES, and that is the whole of the contract on the error path.
// The caller is `IngestOrder.Execute`, which has already committed the order by the
// time this runs, and it must NOT be told the sale succeeded with stock intact —
// an acknowledgement a terminal clears its outbox row on is a sale the server has
// promised is fully recorded, and a promise about stock that was not kept is the
// kind of gap this service refuses in the loudest terms.
//
// So an error here fails the ingest. The order stays committed, the terminal
// retries, and the retry is a no-op for any deduction that already landed — the
// movement's id is the order line's id, so re-presenting it collides with itself.
func (l *StockLedger) DeductForSale(ctx context.Context, sale orderuc.SaleStock) ([]orderuc.StockWarning, error) {
	lines := make([]inventoryuc.SaleLine, 0, len(sale.Lines))
	for _, line := range sale.Lines {
		lines = append(lines, inventoryuc.SaleLine{
			OrderLineID:      line.OrderLineID,
			ProductVariantID: line.ProductVariantID,
			// By assignment, not by conversion. See the package note.
			Quantity: line.Quantity,
		})
	}

	warnings, err := l.deduct.Execute(ctx, inventoryuc.SaleRequest{
		BranchID: sale.BranchID,
		Lines:    lines,
	})
	if err != nil {
		return nil, fmt.Errorf(
			"inventory: deducting stock for order %s: %w. The order is already committed, so this "+
				"must fail the submission rather than acknowledge a sale whose stock was not recorded",
			sale.OrderID, err)
	}

	out := make([]orderuc.StockWarning, 0, len(warnings))
	for _, w := range warnings {
		out = append(out, orderuc.StockWarning{
			InventoryItemID: w.InventoryItemID,
			NameTH:          w.NameTH,
			Unit:            w.Unit,
			OnHandMilli:     w.OnHandMilli,
		})
	}
	return out, nil
}
