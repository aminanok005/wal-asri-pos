// Package domain holds the money kernel: the two numeric types this system is
// allowed to do arithmetic with, and the VAT rule they exist to serve.
//
// ── WHY A SHARED KERNEL AND NOT A PER-MODULE COPY ─────────────────────────────
//
// docs/02-design/DOMAIN.md, "Money and tax rules", warns about exactly this
// failure mode: the VAT rule is currently encoded three times — in TypeScript
// (`features/sales/domain/tax.ts`), in the SQLite `CHECK` constraints of
// `0001_init.sql`, and in the domain tests — and the cross-language test
// `0001_init.sql — the schema agrees with sales/domain/tax.ts` exists purely to
// stop those copies drifting apart.
//
// A fourth copy, one per Go module, would be the same trap with a new address.
// `catalog` and `order` both need to move money, so there is ONE Go copy, in
// this package, and every module imports it. There is no `catalog/tax.go`.
//
// ── WHY THIS PACKAGE HAS NO usecase/ OR adapter/ ──────────────────────────────
//
// ARCHITECTURE-DEMO.md §3.2 gives every module `domain/ → usecase/ →
// adapter/{http,postgres}/`. This package is a deliberate, documented exception:
// it is a value-object library, not a business module. It has no application
// logic to orchestrate and it performs no I/O, so `usecase/` and `adapter/`
// would be two empty directories that imply a boundary this package does not
// have. The layer rule that actually matters — that no `domain/` may import a
// database, an HTTP framework, or `internal/*/usecase` — is enforced for real in
// internal/architecture/layers_test.go, which checks every module at once.
//
// ── THE TWO TYPES, AND WHY THERE IS NO THIRD ──────────────────────────────────
//
//	Satang    — MONEY. Integer count of satang (int64). ฿1 = 100 satang.
//	Quantity  — a physical amount, exact decimal with 3 places, carried as a
//	            scaled int64 (milli-units). NOT money.
//
// The distinction is not pedantry. `3 * 0.1 = 0.30000000000000004` in binary
// floating point, so a POS that drifts a fraction of a satang per line cannot
// reconcile at end of shift. Money is therefore never a float here, and
// neither is quantity: `2.500 kg` of flour is exactly representable as the
// integer 2500 milli-units, and only there.
//
// `float32` and `float64` appear nowhere in this package, and
// internal/architecture/layers_test.go fails the build if a money field ever
// grows one.
package domain

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// SatangPerUnit is satang in one whole baht: ฿1 = 100 satang, so ฿45.50 = 4550.
const SatangPerUnit int64 = 100

// MaxSafeSatang is the ceiling this kernel accepts: 2^53 - 1 satang, ฿90
// trillion.
//
// Its origin is a wire concern. When `Satang` was `type: integer, format: int64`
// on the wire, a value above 2^53-1 could not survive the hop to the TypeScript
// client as a `number`, and 2^53-1 satang is where a double stops carrying
// integers exactly. That hop is now closed — `Satang` travels as a quoted digit
// string and JavaScript never places it in the number type — so this is no longer
// a precision boundary.
//
// It is kept anyway, as a cheap sanity ceiling, and the reasoning for keeping it
// is the same one that justified adding it: the failure it prevents is silent.
// No single transaction in this system approaches ฿90 trillion, so a value above
// it means a unit error or a corrupted decode, and it is far better to reject it
// at the boundary than to carry it into a reconciliation that will not balance.
const MaxSafeSatang int64 = 1<<53 - 1

// Satang is MONEY — an integer count of satang.
//
// A distinct named type, never a bare int64, so that a count, a sequence
// number or a basis-point rate cannot be passed where an amount is expected
// without the compiler complaining. The Go counterpart of the `Money` value
// object in apps/pos-desktop/src/features/payments/domain/money.ts.
//
// The zero value is ฿0 and is valid. A Satang may be negative ONLY where the
// domain says so explicitly (a refund amount, a stock correction); an amount
// that is about to be taxed may not be — see SplitInclusiveVAT.
type Satang int64

// SatangOf converts a plain int64 into a Satang, refusing a value above or below
// the sanity ceiling MaxSafeSatang.
//
// Use it at the edges — a database column, a hand-written constant in a test.
// Inside the domain, prefer the named operations over passing raw integers
// around.
func SatangOf(v int64) (Satang, error) {
	if v > MaxSafeSatang {
		return 0, fmt.Errorf("money kernel: %d satang exceeds the ceiling MaxSafeSatang %d", v, MaxSafeSatang)
	}
	if v < -MaxSafeSatang {
		return 0, fmt.Errorf("money kernel: %d satang is below the ceiling -MaxSafeSatang %d", v, -MaxSafeSatang)
	}
	return Satang(v), nil
}

// MustSatang is SatangOf for compile-time-known constants. It panics on a value
// that could not be represented, which is a programming error rather than a
// runtime condition.
func MustSatang(v int64) Satang {
	s, err := SatangOf(v)
	if err != nil {
		panic(err)
	}
	return s
}

// Add returns a + b.
//
// It panics on overflow rather than wrapping. A POS that silently wraps a very
// large amount around to a negative receipt is worse than a crash, and the
// alternative — clamping — would be worse still, because it invents money.
func (s Satang) Add(b Satang) Satang {
	x, y := int64(s), int64(b)
	if (y > 0 && x > math.MaxInt64-y) || (y < 0 && x < math.MinInt64-y) {
		panic(fmt.Sprintf("money kernel: satang addition overflowed (%d + %d)", x, y))
	}
	return Satang(x + y)
}

// Sub returns a - b. Panics on overflow, for the same reason as Add.
func (s Satang) Sub(b Satang) Satang {
	x, y := int64(s), int64(b)
	if (y < 0 && x > math.MaxInt64+y) || (y > 0 && x < math.MinInt64+y) {
		panic(fmt.Sprintf("money kernel: satang subtraction overflowed (%d - %d)", x, y))
	}
	return Satang(x - y)
}

// IsNegative reports whether s is below zero.
func (s Satang) IsNegative() bool { return s < 0 }

// IsZero reports whether s is exactly ฿0.
func (s Satang) IsZero() bool { return s == 0 }

// String renders the amount as satang ("4550").
//
// Deliberately NOT ฿45.50. Formatting is a presentation concern and belongs in
// an adapter; DOMAIN.md's rendering rules for the client are explicit that
// `Intl.NumberFormat` must never touch money, because it reintroduces a float
// and makes the output depend on the machine's locale data. The server keeps
// the integer and lets the receipt layer format it.
func (s Satang) String() string { return strconv.FormatInt(int64(s), 10) }

// StringAsMajor renders "45.50" — the two-decimal form, WITHOUT a currency
// symbol. It is exact integer arithmetic: the satang value is divided by 100
// and the remainder is zero-padded, so no float is involved.
//
// Provided for logs and CLI diagnostics. The wire format stays the integer.
func (s Satang) StringAsMajor() string {
	neg := s < 0
	v := int64(s)
	if neg {
		v = -v
	}
	whole, frac := v/SatangPerUnit, v%SatangPerUnit
	var b strings.Builder
	if neg {
		b.WriteByte('-')
	}
	b.WriteString(strconv.FormatInt(whole, 10))
	b.WriteByte('.')
	fracText := strconv.FormatInt(frac, 10)
	b.WriteString(strings.Repeat("0", 2-len(fracText)))
	b.WriteString(fracText)
	return b.String()
}

// MarshalJSON emits a quoted decimal string, e.g. "4550".
//
// This is the contract's wire form: contracts/openapi.yaml types `Satang` as
// `type: string` with pattern `^(0|[1-9][0-9]*)$`. No decimal point, no
// currency symbol, and never a bare JSON number.
//
// Why a string when Go's int64 marshals losslessly? Because the wire is not Go.
// JSON has exactly one number type, and an unquoted satang literal reaches the
// TypeScript client as a `number`, where IEEE-754 carries integers exactly only
// to 2^53-1. Quoting takes the value out of the number type entirely, so
// TypeScript binds it as `string` and the `bigint` conversion inside the `Money`
// value object is the only way to do arithmetic on it — which is the guarantee
// we actually want, enforced by the type rather than by a convention.
//
// This is also a unification, not a new rule. Three existing readers already
// reject anything but canonical digits and enforce this exact pattern:
// `parse_satang` in apps/pos-desktop/src-tauri/src/commands.rs, `SATANG_PATTERN`
// in apps/pos-desktop/src/features/sales/infrastructure/tauriOfflineOrders.ts,
// and the `typeof(...) = 'integer'` CHECKs in 0001_init.sql. `Quantity` in this
// same package already marshals as a string for the same reason.
func (s Satang) MarshalJSON() ([]byte, error) {
	return []byte(strconv.Quote(s.String())), nil
}

// UnmarshalJSON accepts ONLY a quoted, canonical digit string.
//
// This is a guard, not a decoder. `encoding/json` would otherwise accept a bare
// `4550`, `"4550"`, `4550.0` and `4.55e3` for a Satang — four spellings of one
// value, three of which put a float into a system whose entire accounting
// argument is that floats never touch money. The contract admits exactly one
// spelling, so exactly one is accepted:
//
//	"0" "1" "4550"   accepted
//	"-1" "+1"         rejected, the pattern has no sign; signed money is SignedSatang
//	"007"             rejected, leading zeros are a second spelling of one value
//	"1.0" "4.55e3"    rejected, never a decimal or exponent form
//	"" " 1" "1 "      rejected, empty or padded
//	null              rejected, a money field is never null
//	4550              rejected, a bare JSON number is not the contract's form
//
// Rejecting the bare integer is deliberate even though it used to be this
// server's own wire form. Accepting both spellings during a migration would
// leave two clients disagreeing about whether a field is money-as-number or
// money-as-text, and that disagreement surfaces as a customer's total at close,
// not as a parse error.
func (s *Satang) UnmarshalJSON(b []byte) error {
	txt := strings.TrimSpace(string(b))
	if txt == "null" {
		return fmt.Errorf("money kernel: null is not a valid Satang")
	}
	if len(txt) < 2 || txt[0] != '"' || txt[len(txt)-1] != '"' {
		return fmt.Errorf(
			"money kernel: %s is not a valid Satang: money is transported as a quoted digit string "+
				"(contracts/openapi.yaml, schema Satang), never a bare JSON number", txt)
	}
	parsed, err := ParseSatang(txt[1 : len(txt)-1])
	if err != nil {
		return err
	}
	*s = parsed
	return nil
}

// ParseSatang converts the contract's wire spelling to a Satang.
//
// It accepts only canonical non-negative digits, which is the `Satang` schema's
// pattern `^(0|[1-9][0-9]*)$` implemented rather than merely documented. Every
// rejection is load-bearing: two clients that disagree about whether "007" is 7
// satang disagree about a customer's total, and that class of bug does not
// announce itself as a parse failure at the point of disagreement.
//
// A negative amount is refused here, and that is a scope limit rather than a
// claim that money cannot be negative. This type's Go domain is broader than the
// wire: a refund amount and a stock correction are legitimately negative, and
// `SatangOf` admits them. The contract models that with `SignedSatang`, which is
// a separate schema and a separate signed-money rule. Until the contract gives
// negative satang a home on the wire, refusing it here keeps this function from
// inventing one.
func ParseSatang(s string) (Satang, error) {
	if s == "" {
		return 0, fmt.Errorf("money kernel: empty string is not a valid Satang")
	}
	if !isCanonicalDigits(s) {
		return 0, fmt.Errorf(
			"money kernel: %q is not a valid Satang: expected canonical non-negative digits "+
				"matching ^(0|[1-9][0-9]*)$ — no sign, no leading zeros, no decimal point", s)
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("money kernel: %q is not a valid Satang: %w", s, err)
	}
	return SatangOf(v)
}

// isCanonicalDigits reports whether s is "0" or a digit string with no leading
// zero.
//
// Hand-written rather than delegated to a regexp so the hot path stays a single
// pass with no allocation, and so there is exactly one copy of this rule in the
// Go service.
func isCanonicalDigits(s string) bool {
	if s == "" {
		return false
	}
	if s == "0" {
		return true
	}
	if s[0] < '1' || s[0] > '9' {
		return false
	}
	for i := 1; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// ─────────────────────────────────────────────────────────────────────────────
// SignedSatang — the one signed money field
// ─────────────────────────────────────────────────────────────────────────────

// SignedSatang is the wire form of `rounding_adjustment_satang`, the ONLY signed
// money value in this service.
//
// Cash rounding moves the amount charged to the nearest value the drawer can
// actually pay, and that value sits on either side of the exact total: ฿45.53
// rounds up to ฿45.55 or down to ฿45.50, and both are ordinary. A
// non-negative representation could only express half of that, so a cashier
// rounding down would have to misreport the direction of the adjustment.
//
// ── WHY IT IS A SEPARATE TYPE, AND WHY IT IS NOT A STRING ─────────────────────
//
// A separate type, because the sign is a PERMISSION, not a convenience. `Satang`
// means "an amount that is not negative" throughout this service; widening its
// parser to accept `-` would let a negative price, a negative total or a negative
// tax through every call site, and those are all genuinely wrong. Only the
// rounding adjustment may go below zero, and only because it is a settlement of
// the tender rather than part of the price.
//
// NOT a string, unlike `Satang`, and that asymmetry is deliberate rather than an
// oversight. contracts/openapi.yaml defines:
//
//	Satang        type: string, pattern ^(0|[1-9][0-9]*)$
//	SignedSatang  type: integer, format: int64      (no pattern, no minimum)
//
// The reason is the 2^53 cliff. `Satang` is quoted so that JavaScript never places
// it in the number type. A signed satang can never approach 2^53 — a value that
// large is not a rounding adjustment, it is a unit error — so the reason for
// quoting does not apply, and the contract keeps it a plain integer.
//
// The wire form is therefore a BARE JSON integer: `MarshalJSON` writes `-3`, not
// `"-3"`. Do not "fix" this to match `Satan`: a client generated from the
// contract sends and expects the number.
type SignedSatang Satang

// Signed returns the underlying amount.
//
// Total, because the domain models the adjustment as an ordinary `Satang` — the
// domain already accepts a negative `Satan` for this one field, and widening the
// TYPE is what this package deliberately avoids.
func (s SignedSatang) Signed() Satang { return Satang(s) }

// String renders the signed decimal form, e.g. "-3".
func (s SignedSatang) String() string { return Satang(s).String() }

// MarshalJSON emits a bare JSON integer, per the contract's SignedS schema.
//
// Deliberately NOT quoted. See the type note.
func (s SignedSatang) MarshalJSON() ([]byte, error) {
	return []byte(Satang(s).String()), nil
}

// UnmarshalJSON accepts only a bare JSON integer in the canonical signed form.
//
// The mirror of `Satan.UnmarshalJSON`, and strict for the same reason: a guard,
// not a decoder. `encoding/json` would accept `3.0`, `3e0`, `"3"` and `03`, and
// the last of those is a second spelling of three.
//
//	-3    3    0    accepted
//	3.0   3e0  rejected, never a decimal or exponent form
//	"3"        rejected, a Satang is a bare integer here, not a quoted one
//	03         rejected, leading zeros are a second spelling of one value
//	+3         rejected, only '-' is canonical
//	-0         rejected, negative zero is a second spelling of zero
//	null       rejected, a money field is never null
func (s *SignedSatang) UnmarshalJSON(b []byte) error {
	txt := strings.TrimSpace(string(b))
	if txt == "null" {
		return fmt.Errorf("money kernel: null is not a valid SignedSatang")
	}
	// A quoted value is refused explicitly rather than by falling through, because
	// the message is the only thing that tells a client which of the contract's two
	// money schemas it used.
	if len(txt) >= 2 && txt[0] == '"' {
		return fmt.Errorf(
			"money kernel: %s is not a valid SignedSatang: rounding_adjustment_satang is a bare JSON "+
				"integer (contracts/openapi.yaml, schema SignedSatang), not a quoted string. A quoted "+
				"digit string is the Satang schema, which does not permit a sign", txt)
	}
	parsed, err := ParseSignedSatang(txt)
	if err != nil {
		return err
	}
	*s = SignedSatang(parsed)
	return nil
}

// ParseSignedSatang converts the contract's signed wire spelling to an amount.
//
// It accepts `-?(0|[1-9][0-9]*)$`. The unsigned half is validated by exactly the
// same `isCanonicalDigits` as `ParseSatang`, because a grammar that exists twice
// is a grammar that eventually disagrees with itself — and a disagreement here is a
// money field one caller accepts and another refuses.
func ParseSignedSatang(s string) (Satang, error) {
	digits := s
	negative := false
	if rest, ok := strings.CutPrefix(s, "-"); ok {
		negative, digits = true, rest
	}
	if digits == "" {
		return 0, fmt.Errorf("money kernel: %q is not a valid SignedSatang: it is a bare '-'", s)
	}
	if !isCanonicalDigits(digits) {
		return 0, fmt.Errorf(
			"money kernel: %q is not a valid SignedSatang: expected -?(0|[1-9][0-9]*)$ — no explicit plus, "+
				"no leading zeros, no decimal point", s)
	}
	if negative && digits == "0" {
		return 0, fmt.Errorf(
			"money kernel: %q is not a valid SignedSatang: negative zero is a second spelling of zero, send 0", s)
	}

	// Parse the whole string sign-and-all so that the magnitude of i64::MIN, which
	// is one larger than i64::MAX and cannot be held by a positive int64, is
	// accepted rather than reported as an overflow. It fits exactly.
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("money kernel: %q is not a valid SignedSatang: %w", s, err)
	}
	return SatangOf(v)
}

// DivRoundHalfUp divides a by b, rounding half away from zero.
//
// Half-UP, not banker's rounding: this is money and half-up is the commercial
// convention. A half-satang resolves toward the larger magnitude, so 4252.5
// becomes 4253 rather than 4252.
//
// Computed as `q = a/b; if 2*(a%b) >= b { q++ }` rather than `(a + b/2) / b`,
// because the short form double-rounds when b is odd. The remainder is always
// smaller than b, so `2*remainder` cannot overflow for any denominator this
// package uses. Both operands must share a sign for this to be a plain
// half-away-from-zero; SplitInclusiveVAT only ever calls it with non-negative
// values.
//
// The name says it, and it is a lint-level rule of this repository: no float,
// ever. `float64` is not used to divide, and neither is any library that
// divides in one.
func DivRoundHalfUp(a, b int64) (int64, error) {
	if b == 0 {
		return 0, fmt.Errorf("money kernel: division by zero")
	}
	negative := (a < 0) != (b < 0)
	if a < 0 {
		a = -a
	}
	if b < 0 {
		b = -b
	}
	q, r := a/b, a%b
	if 2*r >= b {
		q++
	}
	if negative {
		q = -q
	}
	return q, nil
}

// MulChecked multiplies two signed int64s and reports overflow instead of
// wrapping.
//
// The quantity × price product in an order line is the one place in this
// service where two large values meet, and a silent wrap there produces a
// negative line total that reads exactly like a refund.
func MulChecked(a, b int64) (int64, error) {
	if a == 0 || b == 0 {
		return 0, nil
	}
	c := a * b
	if c/b != a {
		return 0, fmt.Errorf("money kernel: %d x %d overflows int64", a, b)
	}
	return c, nil
}

// MulNonNegativeChecked multiplies a signed value by a non-negative one, and
// reports overflow instead of wrapping.
//
// The quantity × satang case: a Quantity may legitimately be negative (a
// reversed line, a stock correction) but a unit price never is, so the
// asymmetric guard below is both sufficient and easy to audit. Rejecting a
// negative multiplier outright is deliberate — it turns a category of bug into
// an error at the call site.
func MulNonNegativeChecked(a int64, b int64) (int64, error) {
	if b < 0 {
		return 0, fmt.Errorf("money kernel: non-negative operand required, received %d", b)
	}
	return MulChecked(a, b)
}
