package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
)

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency — the duplicate-order interceptor
// ─────────────────────────────────────────────────────────────────────────────
//
// SKILL.md §2.2: "Sync Engine drains the `outbox_events` table to Go server's
// `/sync/push` with exponential backoff & idempotency verification."
//
// The delivery guarantee is AT-LEAST-ONCE and the effect must be
// EXACTLY-ONCE. ARCHITECTURE-DEMO.md ADR-002 states the pairing: "Transactional
// outbox + idempotency keys for sync — Exactly-once effect over at-least-once
// delivery."
//
// The gap those two sentences describe is why this type exists. A terminal on a
// café wifi submits an order; the server commits it; the response is lost on a
// NAT timeout the terminal cannot distinguish from a crash. The terminal retries
// with the SAME Idempotency-Key. Without a store of what it already answered,
// that retry is a SECOND order — a real duplicate, a real second charge, and a
// customer standing at the counter being asked to pay twice.
//
// So the contract on a retry is NOT "do it again". It is: **return the ORIGINAL
// response**. The retry is not an error; it is a successful no-op.
//
// ── WHY THE KEY IS HASHED ─────────────────────────────────────────────────────
//
// DOMAIN.md's `IdempotencyKey.key_hash`: "Hash of client key + tenant."
//
// Two reasons, both about not storing what we should not:
//
//  1. The key is client-supplied and therefore attacker-supplied. A raw key in an
//     index is a free lookup oracle for "does this key exist", and a client could
//     probe another tenant's keys. Hashing removes the correlation.
//  2. It bounds the indexed value. A key of arbitrary length would be stored,
//     indexed and compared verbatim; a fixed 32-byte digest is not.
//
// Hashed with SHA-256 rather than anything faster because there is no rate to
// defend against here — this is not a password — and because a truncated or
// reversible scheme would reintroduce the oracle above. The input includes the
// branch id so two branches cannot collide on a key that a client happened to
// reuse across tenants.
//

// IdempotencyKeyLength is the hex length of a SHA-256 digest.
const IdempotencyKeyLength = 64

// DefaultIdempotencyTTL is the 24-hour window from DOMAIN.md's `expires_at`.
//
// Long enough to cover an outage — a café whose router dies at 18:00 should
// still be deduplicated when it reconnects at 08:00 — and short enough that the
// table does not grow without bound. A key older than the window is treated as
// absent, which means an extremely late retry is applied as a new submission.
// That is a deliberate trade: at 24 hours the alternative is retaining every key
// forever, and a duplicate order arriving a day late is far less costly than an
// unbounded table. It is also nearly impossible in practice, because the client
// prunes its outbox on acknowledgement, which happens seconds after the commit.
const DefaultIdempotencyTTL = 24 * time.Hour

// IdempotencyKey is the HASHED form of a client-supplied key, scoped to a branch.
//
// Stored hashed, never in the clear — see the note above. The zero value means
// "no key", and a submission without one is refused rather than treated as a
// distinct submission, because that is the case with no duplicate protection at
// all.
type IdempotencyKey string

// IsZero reports whether the key is absent.
func (k IdempotencyKey) IsZero() bool { return k == "" }

// DeriveIdempotencyKey hashes a client key within a branch's scope.
//
// Returns an error for an empty client key. Refusing is the point: an empty key
// hashes to a stable value, so every empty-key submission in a branch would
// collide with every other one and the second sale of the day would be silently
// swallowed as a duplicate of the first. That is a much worse outcome than a
// rejected request.
//
// The branch id is included in the hashed input so the same client key used in
// two branches produces two unrelated digests. Branches are separate tenants for
// idempotency purposes: a ฿100 order in one café is not a duplicate of one in
// another.
func DeriveIdempotencyKey(branchID, clientKey string) (IdempotencyKey, error) {
	if strings.TrimSpace(clientKey) == "" {
		return "", fmt.Errorf(
			"sync: an idempotency key is required; without one a retried submission would be " +
				"applied a second time as a new order")
	}
	sum := sha256.Sum256([]byte(branchID + "\x00" + clientKey))
	return IdempotencyKey(hex.EncodeToString(sum[:])), nil
}

// String returns the hex digest.
//
// Exposes the HASH, never the client key. There is deliberately no accessor for
// the original: nothing in this service needs it, and an accessor is how a hashed
// secret eventually gets logged.
func (k IdempotencyKey) String() string { return string(k) }

// IsWellFormed reports whether the key looks like a SHA-256 hex digest.
//
// Checked when a key arrives from storage rather than from DeriveIdempotencyKey,
// so a truncated or hand-edited column is caught instead of simply never matching
// a derived key — which would look like "no duplicate found" and quietly defeat
// the whole mechanism.
func (k IdempotencyKey) IsWellFormed() bool {
	if len(k) != IdempotencyKeyLength {
		return false
	}
	for _, c := range k {
		switch {
		case c >= '0' && c <= '9':
		case c >= 'a' && c <= 'f':
		default:
			return false
		}
	}
	return true
}

// IdempotencyRecord is a stored prior outcome for one key.
//
// The stored RESPONSE is what makes a retry return the original answer rather
// than recomputing it. Re-running the business logic to produce a "consistent"
// second answer is wrong in a way that is not obvious: pricing depends on the
// branch's VAT rate at the moment of the ORIGINAL sale, so replaying the maths
// today could return a different total for an order that was already charged.
type IdempotencyRecord struct {
	Key IdempotencyKey

	// EntityID is what the original submission produced.
	EntityID identity.UUIDv7
	// State is the state the original submission reached, so a retry can tell
	// "applied and acknowledged" from "received and held for conflict".
	State OutboxState

	// Response is the original answer, replayed verbatim on a duplicate. Stored as
	// an opaque string because this domain package must not depend on an HTTP or
	// JSON type — the adapter owns that shape.
	Response string

	CreatedAt time.Time
	ExpiresAt time.Time
}

// IsExpiredAt reports whether the record is outside its window at t.
func (r IdempotencyRecord) IsExpiredAt(t time.Time) bool { return !t.Before(r.ExpiresAt) }

// RemainingTTL returns how long the record stays valid from t, never negative.
func (r IdempotencyRecord) RemainingTTL(t time.Time) time.Duration {
	d := r.ExpiresAt.Sub(t)
	if d < 0 {
		return 0
	}
	return d
}

// NewIdempotencyRecord builds a record with the default 24-hour window.
func NewIdempotencyRecord(key IdempotencyKey, entityID identity.UUIDv7, state OutboxState, response string, now time.Time) (IdempotencyRecord, error) {
	if !key.IsWellFormed() {
		return IdempotencyRecord{}, fmt.Errorf(
			"sync: %q is not a well-formed idempotency key; a key that cannot match a derived "+
				"digest would silently defeat duplicate detection", key)
	}
	if !IsKnownState(state) {
		return IdempotencyRecord{}, fmt.Errorf("sync: cannot record an idempotent outcome in state %q", state)
	}
	return IdempotencyRecord{
		Key:       key,
		EntityID:  entityID,
		State:     state,
		Response:  response,
		CreatedAt: now.UTC(),
		ExpiresAt: now.UTC().Add(DefaultIdempotencyTTL),
	}, nil
}

// IdempotencyDecision is what an ingest interactor should do about a submission.
//
// A three-way answer rather than a bool, because the three cases need three
// different responses and collapsing them loses exactly the information that
// matters:
//
//	Proceed             no prior record: do the work
//	Replay              a prior record exists: return its stored response, do NOT redo the work
//	ProceedAfterExpiry  the prior record is outside its window: treat as new, and replace it
type IdempotencyDecision int

const (
	// DecisionProceed means apply the submission.
	DecisionProceed IdempotencyDecision = iota
	// DecisionReplay means a prior outcome exists and must be returned verbatim.
	DecisionReplay
	// DecisionProceedAfterExpiry means the prior record aged out; proceed and overwrite.
	DecisionProceedAfterExpiry
)

// Decide reports what to do about a submission carrying key, given any record
// already stored under it.
//
// This is the whole duplicate-order interception in one function, and it is pure
// so it can be tested without a database.
//
// The order of the checks is load-bearing:
//
//  1. No record → proceed.
//  2. A record that has EXPIRED → proceed and overwrite. An expired record
//     protects against nothing; treating it as a duplicate would refuse a genuine
//     new sale because some key was reused years ago.
//  3. Otherwise → replay. Including when the prior attempt is still IN_FLIGHT,
//     which is the concurrent case: two terminals raced, one record exists, and
//     the second submission must NOT create a second order. Whether it was
//     applied or is still in progress, the answer to "what happened to my order"
//     is the same stored response.
func Decide(key IdempotencyKey, prior *IdempotencyRecord, now time.Time) IdempotencyDecision {
	if prior == nil {
		return DecisionProceed
	}
	if prior.IsExpiredAt(now) {
		return DecisionProceedAfterExpiry
	}
	return DecisionReplay
}
