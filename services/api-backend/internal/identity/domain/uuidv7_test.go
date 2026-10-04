package domain

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func TestParseUUIDv7_RoundTripsThroughCanonicalForm(t *testing.T) {
	// The example from contracts/openapi.yaml.
	const canonical = "018f3c2a-7b41-7c3d-9e10-5a2b8c4d6e01"

	u, err := ParseUUIDv7(canonical)
	if err != nil {
		t.Fatalf("ParseUUIDv7(%q) returned an unexpected error: %v", canonical, err)
	}
	if got := u.String(); got != canonical {
		t.Errorf("round trip produced %q, want %q", got, canonical)
	}
	if u.IsZero() {
		t.Error("a parsed UUIDv7 must not report itself as zero")
	}
}

// TestParseUUIDv7_RejectsWhatItShould is the whole reason this parser is
// strict: every one of these is a 36-character string that a lenient parser
// would accept and turn into a primary key nobody can find again.
func TestParseUUIDv7_RejectsWhatItShould(t *testing.T) {
	tests := []struct {
		name string
		in   string
		why  string
	}{
		{
			name: "UUIDv4 is not a UUIDv7",
			in:   "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
			why:  "a v4 does not sort chronologically, which is the entire reason this system requires v7",
		},
		{
			name: "UUIDv1 is not a UUIDv7 either",
			in:   "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
			why:  "v1 is machine-scoped and does not carry the client's own clock",
		},
		{
			name: "the nil UUID",
			in:   "00000000-0000-0000-0000-000000000000",
			why:  "it is not a UUIDv7 and it sorts before every real record",
		},
		{
			name: "upper case is not canonical",
			in:   "018F3C2A-7B41-7C3D-9E10-5A2B8C4D6E01",
			why:  "canonical form is lower case; accepting both means two spellings of one key",
		},
		{
			name: "the urn: prefix",
			in:   "urn:uuid:018f3c2a-7b41-7c3d-9e10-5a2b8c4d6e01",
			why:  "a different serialization of the same value would compare unequal as a key",
		},
		{
			name: "the brace form",
			in:   "{018f3c2a-7b41-7c3d-9e10-5a2b8c4d6e01}",
			why:  "same reason as the urn: form",
		},
		{
			name: "no hyphens",
			in:   "018f3c2a7b417c3d9e105a2b8c4d6e01",
			why:  "not the canonical form the contract declares",
		},
		{
			name: "one hyphen in the wrong place",
			in:   "018f3c2a7-b41-7c3d-9e10-5a2b8c4d6e01",
			why:  "a typo in a hyphen is a different id, and must not silently parse",
		},
		{
			name: "a non-hex digit",
			in:   "018f3c2a-7b41-7c3d-9e10-5a2b8c4d6e0g",
			why:  "not a hex digit",
		},
		{
			name: "a bad variant nibble",
			in:   "018f3c2a-7b41-7c3d-1e10-5a2b8c4d6e01",
			why:  "the RFC 4122 variant bits must be 10",
		},
		{
			name: "empty",
			in:   "",
			why:  "a missing id is not a zero id",
		},
		{
			name: "trailing space",
			in:   "018f3c2a-7b41-7c3d-9e10-5a2b8c4d6e01 ",
			why:  "whitespace is not part of the canonical form",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseUUIDv7(tc.in)
			if err == nil {
				t.Fatalf("ParseUUIDv7(%q) was accepted as %s. %s", tc.in, got, tc.why)
			}
			if got != Zero {
				t.Errorf("a refused parse returned %s instead of the zero UUID", got)
			}
		})
	}
}

// uuidAt builds a canonical UUIDv7 string whose embedded timestamp is ts.
//
// The package deliberately exposes NO generator — SKILL.md §2.2 makes id
// generation the client's job, and a second generator in Go would be a second
// implementation of one rule. A TEST fixture still needs deterministic ids whose
// creation time it controls, so the construction lives here, in the test, where
// it cannot be reached from production code.
//
// Layout, per RFC 4122: a 48-bit unix-millisecond timestamp, then version 7,
// then rand_a, then the variant nibble 8, then rand_b. The timestamp therefore
// spans the whole first group AND the whole second group — 8 + 4 hex digits —
// before the version nibble appears. Only the timestamp varies here, so the
// fixture is reproducible.
func uuidAt(ts time.Time) string {
	ms := uint64(ts.UTC().UnixMilli())
	return fmt.Sprintf("%08x-%04x-71a2-8b3c-3c4d5e6f7089", ms>>16, ms&0xffff)
}

// TestUUIDv7_SortsChronologically is the property SKILL.md §2.2 is asking for.
//
// Two devices, generating at different moments, must produce keys where byte
// order is creation order. The timestamp is in the high 48 bits, so plain
// comparison gives it.
func TestUUIDv7_SortsChronologically(t *testing.T) {
	base := time.Date(2026, 10, 2, 9, 15, 0, 0, time.UTC)
	later := base.Add(5 * time.Second)

	earlierID, err := ParseUUIDv7(uuidAt(base))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	laterID, err := ParseUUIDv7(uuidAt(later))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if earlierID.Time().UTC() != base {
		t.Errorf("embedded timestamp = %s, want %s", earlierID.Time().UTC(), base)
	}
	if laterID.Time().UTC() != later {
		t.Errorf("embedded timestamp = %s, want %s", laterID.Time().UTC(), later)
	}
	if !earlierID.Before(laterID) {
		t.Errorf("%s should sort before %s; byte order must be creation order", earlierID, laterID)
	}
	if laterID.Before(earlierID) {
		t.Errorf("%s should not sort before %s", laterID, earlierID)
	}
	if earlierID.Compare(laterID) >= 0 {
		t.Error("Compare disagrees with Before")
	}
	if earlierID.Compare(earlierID) != 0 {
		t.Error("a value must compare equal to itself")
	}
	if earlierID.Time().After(laterID.Time()) {
		t.Error("Time() and comparison order disagree")
	}
}

// TestUUIDv7_ContractExampleParses pins the example used in
// contracts/openapi.yaml against this parser, so a future change that tightens
// or loosens validation cannot silently stop accepting the documented value.
//
// Note the embedded timestamp is 2024-05-03 — the example in the contract is a
// fixed literal, not a function of the dates quoted elsewhere in that file.
func TestUUIDv7_ContractExampleParses(t *testing.T) {
	const canonical = "018f3c2a-7b41-7c3d-9e10-5a2b8c4d6e01"

	u, err := ParseUUIDv7(canonical)
	if err != nil {
		t.Fatalf("the contract's own example %s does not parse: %v", canonical, err)
	}
	if got := u.String(); got != canonical {
		t.Errorf("round trip produced %q, want %q", got, canonical)
	}
	if u.IsZero() {
		t.Error("a parsed UUIDv7 must not report itself as zero")
	}
	want := time.UnixMilli(0x018f3c2a7b41).UTC()
	if !u.Time().Equal(want) {
		t.Errorf("embedded timestamp = %s, want %s", u.Time(), want)
	}
}

// TestUUIDv7_CompareIsTheSameAsCanonicalStringOrder pins the equivalence the
// Postgres adapter depends on: byte order and canonical-string order agree, so
// an ORDER BY in SQL and a sort in Go rank rows identically.
func TestUUIDv7_CompareIsTheSameAsCanonicalStringOrder(t *testing.T) {
	ids := []string{
		"018f3c2a-7b41-7c3d-9e10-5a2b8c4d6e01",
		"018f3c2b-7b41-7c3d-9e10-5a2b8c4d6e01",
		"018f3c2b-7b41-7c3d-9e11-5a2b8c4d6e01",
		"018fffff-ffff-7fff-bfff-ffffffffffff",
		"7fffffff-ffff-7fff-bfff-ffffffffffff",
	}
	parsed := make([]UUIDv7, len(ids))
	for i, s := range ids {
		u, err := ParseUUIDv7(s)
		if err != nil {
			t.Fatalf("unexpected error parsing %s: %v", s, err)
		}
		parsed[i] = u
	}
	for i := range parsed {
		for j := range parsed {
			got := parsed[i].Compare(parsed[j])
			var want int
			switch {
			case ids[i] < ids[j]:
				want = -1
			case ids[i] > ids[j]:
				want = 1
			}
			if got != want {
				t.Errorf("Compare(%s, %s) = %d, want %d", ids[i], ids[j], got, want)
			}
		}
	}
}

// TestUUIDv7_IsComparableAndUsableAsAMapKey is what makes "has this order
// already arrived?" a map lookup instead of a string loop.
func TestUUIDv7_IsComparableAndUsableAsAMapKey(t *testing.T) {
	seen := map[UUIDv7]string{}

	a, err := ParseUUIDv7("018f3c2a-7b41-7c3d-9e10-5a2b8c4d6e01")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	b, err := ParseUUIDv7("018f3c2b-7b41-7c3d-9e10-5a2b8c4d6e01")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	seen[a] = "first"
	seen[b] = "second"

	if len(seen) != 2 {
		t.Fatalf("map holds %d entries, want 2: two adjacent UUIDv7 values collided as keys", len(seen))
	}
	// Re-parsing the same string must produce an equal key, which is the whole
	// basis of idempotency dedup by id.
	again, err := ParseUUIDv7("018f3c2a-7b41-7c3d-9e10-5a2b8c4d6e01")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if seen[again] != "first" {
		t.Error("re-parsing an id did not find the existing map entry")
	}
}

func TestUUIDv7_JSONRoundTripsAsAString(t *testing.T) {
	const canonical = "018f3c2a-7b41-7c3d-9e10-5a2b8c4d6e01"

	encoded, err := json.Marshal(Zero)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	u, err := ParseUUIDv7(canonical)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	encoded, err = json.Marshal(u)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got, want := string(encoded), `"`+canonical+`"`; got != want {
		t.Errorf("encoded %s, want %s — the contract's UuidV7 schema is type: string, format: uuid", got, want)
	}

	var decoded UUIDv7
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if decoded != u {
		t.Errorf("round trip produced %s, want %s", decoded, u)
	}
}

// TestUUIDv7_UnmarshalJSONRunsTheSameGuards confirms the JSON boundary cannot be
// used to slip past validation.
func TestUUIDv7_UnmarshalJSONRunsTheSameGuards(t *testing.T) {
	for _, payload := range []string{
		`"3f2504e0-4f89-41d3-9a0c-0305e82c3301"`, // v4
		`018f3c2a-7b41-7c3d-9e10-5a2b8c4d6e01`,   // bare, not a string
		`"not-a-uuid"`,
		`null`,
	} {
		var u UUIDv7
		if err := json.Unmarshal([]byte(payload), &u); err == nil {
			t.Errorf("%s was accepted as UUIDv7 %s; the wire boundary runs the same validation as ParseUUIDv7",
				payload, u)
		}
	}
}
