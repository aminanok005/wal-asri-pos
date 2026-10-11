// Package order adapts the order module to the sync module's OrderIngester port.
//
// It exists because `internal/sync/usecase` may not import
// `internal/order/usecase` — internal/architecture/layers_test.go forbids one
// module's application layer from depending on another's. This package is the
// seam: it knows what an order is, and the drain does not.
//
// ── WHAT IT IS ACTUALLY RESPONSIBLE FOR ───────────────────────────────────────
//
// Two translations and one decision:
//
//  1. WIRE → DOMAIN. The payload's money fields are QUOTED DIGIT STRINGS, because
//     contracts/openapi.yaml types `Satang` as `type: string` with pattern
//     `^(0|[1-9][0-9]*)$`. The DTO below therefore declares them as
//     `money.Satang`, whose strict UnmarshalJSON refuses a bare JSON number, a
//     decimal, an exponent, a sign and a leading zero. That is not defensive
//     parsing — it is the single point where the contract's grammar is enforced on
//     this side, and reusing the money kernel means there is exactly one copy of
//     that grammar in Go.
//
//  2. ERROR → OUTCOME. This is where "permanent" is decided, and it is the most
//     consequential line in the package:
//
//     a `*orderuc.ValidationError`  → ErrCommandRejected → the terminal stops
//     anything else                      → ErrInfrastructure → the whole batch
//     fails and is retried intact
//
//     Getting that backwards is how a database outage turns into a day of lost
//     sales: the terminal is told the sales are permanently refused, marks them
//     `failed_permanent`, and never sends them again.
package order

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
	order "wal-asri-pos/services/api-backend/internal/order/domain"
	orderuc "wal-asri-pos/services/api-backend/internal/order/usecase"
	syncuc "wal-asri-pos/services/api-backend/internal/sync/usecase"
)

// Ingester implements syncuc.OrderIngester over orderuc.IngestOrder.
//
// Stateless. The terminal comes from the command, which the drain populates from
// the batch's authenticated terminal — so nothing about the submitting device is
// read out of the payload, where a client could assert it.
type Ingester struct {
	ingest *orderuc.IngestOrder
}

// NewIngester wires the adapter.
func NewIngester(ingest *orderuc.IngestOrder) *Ingester {
	return &Ingester{ingest: ingest}
}

// InterfaceCheck fails to compile if the port drifts from this type.
var _ syncuc.OrderIngester = (*Ingester)(nil)

// IngestOrder parses one pushed order and hands it to the authoritative pipeline.
//
// Note the argument: the command carries the command's own client key, and the
// ADAPTER passes it through untouched. Hashing it is the order module's business,
// because the hash is scoped to the ORDER's branch — not the terminal that pushed
// it — and getting that scope wrong would let two branches collide on a key.
func (i *Ingester) IngestOrder(ctx context.Context, cmd syncuc.OrderCommand) (syncuc.IngestOutcome, error) {
	if len(cmd.Payload) == 0 {
		return syncuc.IngestOutcome{}, rejected("empty_payload",
			"the command carries no payload; a push_order event without a body cannot be priced")
	}

	parsed, err := parseOrderPayload(cmd.Payload)
	if err != nil {
		return syncuc.IngestOutcome{}, err
	}

	result, err := i.ingest.Execute(ctx, orderuc.IngestRequest{
		IdempotencyKey: cmd.ClientKey,
		TerminalID:     cmd.TerminalID,
		Order:          parsed,
	})
	if err != nil {
		if errors.Is(err, orderuc.ErrDuplicateSubmission) {
			// SUCCESS. A prior outcome exists and is being replayed verbatim.
			return syncuc.IngestOutcome{
				OrderID:   result.OrderID,
				State:     result.State,
				Duplicate: true,
				Response:  []byte(result.Response),
			}, nil
		}
		if errors.Is(err, orderuc.ErrValidationFailed) {
			return syncuc.IngestOutcome{}, err
		}
		// Infrastructure: the database, a refused connection. NOT permanent.
		return syncuc.IngestOutcome{}, err
	}

	return syncuc.IngestOutcome{
		OrderID:  result.OrderID,
		State:    result.State,
		Response: []byte(result.Response),
	}, nil
}

// rejectionError is a permanent refusal: the payload is wrong, and retrying it
// unchanged will fail identically forever.
type rejectionError struct {
	Code   string
	Reason string
	Err    error
}

func (e *rejectionError) Error() string            { return e.Reason }
func (e *rejectionError) Unwrap() error            { return errors.Join(syncuc.ErrCommandRejected, e.Err) }
func (e *rejectionError) ValidationReason() string { return e.Code }

func rejected(code, reason string) error { return &rejectionError{Code: code, Reason: reason} }

// ─────────────────────────────────────────────────────────────────────────────
// The wire shape
// ─────────────────────────────────────────────────────────────────────────────

// orderBody is the contract's `Order`, at the subset the server needs in order to
// RE-PRICE it.
//
// Every `*_satang` field is `money.Satang`, so the contract's string grammar is
// enforced by the money kernel during Unmarshal. There is no `float64` and no
// `int64` money field anywhere below; internal/architecture/layers_test.go fails
// the build if one appears.
//
// The client's CLAIMED figures are carried, not trusted. `Totals.Validate()` is
// run on them by the interactor and a disagreement with the server's own pricing
// is a rejection, not a correction.
type orderBody struct {
	ID         string `json:"id"`
	BranchID   string `json:"branch_id"`
	TerminalID string `json:"terminal_id"`

	Type   string `json:"type"`
	Status string `json:"status"`
	Source string `json:"source"`

	SubtotalSatang           money.Satang       `json:"subtotal_satang"`
	DiscountSatang           money.Satang       `json:"discount_satang"`
	TaxableSatang            money.Satang       `json:"taxable_satang"`
	TaxSatang                money.Satang       `json:"tax_satang"`
	ServiceChargeSatang      money.Satang       `json:"service_charge_satang"`
	RoundingAdjustmentSatang money.SignedSatang `json:"rounding_adjustment_satang"`
	TotalSatang              money.Satang       `json:"total_satang"`
	// VatRateBp is the rate the TERMINAL used. Carried so a mismatch can be
	// REPORTED — the server re-prices at the BRANCH's rate regardless, so this
	// value never reaches the arithmetic.
	VatRateBp int64 `json:"vat_rate_bp"`

	CreatedAt string `json:"created_at"`

	Lines []lineBody `json:"lines"`
}

// lineBody is the contract's `OrderLine`, at the priced subset.
//
// `LineTaxSatang` is deliberately absent from this struct. It is pinned to 0 by
// the schema, there is no per-line VAT to carry, and accepting the field would
// imply the server might store a non-zero value.
type lineBody struct {
	ID                 string         `json:"id"`
	OrderID            string         `json:"order_id"`
	ProductVariantID   string         `json:"product_variant_id"`
	Quantity           money.Quantity `json:"quantity"`
	UnitPriceSatang    money.Satang   `json:"unit_price_satang"`
	LineDiscountSatang money.Satang   `json:"line_discount_satang"`
	LineTotalSatang    money.Satang   `json:"line_total_satang"`
	Sequence           int32          `json:"sequence"`
	CreatedAt          string         `json:"created_at"`
}

// parseOrderPayload turns one command's payload into a domain order.
//
// Every failure here is PERMANENT. The payload is either malformed — in which case
// retrying it unchanged produces the same bytes and the same failure — or it
// describes an order this server cannot price. There is no transient failure mode
// in parsing, so all of these are rejections rather than infrastructure errors.
func parseOrderPayload(payload []byte) (order.Order, error) {
	var body orderBody
	// json.Unmarshal is used (NOT DisallowUnknownFields). This means extra fields
	// in the payload are silently ignored. The contract's SyncCommand.payload is
	// typed as a free-form object (additionalProperties: true) so an old terminal
	// draining a queue written by a new build must be able to hand the server
	// something the server recognises. The ingester extracts only the fields it
	// needs to re-price; unknown fields are dropped without error.
	if err := json.Unmarshal(payload, &body); err != nil {
		return order.Order{}, rejected("malformed_payload",
			"the payload is not an order this server can read: "+err.Error())
	}

	id, err := identity.ParseUUIDv7(body.ID)
	if err != nil {
		return order.Order{}, rejected("invalid_order_id",
			"order.id must be a client-generated UUIDv7: "+err.Error())
	}
	branchID, err := identity.ParseUUIDv7(body.BranchID)
	if err != nil {
		return order.Order{}, rejected("invalid_branch_id", "order.branch_id must be a UUIDv7: "+err.Error())
	}
	terminalID, err := identity.ParseUUIDv7(body.TerminalID)
	if err != nil {
		return order.Order{}, rejected("invalid_terminal_id", "order.terminal_id must be a UUIDv7: "+err.Error())
	}

	lines := make([]order.OrderLine, 0, len(body.Lines))
	for i, l := range body.Lines {
		line, err := toLine(i, l)
		if err != nil {
			return order.Order{}, err
		}
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		return order.Order{}, rejected("empty_lines",
			"an order with no lines has no price; a zero total would be a rounding artefact rather than an amount")
	}

	// The CLAIMED totals, rebuilt through the domain constructor so the struct is
	// internally consistent by the time the interactor sees it. The claimed
	// subtotal is checked against the lines by order.Validate inside the
	// interactor; here it is only carried.
	claimed, err := order.NewOrder(
		id, branchID, terminalID,
		order.OrderType(body.Type),
		order.OrderSource(body.Source),
		lines,
		body.DiscountSatang, body.ServiceChargeSatang, body.RoundingAdjustmentSatang.Signed(),
		money.BasisPoints(body.VatRateBp),
		parseTime(body.CreatedAt),
	)
	if err != nil {
		return order.Order{}, rejected("unpriceable_order",
			"the order does not price as submitted: "+err.Error())
	}

	// The client's own figures, which are the ones re-validated against the
	// server's. Overwriting them with the server's would destroy the comparison
	// that makes a stale terminal detectable.
	claimed.Totals = order.Totals{
		SubtotalSatang:           body.SubtotalSatang,
		DiscountSatang:           body.DiscountSatang,
		GrossSatang:              body.SubtotalSatang.Sub(body.DiscountSatang),
		ServiceChargeSatang:      body.ServiceChargeSatang,
		RoundingAdjustmentSatang: body.RoundingAdjustmentSatang.Signed(),
		TotalSatang:              body.TotalSatang,
		TaxSplit: money.TaxSplit{
			Gross:  body.SubtotalSatang.Sub(body.DiscountSatang),
			Net:    body.TaxableSatang,
			Tax:    body.TaxSatang,
			RateBp: money.BasisPoints(body.VatRateBp),
		},
	}
	claimed.Status = order.OrderStatus(body.Status)
	claimed.CreatedAt = parseTime(body.CreatedAt)
	claimed.UpdatedAt = claimed.CreatedAt

	return claimed, nil
}

// toLine converts one wire line.
//
// The parent order id is taken FROM the line, not inherited: a line claiming a
// different order than the one it arrived in is a data error, and order.Validate
// rejects it. Substituting the parent's id here would hide exactly that.
func toLine(index int, l lineBody) (order.OrderLine, error) {
	lineID, err := identity.ParseUUIDv7(l.ID)
	if err != nil {
		return order.OrderLine{}, rejected("invalid_line_id",
			fmt.Sprintf("lines[%d].id must be a UUIDv7: %v", index, err))
	}
	variantID, err := identity.ParseUUIDv7(l.ProductVariantID)
	if err != nil {
		return order.OrderLine{}, rejected("invalid_variant_id",
			fmt.Sprintf("lines[%d].product_variant_id must be a UUIDv7: %v", index, err))
	}
	parent, err := identity.ParseUUIDv7(l.OrderID)
	if err != nil {
		return order.OrderLine{}, rejected("invalid_line_order_id",
			fmt.Sprintf("lines[%d].order_id must be a UUIDv7: %v", index, err))
	}

	return order.OrderLine{
		ID:               lineID,
		OrderID:          parent,
		ProductVariantID: variantID,
		Quantity:         l.Quantity,
		UnitPriceSatang:  l.UnitPriceSatang,
		DiscountSatang:   l.LineDiscountSatang,
		LineTotalSatang:  l.LineTotalSatang,
		Sequence:         l.Sequence,
		CreatedAt:        parseTime(l.CreatedAt),
	}, nil
}

// parseTime reads an RFC 3339 instant, defaulting to the epoch.
//
// A missing or malformed timestamp is NOT rejected. It is not money: it orders
// receipts, and a receipt with the wrong time is still a receipt for the right
// amount. Refusing the whole order over it would lose a real sale over a field
// that does not affect the balance.
func parseTime(s string) time.Time {
	if s == "" {
		return time.Unix(0, 0).UTC()
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Unix(0, 0).UTC()
	}
	return t.UTC()
}
