// Package http holds the order module's HTTP surface, which is currently EMPTY ON
// PURPOSE, and that is the finding rather than an omission.
//
// ── WHY THERE IS NO HANDLER HERE YET ──────────────────────────────────────────
//
// contracts/openapi.yaml is the declared Single Source of Truth for this service,
// and it defines exactly two paths:
//
//	GET /catalog
//	GET /inventory/balances
//
// There is no `/orders`, no `/sync/push`, and no `Order`, `OrderLine`, `Payment`,
// `Refund` or `OutboxItem` schema. The file's own preamble even refers to
// "`OrderStatus`, `OutboxStatus`" as though they were defined — they are not. The
// tags list contains only Catalog and Inventory.
//
// So the Order ingest path in `internal/order/usecase` is COMPLETE and TESTED,
// but it has no route. That is deliberate:
//
//   - The order logic is fully specified by docs/02-design/DOMAIN.md and by the
//     ratified money rules, so it can be built and proven now.
//   - The ORDER WIRE FORMAT cannot. Inventing request/response shapes here would
//     fork the contract — a second, undocumented source of truth for a JavaScript
//     client to be generated from. That is the specific failure SKILL.md §4 exists
//     to prevent: step 1 writes the contract, step 2 generates the types, step 3
//     implements it. Building the implementation before step 1 inverts it.
//
// The work to unblock this is small and belongs in contracts/openapi.yaml, not
// here. This file documents what must be added so the gap is closable without
// re-reading the domain.
//
// ── WHAT THE CONTRACT NEEDS TO GAIN ───────────────────────────────────────────
//
//	paths:
//	  /sync/push                  POST   the offline outbox drain
//	  /orders/{order_id}          GET    one order, for reconciliation
//
//	schemas:
//	  Order, OrderLine, OrderLineModifier, Payment, Refund
//	  OutboxStatus                the 4-state lifecycle
//	  IdempotencyKeyHeader        the header carrying the client's key
//
// Required decisions, none of which can be invented here:
//
//  1. Is an order pushed as a whole aggregate (`POST /sync/push` with a full
//     Order) or as discrete events? The aggregate is simpler and matches how the
//     terminal's outbox already stores it.
//  2. What is the HTTP status for a replayed idempotency key? The interactor
//     returns ErrDuplicateSubmission, which is a SUCCESS with the original body.
//     200 is the obvious answer; 409 is the wrong one, because a terminal that
//     reads 409 as a failure retries forever.
//  3. Does a held order (CONFLICT_HELD) return 200, 202 or 409? It is stored and
//     the money is real, so it is not a failure — but the terminal should stop
//     retrying. 202 Accepted fits.
//  4. Where does the idempotency key travel — a header or the body? ARCHITECTURE-DEMO.md
//     §7 shows `POST /sync/push` with "HTTPS + Idempotency-Key", so a header, but
//     the contract must say so explicitly.
package http

import (
	"fmt"

	order "wal-asri-pos/services/api-backend/internal/order/domain"
	orderuc "wal-asri-pos/services/api-backend/internal/order/usecase"
)

// Routes is the set of routes this module serves. Empty, and asserted as such by
// the test in this package, so that the day someone adds a handler without first
// updating the contract, the reason is in the diff.
var Routes = map[string]struct{}{}

// Handler would adapt IngestOrder to the wire. It does not exist yet — see the
// package note.
//
// The type alias below exists to document the exact dependency this handler will
// have, so the dependency is reviewable before the code is written: the adapter
// takes the USE CASE, never the repository.
type (
	// IngestUseCase is the interactor an order handler will depend on.
	_ = orderuc.IngestOrder

	// OrderAggregate is the domain type a request body will be parsed into before
	// being handed to the interactor.
	//
	// Note what this does NOT do: it does not define a request DTO carrying a
	// `total_satang`. A body that asserts its own total is a body the server must
	// re-derive and then compare against — which is what the interactor already
	// does, and what makes a stale terminal detectable rather than silently
	// believed.
	_ = order.Order
)

// ErrContractMissing explains, at runtime and precisely, why this module serves
// nothing — so an operator who curls an order endpoint sees an accurate reason
// rather than a bare 404.
func ErrContractMissing(path string) error {
	return fmt.Errorf(
		"order: %s is not served because contracts/openapi.yaml defines no such path. "+
			"The contract currently declares only GET /catalog and GET /inventory/balances. "+
			"Add the path and the Order schemas there FIRST, regenerate the TypeScript with "+
			"`bun run generate:types`, and only then add the handler — building the wire format "+
			"in code first would fork the contract and leave two sources of truth",
		path)
}
