package domain

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// ─────────────────────────────────────────────────────────────────────────────
// Quantity — an exact physical amount, NOT money
// ─────────────────────────────────────────────────────────────────────────────
//
// This type exists because the system has TWO different kinds of number and
// conflating them is how POS accounting goes wrong:
//
//	Satang    money. ฿45.50 = 4550. Integer count of satang. NEVER a decimal.
//	Quantity  a ratio.  2.500 kg of flour. Exact decimal, 3 places.
//
// A quantity legitimately needs a decimal point, and a JSON number would place
// it in binary floating point — the same drift the satang rule exists to
// prevent. contracts/openapi.yaml says so in the `Quantity` schema and carries
// it as a STRING for exactly that reason:
//
//	type: string
//	pattern: '^-?\d+(\.\d{1,3})?$'
//
// "As a string it round-trips exactly and is parsed into a scaled integer by the
// client." This is that scaled integer: a `Quantity` is an int64 count of
// MILLI-units, so `2.500` is 2500 and `0.005` is 5. Still no float.
//
// Which is why quantity is NOT represented with `shopspring/decimal`, even
// though SKILL.md §2.1 permits it for money. A 3-place fixed-scale integer is
// exactly what `decimal(10,3)` and `decimal(12,3)` already are in Postgres, so
// this representation costs nothing, needs no dependency, and cannot
// unexpectedly acquire a 28-digit precision the schema does not have.
//
// Negative values are legal: a stock balance may go negative when an offline
// terminal oversells (contract, `StockBalance.on_hand`), and a reversed order
// line is a correction rather than a new line.
//

// QuantityScale is the fixed number of decimal places a Quantity carries.
// 3 places is `decimal(10,3)` for an order line and `decimal(12,3)` for a stock
// balance — the schema column width differs, the precision does not.
const QuantityScale int64 = 1_000

// milliPerUnit is the reciprocal: how many milli-units make one whole unit.
// Derived from QuantityScale rather than written as a literal, so the two can
// never disagree.
const milliPerUnit = QuantityScale

// maxQuantityDigits is the whole-unit digit budget from `decimal(12,3)`:
// 12 digits of which 3 are the fraction, so 9 digits of whole units.
const maxQuantityWholeDigits = 9

// maxQuantityMilli is the largest representable quantity in milli-units:
// 999,999,999.999 → 999999999999 milli-units.
const maxQuantityMilli int64 = 999_999_999_999

// Quantity is an exact decimal quantity with 3 fractional digits, stored as a
// scaled int64.
//
// A distinct named type for the same reason Satang is one: a raw int64 of
// milli-units is meaningless without knowing it is a quantity, and it must never
// be passed where an amount of money is expected.
type Quantity struct {
	milli int64
}

// NewQuantityFromMilli builds a Quantity from a count of milli-units.
//
// For internal arithmetic and for constants in tests. A caller holding a decimal
// string — which is every caller at a boundary — wants ParseQuantity.
func NewQuantityFromMilli(milli int64) (Quantity, error) {
	if milli > maxQuantityMilli || milli < -maxQuantityMilli {
		return Quantity{}, fmt.Errorf(
			"money kernel: %d milli-units exceeds the decimal(12,3) range of +/-%d milli-units",
			milli, maxQuantityMilli)
	}
	return Quantity{milli: milli}, nil
}

// MustQuantityFromMilli is NewQuantityFromMilli for compile-time constants. It
// panics on a value outside the range, which is a programming error.
func MustQuantityFromMilli(milli int64) Quantity {
	q, err := NewQuantityFromMilli(milli)
	if err != nil {
		panic(err)
	}
	return q
}

// ParseQuantity reads an exact decimal string such as "2.500", "0.005", "-1.25".
//
// Strict by design, and it is the boundary this type exists for:
//
//   - 0, 1, 2 or 3 fractional digits accepted, matching the contract pattern
//     `^-?\d+(\.\d{1,3})?$`. A fourth is a unit-conversion bug, not a rounding
//     choice, so it is refused rather than truncated — silently turning
//     "0.0001" into "0.000" is how a recipe loses an ingredient.
//   - No exponent, no leading `+`, no whitespace, no empty fraction. Each of
//     those is a different spelling of a number that should have been
//     normalised upstream.
//   - The whole-unit digits are bounded by `decimal(12,3)`.
//
// The parse is pure integer arithmetic. `strconv.ParseFloat` is never called:
// "0.1" would come back as 0.1000000000000000055511151231257827, and the whole
// point of this package is that it does not.
func ParseQuantity(s string) (Quantity, error) {
	if s == "" {
		return Quantity{}, fmt.Errorf("money kernel: empty string is not a quantity")
	}
	if strings.ContainsAny(s, "eE+") {
		return Quantity{}, fmt.Errorf(
			"money kernel: %q is not a quantity: exponent and leading-plus forms are not accepted", s)
	}
	if strings.TrimSpace(s) != s {
		return Quantity{}, fmt.Errorf("money kernel: %q is not a quantity: surrounding whitespace is not accepted", s)
	}

	negative := false
	body := s
	if strings.HasPrefix(body, "-") {
		negative = true
		body = body[1:]
	}

	wholeText, fracText, hasFrac := strings.Cut(body, ".")
	if wholeText == "" {
		return Quantity{}, fmt.Errorf("money kernel: %q is not a quantity: no whole-unit digits", s)
	}
	if len(wholeText) > maxQuantityWholeDigits || !allDigits(wholeText) {
		return Quantity{}, fmt.Errorf(
			"money kernel: %q is not a quantity: whole part must be 1..%d digits", s, maxQuantityWholeDigits)
	}
	if hasFrac {
		if fracText == "" || len(fracText) > 3 || !allDigits(fracText) {
			return Quantity{}, fmt.Errorf(
				"money kernel: %q is not a quantity: fractional part must be 1..3 digits", s)
		}
	}

	milli, err := strconv.ParseInt(wholeText, 10, 64)
	if err != nil {
		return Quantity{}, fmt.Errorf("money kernel: %q is not a quantity: %w", s, err)
	}
	milli *= QuantityScale

	if hasFrac {
		// Scale the fraction to exactly 3 places: "5" is 500, "05" is 50, "005"
		// is 5. Written as a string zero-pad then a single ParseInt so the
		// integer never passes through a float.
		padded := fracText + strings.Repeat("0", 3-len(fracText))
		frac, err := strconv.ParseInt(padded, 10, 64)
		if err != nil {
			return Quantity{}, fmt.Errorf("money kernel: %q is not a quantity: %w", s, err)
		}
		milli += frac
	}

	if negative {
		milli = -milli
	}
	return NewQuantityFromMilli(milli)
}

// MustParseQuantity is ParseQuantity for string literals in code and tests. It
// panics on an invalid literal, which is a programming error rather than a
// runtime condition.
func MustParseQuantity(s string) Quantity {
	q, err := ParseQuantity(s)
	if err != nil {
		panic(err)
	}
	return q
}

// Milli returns the raw scaled int64. Intended for arithmetic and for a SQL
// driver that binds a number; it is not a display value — use String.
func (q Quantity) Milli() int64 { return q.milli }

// IsZero reports whether the quantity is exactly zero.
func (q Quantity) IsZero() bool { return q.milli == 0 }

// IsNegative reports whether the quantity is below zero.
func (q Quantity) IsNegative() bool { return q.milli < 0 }

// Add returns q + b.
func (q Quantity) Add(b Quantity) (Quantity, error) {
	return NewQuantityFromMilli(q.milli + b.milli)
}

// Sub returns q - b.
func (q Quantity) Sub(b Quantity) (Quantity, error) {
	return NewQuantityFromMilli(q.milli - b.milli)
}

// String renders the exact decimal with all 3 places: "2.500", "-0.500", "0.000".
//
// Always 3 places, always, because this is the round-trip form the contract's
// `Quantity` pattern expects and a receipt line that prints "2.5" next to
// "2.500" looks like a discrepancy. Integer arithmetic only: the milli value is
// divided and the remainder zero-padded.
func (q Quantity) String() string {
	neg := q.milli < 0
	v := q.milli
	if neg {
		v = -v
	}
	whole, frac := v/QuantityScale, v%QuantityScale
	fracText := strconv.FormatInt(frac, 10)
	return fmt.Sprintf("%s%d.%s", map[bool]string{true: "-", false: ""}[neg],
		whole, strings.Repeat("0", 3-len(fracText))+fracText)
}

// MultiplySatang prices a quantity of items at a unit price, in satang.
//
// This is the quantity × money bridge, and it is the single subtlest arithmetic
// in the order module. The two operands have different scales:
//
//	milli-units × satang-per-unit = milli-SATANG
//	milli-satang / 1000           = satang
//
// The division rounds HALF-UP, exactly as the VAT extraction does, and for the
// same commercial reason: a half-satang on a line total resolves upward.
//
// Worked example, quantity 0.005 of an item at ฿45.50:
//
//	milli  = 5
//	scaled = 5 × 4550 = 22750 milli-satang
//	result = round_half_up(22750 / 1000) = round_half_up(22.75) = 23 satang
//
// A negative quantity prices to a negative total, which is how a reversed line
// is represented. `unitPrice` must not be negative — that is a different kind
// of error and is refused rather than reinterpreted.
func (q Quantity) MultiplySatang(unitPrice Satang) (Satang, error) {
	if unitPrice < 0 {
		return 0, fmt.Errorf(
			"money kernel: unit price must not be negative, received %d satang", unitPrice)
	}
	// Guard the multiply rather than trusting it. The largest quantity
	// (999,999,999.999) times a ฿90 trillion ceiling is past int64, and a
	// silent wrap would produce a negative line total indistinguishable from a
	// refund.
	milliSatang, err := MulNonNegativeChecked(q.milli, int64(unitPrice))
	if err != nil {
		return 0, fmt.Errorf("money kernel: cannot price %s at %d satang: %w", q, unitPrice, err)
	}
	satang, err := DivRoundHalfUp(milliSatang, milliPerUnit)
	if err != nil {
		return 0, fmt.Errorf("money kernel: cannot price %s at %d satang: %w", q, unitPrice, err)
	}
	return Satang(satang), nil
}

// MarshalJSON emits the decimal STRING, never a JSON number.
//
// Inverting this would put a quantity into binary floating point on the client,
// which is the exact outcome the contract's `Quantity` schema is written to
// prevent. A Go Quantity is an integer, but the value it stands for is not, and
// the wire format must say so.
func (q Quantity) MarshalJSON() ([]byte, error) {
	return json.Marshal(q.String())
}

// UnmarshalJSON accepts ONLY a JSON string holding a decimal literal.
//
// A bare JSON number is refused even though it would be unambiguous for a
// whole-unit quantity, because `2.5` and `2.500` are the same value and only one
// spelling is in the contract. Accepting both would put the choice on whoever
// wrote the client, and the two spellings would round-trip to different strings.
func (q *Quantity) UnmarshalJSON(b []byte) error {
	txt := strings.TrimSpace(string(b))
	if txt == "null" {
		return fmt.Errorf("money kernel: null is not a valid Quantity")
	}
	if len(txt) < 2 || txt[0] != '"' || txt[len(txt)-1] != '"' {
		return fmt.Errorf(
			"money kernel: %s is not a valid Quantity: a quantity is transported as a decimal string, "+
				"never a JSON number, so it never enters binary floating point", txt)
	}
	parsed, err := ParseQuantity(txt[1 : len(txt)-1])
	if err != nil {
		return err
	}
	*q = parsed
	return nil
}

func allDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
