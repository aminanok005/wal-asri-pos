package domain_test

import (
	"encoding/json"
	"strings"
	"testing"

	money "wal-asri-pos/services/api-backend/internal/money/domain"
)

// TestSignedSatangJSON_AcceptsTheCanonicalSignedForm pins the wire form of the one
// signed money field.
//
// The asymmetry with Satang is deliberate and this test exists to keep it that way:
// Satang is a QUOTED string, SignedSatang is a BARE integer. contracts/openapi.yaml
// says so — Satang is quoted because an unquoted value would reach JavaScript as a
// double and lose precision past 2^53, and a signed satang can never approach 2^53
// so the reason does not apply.
func TestSignedSatangJSON_AcceptsTheCanonicalSignedForm(t *testing.T) {
	type adjustment struct {
		Rounding money.SignedSatang `json:"rounding_adjustment_satang"`
	}

	for _, tc := range []struct {
		payload string
		want    int64
	}{
		{`{"rounding_adjustment_satang":0}`, 0},
		{`{"rounding_adjustment_satang":3}`, 3},
		{`{"rounding_adjustment_satang":-3}`, -3},
		// ฿45.53 rounded DOWN to ฿45.50 — the motivating case.
		{`{"rounding_adjustment_satang":-5}`, -5},
		// The sanity ceiling is ±2^53-1, the same bound Satang carries. A signed
		// satang is a rounding adjustment derived from cash denominations, so a
		// value at ฿90 trillion is a unit error rather than a rounding.
		{`{"rounding_adjustment_satang":9007199254740991}`, money.MaxSafeSatang},
		{`{"rounding_adjustment_satang":-9007199254740991}`, -money.MaxSafeSatang},
	} {
		var got adjustment
		if err := json.Unmarshal([]byte(tc.payload), &got); err != nil {
			t.Errorf("%s was rejected: %v", tc.payload, err)
			continue
		}
		if int64(got.Rounding) != tc.want {
			t.Errorf("%s decoded to %d, want %d", tc.payload, int64(got.Rounding), tc.want)
		}
	}
}

// TestSignedSatangJSON_RefusesEverySpellingOutsideTheContract is a guard, not a
// decoder.
//
// Each rejected form is a way for money to enter this service in a shape the
// contract does not describe. The quoted-string case is the one worth reading twice:
// `"-3"` is what a client would send if it generated from `Satan` instead of
// `SignedSatang`, and accepting both would leave two clients disagreeing about
// whether a rounding adjustment is text or a number.
func TestSignedSatangJSON_RefusesEverySpellingOutsideTheContract(t *testing.T) {
	type adjustment struct {
		Rounding money.SignedSatang `json:"rounding_adjustment_satang"`
	}

	for _, payload := range []string{
		`{"rounding_adjustment_satang":"-3"}`, // Satang's form, not SignedSatang's
		`{"rounding_adjustment_satang":"3"}`,
		`{"rounding_adjustment_satang":-3.0}`, // decimal
		`{"rounding_adjustment_satang":-3e0}`, // exponent
		`{"rounding_adjustment_satang":-03}`,  // leading zero
		`{"rounding_adjustment_satang":+3}`,   // explicit plus
		`{"rounding_adjustment_satang":-0}`,   // negative zero
		`{"rounding_adjustment_satang":null}`, // a money field is never null
		// Past the ±2^53-1 sanity ceiling that Satang also carries. A rounding
		// adjustment this large is a unit error, and accepting it would let one
		// absurd value run through the balance identities unchecked.
		`{"rounding_adjustment_satang":9223372036854775807}`,
		`{"rounding_adjustment_satang":-9223372036854775808}`,
	} {
		var got adjustment
		if err := json.Unmarshal([]byte(payload), &got); err == nil {
			t.Errorf("%s was accepted as SignedSatang %d; the contract's SignedS schema is a bare "+
				"integer, not a quoted string, with no sign form beyond a single leading '-'",
				payload, int64(got.Rounding))
		}
	}
}

// TestSignedSatangJSON_AQuotedValueExplainsWhichSchemaWasUsed: the message is the
// only thing that tells a client it generated from the wrong schema, so it has to
// name the right one.
func TestSignedSatangJSON_AQuotedValueExplainsWhichSchemaWasUsed(t *testing.T) {
	type adjustment struct {
		Rounding money.SignedSatang `json:"rounding_adjustment_satang"`
	}
	var got adjustment
	err := json.Unmarshal([]byte(`{"rounding_adjustment_satang":"-3"}`), &got)
	if err == nil {
		t.Fatal("a quoted value was accepted")
	}
	for _, want := range []string{"SignedSatang", "Satang", "bare JSON integer"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the error does not mention %q, so it cannot tell the client which contract "+
				"schema it used; got: %v", want, err)
		}
	}
}

// TestSignedSatangJSON_MarshalsAsABareInteger is the other half of the asymmetry:
// if this ever emits a quoted string, a client generated from the contract breaks.
func TestSignedSatangJSON_MarshalsAsABareInteger(t *testing.T) {
	type adjustment struct {
		Rounding money.SignedSatang `json:"rounding_adjustment_satang"`
	}
	encoded, err := json.Marshal(adjustment{Rounding: money.SignedSatang(-3)})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got, want := string(encoded), `{"rounding_adjustment_satang":-3}`; got != want {
		t.Errorf("encoded %s, want %s", got, want)
	}
}

// TestSignedSatang_ConvertsToSatangWithoutWideningAnything: the domain models the
// adjustment as an ordinary Satang, and this is the only conversion between them.
func TestSignedSatang_ConvertsToSatangWithoutWideningAnything(t *testing.T) {
	if got := money.SignedSatang(-3).Signed(); got != -3 {
		t.Errorf("Signed() = %d, want -3", got)
	}
	if got := money.SignedSatang(-3).String(); got != "-3" {
		t.Errorf("String() = %q, want %q", got, "-3")
	}
}

// TestSignedSatang_ReusesTheUnsignedDigitGrammar: both parsers share
// isCanonicalDigits, so a form one refuses the other must refuse too.
func TestSignedSatan_ReusesTheUnsignedDigitGrammar(t *testing.T) {
	for _, s := range []string{"", "00", "007", "-00", "-007", "+1", "1.0", "- 1", "1 ", "-1_000", "abc", "-abc"} {
		if _, err := money.ParseSignedSatang(s); err == nil {
			t.Errorf("ParseSignedSatang(%q) was accepted", s)
		}
	}
	for _, s := range []string{"0", "1", "-1", "4550", "-4550", "-3"} {
		if _, err := money.ParseSignedSatang(s); err != nil {
			t.Errorf("ParseSignedSatang(%q) was rejected: %v", s, err)
		}
	}
}

// TestSignedSatang_DoesNotWidenSatang: the sign exception is scoped to the one
// field. If Satang's parser ever accepts a sign, a negative price, total or tax
// becomes writable and every balance identity in the service is at risk.
func TestSignedSatang_DoesNotWidenSatang(t *testing.T) {
	type totals struct {
		Total money.Satang `json:"total_satang"`
	}
	for _, payload := range []string{
		`{"total_satang":-1}`,
		`{"total_satang":-4550}`,
		`{"total_satang":"-3"}`,
	} {
		var got totals
		if err := json.Unmarshal([]byte(payload), &got); err == nil {
			t.Errorf("%s was accepted as Satang %d; only rounding_adjustment_satang may be signed",
				payload, got.Total)
		}
	}
}
