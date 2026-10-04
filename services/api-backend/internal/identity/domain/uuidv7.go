// Package domain holds the UUIDv7 identifier used as every primary key in this
// system.
//
// ── WHY A SECOND SHARED KERNEL ────────────────────────────────────────────────
//
// `internal/money` is the first. This is the second, and it exists for the same
// reason with the same caveat: it is a value-object library with no application
// logic and no I/O, so it has `domain/` only and no `usecase/` or `adapter/`.
// The layer rule that matters is enforced for real in
// internal/architecture/layers_test.go.
//
// It could have lived inside `catalog` or `order`, but both need it, and an
// identifier that is generated two different ways in two modules is an
// identifier that eventually gets generated a third way somewhere nobody is
// reviewing.
//
// ── WHY THE IDs ARE CLIENT-GENERATED, AND WHY THAT IS THE WHOLE POINT ─────────
//
// SKILL.md §2.2: "All client-generated primary keys MUST be UUIDv7 (sortable,
// collision-free offline IDs)." contracts/openapi.yaml says the same in the
// `UuidV7` schema, and gives the reason: a terminal must be able to create a
// record while OFFLINE and still produce an identifier that sorts
// chronologically and does not collide across devices.
//
// A server-assigned serial would fail the first requirement — a terminal with
// no network cannot get one, so checkout would block. A random UUIDv4 would fail
// the second — it sorts arbitrarily, so an out-of-order sync produces an
// arbitrarily ordered catalogue and an index full of random page-breaks.
//
// UUIDv7 puts a 48-bit millisecond timestamp in the high bits, so lexical order
// IS chronological order. Two devices creating records within the same
// millisecond get distinct `rand_a` bits, and the remaining 62 bits of entropy
// separate the rest.
//
// The consequence the server has to respect: it may NEVER mint an id for a
// record the client created, and it may never rewrite one. It stores what it is
// given. That is also why `UUIDv7` here is only ever PARSED and VALIDATED — the
// GENERATION side lives in the client (TypeScript/Rust), and duplicating a
// generator in Go would be a second implementation of the same rule.
package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// canonicalLen is the length of the canonical 8-4-4-4-12 hyphenated form.
const canonicalLen = 36

// uuidVersion7 is the version nibble a UUIDv7 carries: the high nibble of the
// 13th hex digit.
const uuidVersion7 = '7'

// timeOffsetChars is where the 48-bit millisecond timestamp lives in the
// canonical form: the first 8-4 groups, i.e. 12 hex digits before the version
// nibble.
const timeOffsetChars = 12

// UUIDv7 is a validated UUID version 7.
//
// 16 bytes, comparable with `==`, and therefore usable as a map key and as a
// value in a set — which is what makes "did this order already arrive?" a
// one-line lookup rather than a string comparison loop.
//
// The zero value is NOT a valid UUIDv7 and `ParseUUIDv7` refuses it. There is
// no `NewUUIDv7` constructor on purpose; see the package note above.
type UUIDv7 [16]byte

// Zero is the nil identifier. It is exported so a caller can test for "not set"
// without writing sixteen zero bytes.
var Zero UUIDv7

// IsZero reports whether u is the nil identifier.
func (u UUIDv7) IsZero() bool { return u == Zero }

// Compare orders two UUIDv7 values byte-wise, returning -1, 0 or +1.
//
// Go does not define `<` for array types, so this is the ordering primitive and
// it has to be stated rather than inherited. It is byte-wise on the raw 16
// bytes, which is the right choice for two reasons:
//
//  1. Because UUIDv7 puts a 48-bit millisecond timestamp in the high bits, byte
//     order IS creation order — across devices, with no coordination. That is
//     SKILL.md §2.2's "sortable", and it is what makes an out-of-order sync
//     still produce a correctly ordered catalogue.
//  2. It agrees with Postgres. The `uuid` type compares byte-wise, so
//     `ORDER BY id` in SQL, a `LIMIT`/`OFFSET` page boundary and this method
//     all rank the same rows the same way. A different Go-side ordering would
//     make an application-side sort and a database-side sort disagree about
//     which page a row belongs to, and the bug would only appear on a table
//     larger than one page.
//
// Use it in a sort as `sort.Slice(x, func(i, j int) bool { return x[i].Compare(x[j]) < 0 })`.
func (u UUIDv7) Compare(other UUIDv7) int { return bytes.Compare(u[:], other[:]) }

// Before reports whether u was created before other, by UUIDv7 byte order.
// Cheap shorthand for `u.Compare(other) < 0` at a call site.
func (u UUIDv7) Before(other UUIDv7) bool { return u.Compare(other) < 0 }

// String renders the canonical hyphenated lower-case form.
func (u UUIDv7) String() string {
	var b strings.Builder
	b.Grow(canonicalLen)
	const hex = "0123456789abcdef"
	for i, c := range u {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			b.WriteByte('-')
		}
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&0x0f])
	}
	return b.String()
}

// UUID layout, as offsets into the canonical string.
//
// The hyphens make string position and nibble position different things, so the
// nibble offsets are derived rather than eyeballed. Groups are 8-4-4-4-12, so
// nibble 12 is the first hex digit of the third group and nibble 16 the first of
// the fourth. Both coincide with the byte layout RFC 4122 specifies — version in
// the high nibble of byte 6, variant in the high nibble of byte 8 — which is
// what lets Postgres, Go and JavaScript agree on every bit.
const (
	versionNibbleIndex = 12 // == byte 6, high nibble
	variantNibbleIndex = 16 // == byte 8, high nibble
)

// hyphenAt lists the string positions that carry a hyphen in the canonical form.
var hyphenAt = map[int]bool{8: true, 13: true, 18: true, 23: true}

// ParseUUIDv7 validates and parses the canonical hyphenated form.
//
// It is strict on purpose. This is an identifier that came off a device, and a
// lenient parser is how a 36-character string with a typo in it becomes a row
// nobody can find again. Rejected: the urn: and brace forms, upper case, a
// missing or extra hyphen, a version nibble other than 7, and a variant nibble
// outside 8..b.
//
// Every failure returns the zero UUID. A partially-filled value would be worse
// than a refusal: it looks like a real identifier, and a caller that logs it
// would record an id that never existed.
func ParseUUIDv7(s string) (UUIDv7, error) {
	var u UUIDv7

	if len(s) != canonicalLen {
		return Zero, fmt.Errorf(
			"identity: %q is not a UUIDv7: expected %d characters in canonical 8-4-4-4-12 form, got %d",
			s, canonicalLen, len(s))
	}

	// `nibble` counts hex digits independently of the string position, so the
	// hyphens at 8/13/18/23 cannot shift a digit into the wrong byte.
	nibble := 0
	for i := 0; i < canonicalLen; i++ {
		c := s[i]
		if hyphenAt[i] {
			if c != '-' {
				return Zero, fmt.Errorf(
					"identity: %q is not a UUIDv7: expected a hyphen at position %d, got %q", s, i, c)
			}
			continue
		}

		v, ok := hexVal(c)
		if !ok {
			return Zero, fmt.Errorf("identity: %q is not a UUIDv7: %q is not a hex digit", s, c)
		}
		// Canonical form is lower case, and it is the only accepted form.
		// Upper case is a legal RFC 4122 rendering but a DIFFERENT string, so
		// accepting it would mean two spellings of one key — and the uppercase
		// one would never be found by a lookup keyed on the lowercase one.
		if c >= 'A' && c <= 'F' {
			return Zero, fmt.Errorf(
				"identity: %q is not a canonical UUIDv7: upper-case hex is not accepted, want lower case", s)
		}
		switch nibble {
		case versionNibbleIndex:
			if c != uuidVersion7 {
				return Zero, fmt.Errorf(
					"identity: %q is not a UUIDv7: the version nibble is %q, want %q — "+
						"this system requires client-generated UUIDv7 so an offline terminal can "+
						"still produce a chronologically sortable key",
					s, c, uuidVersion7)
			}
		case variantNibbleIndex:
			// RFC 4122 variant bits 10, i.e. the nibble is one of 8, 9, a, b.
			if v < 8 || v > 0xb {
				return Zero, fmt.Errorf(
					"identity: %q is not a UUIDv7: the variant nibble is %q, want 8, 9, a or b", s, c)
			}
		}

		if nibble%2 == 0 {
			u[nibble/2] |= v << 4
		} else {
			u[nibble/2] |= v
		}
		nibble++
	}

	if nibble != 32 {
		return Zero, fmt.Errorf("identity: %q is not a UUIDv7: decoded %d hex digits, want 32", s, nibble)
	}
	if u.IsZero() {
		return Zero, fmt.Errorf("identity: the nil UUID is not a valid identifier")
	}
	return u, nil
}

// Time returns the millisecond timestamp embedded in the UUIDv7.
//
// This is the property that makes the type worth having: because the timestamp
// occupies the high 48 bits, sorting `UUIDv7` values with `<` gives creation
// order across devices, and `Time` gives the wall clock without a database
// round trip.
func (u UUIDv7) Time() time.Time {
	var ms int64
	for i := 0; i < timeOffsetChars/2; i++ {
		ms = ms<<8 | int64(u[i])
	}
	return time.UnixMilli(ms).UTC()
}

// MarshalJSON emits the canonical string, which is what the contract's `UuidV7`
// schema declares (`type: string, format: uuid`).
func (u UUIDv7) MarshalJSON() ([]byte, error) { return json.Marshal(u.String()) }

// UnmarshalJSON accepts only the canonical string form, and routes it through
// ParseUUIDv7 so a client cannot inject a v4 or a malformed id into a primary
// key column.
func (u *UUIDv7) UnmarshalJSON(b []byte) error {
	txt := strings.TrimSpace(string(b))
	if len(txt) < 2 || txt[0] != '"' || txt[len(txt)-1] != '"' {
		return fmt.Errorf(
			"identity: %s is not a valid UUIDv7: an identifier is transported as a string", txt)
	}
	parsed, err := ParseUUIDv7(txt[1 : len(txt)-1])
	if err != nil {
		return err
	}
	*u = parsed
	return nil
}

func hexVal(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	default:
		return 0, false
	}
}
