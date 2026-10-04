package domain

import (
	"fmt"
	"testing"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
)

var now = time.Date(2026, 10, 2, 9, 15, 0, 0, time.UTC)

func idAt(n int) identity.UUIDv7 {
	u, err := identity.ParseUUIDv7(uuidFor(now.Add(time.Duration(n) * time.Millisecond)))
	if err != nil {
		panic("test fixture is not a valid UUIDv7: " + err.Error())
	}
	return u
}

func uuidFor(ts time.Time) string {
	ms := uint64(ts.UTC().UnixMilli())
	return fmt.Sprintf("%08x-%04x-71a2-8b3c-3c4d5e6f7089", ms>>16, ms&0xffff)
}

func keyFor(t *testing.T, branchID, clientKey string) IdempotencyKey {
	t.Helper()
	k, err := DeriveIdempotencyKey(branchID, clientKey)
	if err != nil {
		t.Fatalf("DeriveIdempotencyKey(%q, %q) returned an unexpected error: %v", branchID, clientKey, err)
	}
	return k
}

func itemFixture(t *testing.T) SyncOutboxItem {
	t.Helper()
	k := keyFor(t, "branch-1", "order-abc-1")
	i := SyncOutboxItem{
		ID:             idAt(1),
		EntityID:       idAt(2),
		EntityType:     "order",
		Action:         ActionPushOrder,
		IdempotencyKey: k,
		State:          StatePending,
		TerminalID:     idAt(3),
		CreatedAt:      now,
		DueAt:          now,
	}
	if err := i.Validate(); err != nil {
		t.Fatalf("the outbox item fixture does not validate: %v", err)
	}
	return i
}

// ─────────────────────────────────────────────────────────────────────────────
// The four states
// ─────────────────────────────────────────────────────────────────────────────

func TestOutboxState_ThereAreExactlyFour(t *testing.T) {
	// Rule 4 of the architecture: PENDING, IN_FLIGHT, ACKNOWLEDGED, CONFLICT_HELD.
	// A fifth state would be a design change, so the count is asserted.
	want := []OutboxState{StatePending, StateInFlight, StateAcknowledged, StateConflictHeld}
	if len(knownState) != len(want) {
		t.Errorf("the lifecycle has %d states, want %d", len(knownState), len(want))
	}
	for _, s := range want {
		if !IsKnownState(s) {
			t.Errorf("%q should be a known state", s)
		}
	}
	for _, bogus := range []OutboxState{"", "pending", "DONE", "done", "failed_permanent", "conflict"} {
		if IsKnownState(bogus) {
			t.Errorf("%q was accepted. Note this is the SERVER ledger's vocabulary, deliberately "+
				"different from the terminal's local sync_outbox table (pending/in_flight/done/"+
				"failed_permanent) — they are different aggregates", bogus)
		}
	}
}

func TestOutboxState_EmptyIsNotPending(t *testing.T) {
	// An uninitialised zero value must not be drainable.
	if IsKnownState("") {
		t.Error("the empty state must not be a known state; defaulting it to PENDING would make " +
			"an uninitialised row drainable")
	}
	if StatePending.IsTerminal() {
		t.Error("PENDING is not terminal")
	}
	if !StateAcknowledged.IsTerminal() || !StateConflictHeld.IsTerminal() {
		t.Error("both ACKNOWLEDGED and CONFLICT_HELD are terminal outcomes")
	}
}

func TestSyncOutboxItem_HappyPathWalksTheLifecycle(t *testing.T) {
	i := itemFixture(t)

	claimed, err := i.TransitionTo(StateInFlight, now.Add(time.Second))
	if err != nil {
		t.Fatalf("PENDING -> IN_FLIGHT must be permitted: %v", err)
	}
	if i.State != StatePending {
		t.Error("TransitionTo mutated its receiver")
	}

	acked, err := claimed.TransitionTo(StateAcknowledged, now.Add(2*time.Second))
	if err != nil {
		t.Fatalf("IN_FLIGHT -> ACKNOWLEDGED must be permitted: %v", err)
	}
	if acked.ProcessedAt == nil {
		t.Fatal("an ACKNOWLEDGED item must carry processed_at; a terminal prunes its copy on the " +
			"strength of that field")
	}
	if !acked.ProcessedAt.Equal(now.Add(2 * time.Second)) {
		t.Errorf("processed_at = %s, want %s", acked.ProcessedAt, now.Add(2*time.Second))
	}
}

func TestSyncOutboxItem_HeldForConflictIsDurableAndTerminal(t *testing.T) {
	// The reason this lifecycle is not a boolean: an order held for conflict
	// HAPPENED and the money is real. It must be stored and inspectable, not
	// dropped — and not applied either.
	i := itemFixture(t)
	claimed, err := i.TransitionTo(StateInFlight, now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	held, err := claimed.TransitionTo(StateConflictHeld, now.Add(time.Second))
	if err != nil {
		t.Fatalf("IN_FLIGHT -> CONFLICT_HELD must be permitted: %v", err)
	}
	if held.State != StateConflictHeld {
		t.Errorf("state = %s, want CONFLICT_HELD", held.State)
	}
	if held.ProcessedAt == nil {
		t.Error("a held item is durably received and must carry processed_at")
	}

	// Terminal: a held item does not move again.
	if _, err := held.TransitionTo(StateAcknowledged, now.Add(2*time.Second)); err == nil {
		t.Error("CONFLICT_HELD -> ACKNOWLEDGED must be refused; resolving a held item is an " +
			"explicit human action, not a background transition")
	}
}

func TestSyncOutboxItem_RetryAfterAcknowledgementIsRefusedAndExplained(t *testing.T) {
	// This is the duplicate-submission path, and the error has to say what to do
	// instead — because the answer is NOT "retry harder", it is "ask the
	// idempotency store what I already got".
	i := itemFixture(t)
	claimed, err := i.TransitionTo(StateInFlight, now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	acked, err := claimed.TransitionTo(StateAcknowledged, now.Add(time.Second))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	_, err = acked.TransitionTo(StateAcknowledged, now.Add(10*time.Second))
	if err == nil {
		t.Fatal("an ACKNOWLEDGED item must not re-acknowledge")
	}
	if !contains(err.Error(), "idempotency") {
		t.Errorf("the error %q should point at the idempotency store, which is the actual remedy", err)
	}
}

func TestSyncOutboxItem_ValidateRequiresTheFieldsWithoutWhichNothingWorks(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*SyncOutboxItem)
		want   string
	}{
		{"no idempotency key", func(i *SyncOutboxItem) { i.IdempotencyKey = "" }, "idempotency key"},
		{"an unknown state", func(i *SyncOutboxItem) { i.State = "DONE" }, "four lifecycle states"},
		{"no terminal", func(i *SyncOutboxItem) { i.TerminalID = identity.Zero }, "terminal"},
		{"no id", func(i *SyncOutboxItem) { i.ID = identity.Zero }, "id is required"},
		{"no action", func(i *SyncOutboxItem) { i.Action = "" }, "no action"},
		{"a negative attempt count", func(i *SyncOutboxItem) { i.AttemptCount = -1 }, "negative attempt count"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			i := itemFixture(t)
			tc.mutate(&i)
			err := i.Validate()
			if err == nil {
				t.Fatalf("an item with %s was accepted", tc.name)
			}
			if !contains(err.Error(), tc.want) {
				t.Errorf("error %q does not mention %q", err, tc.want)
			}
		})
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency — the duplicate-order interceptor
// ─────────────────────────────────────────────────────────────────────────────

func TestDeriveIdempotencyKey_IsStableScopedAndWellFormed(t *testing.T) {
	a := keyFor(t, "branch-1", "order-abc-1")
	b := keyFor(t, "branch-1", "order-abc-1")
	if a != b {
		t.Error("the same client key in the same branch must derive the same digest; a retry " +
			"that derived a different key would create a duplicate order")
	}
	if !a.IsWellFormed() {
		t.Errorf("%q is not a well-formed SHA-256 hex digest", a)
	}

	// Scoped per branch: the same client key in two branches must not collide.
	other := keyFor(t, "branch-2", "order-abc-1")
	if other == a {
		t.Error("the same client key in a different branch derived the same digest; branches are " +
			"separate tenants for idempotency")
	}
}

// TestDeriveIdempotencyKey_RefusesAnEmptyKey is a guard, not a convenience.
//
// An empty key hashes to a stable value, so every empty-key submission in a
// branch would collide with every other one and the second sale of the day would
// be swallowed as a duplicate of the first.
func TestDeriveIdempotencyKey_RefusesAnEmptyKey(t *testing.T) {
	for _, empty := range []string{"", "   ", "\t", "\n"} {
		k, err := DeriveIdempotencyKey("branch-1", empty)
		if err == nil {
			t.Errorf("an empty client key %q was accepted and hashed to %q; every such submission "+
				"in a branch would then collide with every other", empty, k)
		}
		if !k.IsZero() {
			t.Errorf("a refused derivation returned the key %q instead of the zero value", k)
		}
	}
}

// TestIdempotencyKey_NeverExposesTheClientKey: there is no accessor for the
// original, and a hashed secret that gets logged is a hashed secret that leaks.
func TestIdempotencyKey_StringReturnsTheHashNotTheClientKey(t *testing.T) {
	const clientKey = "order-abc-1-super-secret"
	k := keyFor(t, "branch-1", clientKey)

	if contains(k.String(), clientKey) {
		t.Errorf("the stored key %q contains the client key verbatim", k)
	}
	if contains(k.String(), "branch-1") {
		t.Errorf("the stored key %q contains the branch id verbatim", k)
	}
	if k.String() != string(k) {
		t.Error("String() and the underlying value disagree")
	}
}

func TestIdempotencyKey_IsWellFormedRejectsTruncatedStoredValues(t *testing.T) {
	// A truncated or hand-edited column would simply never match a derived key,
	// which looks like "no duplicate found" and quietly defeats the mechanism.
	good := keyFor(t, "branch-1", "k")
	if !good.IsWellFormed() {
		t.Fatalf("a derived key must be well formed: %q", good)
	}
	for _, bad := range []IdempotencyKey{"", "short", good[:32], good + "f", "zz" + good[2:]} {
		if bad.IsWellFormed() {
			t.Errorf("%q was accepted as a stored idempotency key", bad)
		}
	}
}

func TestNewIdempotencyRecord_UsesTheDocumentedTwentyFourHourWindow(t *testing.T) {
	k := keyFor(t, "branch-1", "order-abc-1")
	entity := idAt(10)

	rec, err := NewIdempotencyRecord(k, entity, StateAcknowledged, `{"status":"ok"}`, now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := rec.ExpiresAt.Sub(rec.CreatedAt); got != DefaultIdempotencyTTL {
		t.Errorf("window = %v, want %v (DOMAIN.md's `expires_at` 24 h)", got, DefaultIdempotencyTTL)
	}
	if rec.IsExpiredAt(now) {
		t.Error("a record created now must not be expired now")
	}
	if !rec.IsExpiredAt(rec.ExpiresAt.Add(time.Millisecond)) {
		t.Error("a record must be expired one millisecond past its window")
	}
	if got := rec.RemainingTTL(now); got != DefaultIdempotencyTTL {
		t.Errorf("RemainingTTL = %v, want %v", got, DefaultIdempotencyTTL)
	}
	if got := rec.RemainingTTL(now.Add(48 * time.Hour)); got != 0 {
		t.Errorf("RemainingTTL after expiry = %v, want 0 — never negative", got)
	}

	// A malformed key must not be stored: it could never match a derived digest, so
	// the row would sit in the table looking protective while never matching.
	if _, err := NewIdempotencyRecord("not-a-digest", idAt(11), StateAcknowledged, "{}", now); err == nil {
		t.Error("a malformed idempotency key was accepted into the store")
	}
	if _, err := NewIdempotencyRecord(k, idAt(12), "DONE", "{}", now); err == nil {
		t.Error("an unknown state was accepted into the idempotency store")
	}
}

func TestDecide_ProceedReplayAndExpiry(t *testing.T) {
	k := keyFor(t, "branch-1", "order-abc-1")
	entity := idAt(20)
	rec, err := NewIdempotencyRecord(k, entity, StateAcknowledged, `{"order_id":"..."}`, now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// 1. No prior record: do the work.
	if got := Decide(k, nil, now); got != DecisionProceed {
		t.Errorf("with no prior record, Decide = %v, want DecisionProceed", got)
	}

	// 2. A live prior record: replay the stored response, do NOT redo the work.
	//    This is the duplicate-order interception.
	if got := Decide(k, &rec, now.Add(time.Minute)); got != DecisionReplay {
		t.Errorf("with a live prior record, Decide = %v, want DecisionReplay", got)
	}

	// 3. Even while the prior attempt is still IN_FLIGHT, a concurrent second
	//    submission must replay rather than create a second order.
	inFlight, err := NewIdempotencyRecord(k, entity, StateInFlight, "", now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := Decide(k, &inFlight, now.Add(time.Second)); got != DecisionReplay {
		t.Errorf("with a concurrent IN_FLIGHT record, Decide = %v, want DecisionReplay — "+
			"two terminals raced and the second submission must not become a second order", got)
	}

	// 4. An expired record protects against nothing and must not block a new sale.
	if got := Decide(k, &rec, rec.ExpiresAt.Add(time.Millisecond)); got != DecisionProceedAfterExpiry {
		t.Errorf("with an expired record, Decide = %v, want DecisionProceedAfterExpiry", got)
	}

	// 5. The boundary is the first expired instant: validity is [created_at,
	//    expires_at), the same half-open convention as PriceList.IsEffectiveAt. So a
	//    record is live one nanosecond before expires_at and expired AT it.
	if got := Decide(k, &rec, rec.ExpiresAt.Add(-time.Nanosecond)); got != DecisionReplay {
		t.Errorf("one nanosecond before expires_at, Decide = %v, want DecisionReplay", got)
	}
	if got := Decide(k, &rec, rec.ExpiresAt); got != DecisionProceedAfterExpiry {
		t.Errorf("exactly at expires_at, Decide = %v, want DecisionProceedAfterExpiry — validity "+
			"is [created_at, expires_at)", got)
	}
}

// TestDecide_ReplayNeverRerunsThePricing is the reason the original RESPONSE is
// stored rather than recomputed.
//
// Pricing depends on the branch's VAT rate at the moment of the original sale.
// Re-running the maths today could return a different total for an order that was
// already charged, and the terminal would then show the customer a number that
// does not match the receipt it printed hours ago.
func TestDecide_ReplayNeverRerunsThePricing(t *testing.T) {
	k := keyFor(t, "branch-1", "order-abc-1")
	rec, err := NewIdempotencyRecord(k, idAt(30), StateAcknowledged,
		`{"total_satang":4550,"tax_satang":298}`, now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if got := Decide(k, &rec, now.Add(12*time.Hour)); got != DecisionReplay {
		t.Fatalf("a 12-hour-old record must still replay, got %v", got)
	}
	if rec.Response != `{"total_satang":4550,"tax_satang":298}` {
		t.Errorf("the stored response was altered: %q", rec.Response)
	}
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return len(needle) == 0
}
