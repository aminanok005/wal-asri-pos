package postgres

import (
	"fmt"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
	order "wal-asri-pos/services/api-backend/internal/order/domain"
)

// rowScanner is satisfied by pgx.Row and pgx.Rows, so one scan function serves both
// the single-row Get and the line loop.
type rowScanner interface {
	Scan(dest ...any) error
}

// ─────────────────────────────────────────────────────────────────────────────
// How money crosses this boundary
// ─────────────────────────────────────────────────────────────────────────────
//
// EVERY satang column is read as int64 and converted through money.SatanOf. Two
// things this deliberately does not do:
//
//   - It never accepts a numeric or string column. The schema types satang as
//     BIGINT, so pgx hands over an int64 and a float cannot enter a money value on
//     the way out. Combined with the schema's CHECKs, one cannot enter on the way in
//     either.
//   - It never hands a raw int64 to the domain. `money.Satang` is a distinct type
//     precisely so that a count of satang cannot be passed where an amount is
//     expected, and dropping it here would undo the only enforcement that exists.
//
// TIMESTAMPTZ is converted to UTC at every scan, once, rather than at each use site.
// A TIMESTAMPTZ denotes different instants in different sessions' timezones, and the
// domain compares instants; converting here is what makes a stored order compare
// equal to the same order rebuilt in a test running in another timezone.

// scanOrder reads one orders row into the domain type.
//
// GrossSatang is RECOMPUTED as subtotal - discount rather than read, because the
// schema does not store a gross column: it is derived, and storing it would create a
// third representation free to disagree with the two it comes from.
//
// loyalty_points_earned is not read either — the domain `Order` has no such field.
// Reading it would mean inventing a home for it, and a column the domain cannot
// represent is better left to its DEFAULT than silently dropped on every write.
func scanOrder(row rowScanner) (order.Order, error) {
	var (
		o                        order.Order
		id, branchID, terminalID identity.UUIDv7
		staffID, diningTableID   *identity.UUIDv7
		customerID               *identity.UUIDv7
		oType, status, source    string
		subtotal, discount       int64
		taxable, tax             int64
		service, rounding, total int64
		vatRateBp                int64
		notes                    *string
		statusAt                 time.Time
		createdAt, updatedAt     time.Time
	)

	err := row.Scan(
		&id, &branchID, &terminalID, &staffID, &diningTableID, &customerID,
		&oType, &status, &source,
		&subtotal, &discount, &taxable, &tax,
		&service, &rounding, &total,
		&vatRateBp, &notes, &statusAt, &createdAt, &updatedAt,
	)
	if err != nil {
		return order.Order{}, fmt.Errorf("postgres: scanning an order row: %w", err)
	}

	// Converted through the money kernel rather than by casting, so every satang
	// column is validated on the way OUT of the database too. A value that somehow
	// got past the CHECKs fails here with a named error instead of propagating as a
	// plausible-looking amount.
	sub, err := satang("subtotal_satang", subtotal)
	if err != nil {
		return order.Order{}, err
	}
	disc, err := satang("discount_satang", discount)
	if err != nil {
		return order.Order{}, err
	}
	net, err := satang("taxable_satang", taxable)
	if err != nil {
		return order.Order{}, err
	}
	taxAmt, err := satang("tax_satang", tax)
	if err != nil {
		return order.Order{}, err
	}
	svc, err := satang("service_charge_satang", service)
	if err != nil {
		return order.Order{}, err
	}
	// THE SIGNED COLUMN. money.Satan accepts a negative value, which is the entire
	// reason this column is separate from the six above it.
	rnd, err := satang("rounding_adjustment_satang", rounding)
	if err != nil {
		return order.Order{}, err
	}
	tot, err := satang("total_satang", total)
	if err != nil {
		return order.Order{}, err
	}

	o.ID = id
	o.BranchID = branchID
	o.TerminalID = terminalID
	o.StaffUserID = staffID
	o.DiningTableID = diningTableID
	o.CustomerID = customerID
	o.Type = order.OrderType(oType)
	o.Status = order.OrderStatus(status)
	o.Source = order.OrderSource(source)
	o.StatusAt = statusAt.UTC()
	o.CreatedAt = createdAt.UTC()
	o.UpdatedAt = updatedAt.UTC()
	if notes != nil {
		o.Notes = *notes
	}

	gross := sub.Sub(disc)
	o.Totals = order.Totals{
		SubtotalSatang:           sub,
		DiscountSatang:           disc,
		GrossSatang:              gross,
		ServiceChargeSatang:      svc,
		RoundingAdjustmentSatang: rnd,
		TotalSatang:              tot,
		TaxSplit: money.TaxSplit{
			Gross:  gross,
			Net:    net,
			Tax:    taxAmt,
			RateBp: money.BasisPoints(vatRateBp),
		},
	}
	return o, nil
}

// scanLine reads one order_lines row into the domain type.
//
// `line_tax_satang` is selected but NOT mapped onto a domain field, and the reason
// is stronger than tidiness: the domain has no field for it at all.
// `order.LineTaxIsAlwaysZero` is a CONSTANT, which is a stronger statement than "a
// field we assert is zero" — there is no code path that could set it to anything
// else. Writing it back out would reintroduce a field that could be set.
func scanLine(row rowScanner) (order.OrderLine, error) {
	var (
		l                                order.OrderLine
		id, orderID, variantID           identity.UUIDv7
		quantityText                     string
		unitPrice, lineDiscount, lineTax int64
		lineTotal                        int64
		sequence                         int32
		notes                            *string
		createdAt                        time.Time
	)

	if err := row.Scan(
		&id, &orderID, &variantID, &quantityText,
		&unitPrice, &lineDiscount, &lineTax,
		&lineTotal, &sequence, &notes, &createdAt,
	); err != nil {
		return order.OrderLine{}, fmt.Errorf("postgres: scanning an order line row: %w", err)
	}

	// NUMERIC(12,3) arrives as a string because that is how it was written, and is
	// re-parsed by the money kernel rather than by strconv — so the decimal grammar
	// has exactly one implementation in this service.
	qty, err := money.ParseQuantity(quantityText)
	if err != nil {
		return order.OrderLine{}, fmt.Errorf("postgres: line %s quantity %q: %w", id, quantityText, err)
	}
	up, err := satang("unit_price_satang", unitPrice)
	if err != nil {
		return order.OrderLine{}, err
	}
	ld, err := satang("line_discount_satang", lineDiscount)
	if err != nil {
		return order.OrderLine{}, err
	}
	lt, err := satang("line_total_satang", lineTotal)
	if err != nil {
		return order.OrderLine{}, err
	}

	l.ID = id
	l.OrderID = orderID
	l.ProductVariantID = variantID
	l.Quantity = qty
	l.UnitPriceSatang = up
	l.DiscountSatang = ld
	l.LineTotalSatang = lt
	l.Sequence = sequence
	l.CreatedAt = createdAt.UTC()
	if notes != nil {
		l.Notes = *notes
	}
	return l, nil
}

// satang converts one BIGINT column into the money kernel's type, naming the column
// in any failure.
//
// The name is the point. A bare "money kernel: 9007199254740992 exceeds the ceiling"
// does not say WHICH column was wrong, and this is the read path for a value that
// four other layers already agreed on.
func satang(column string, v int64) (money.Satang, error) {
	s, err := money.SatangOf(v)
	if err != nil {
		return 0, fmt.Errorf("postgres: order column %s: %w", column, err)
	}
	return s, nil
}
