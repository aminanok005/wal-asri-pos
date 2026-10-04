// Package domain holds the server-side sync outbox lifecycle and the
// idempotency-key dedup that guards it.
//
// ── WHAT THIS IS, PRECISELY ───────────────────────────────────────────────────
//
// The terminal has its OWN local outbox: `sync_outbox` in
// `apps/pos-desktop/src-tauri/migrations/0001_init.sql`, drained by the Rust
// worker over `/sync/push`. Its vocabulary is `pending | in_flight | done |
// failed_permanent`.
//
// This package is a DIFFERENT aggregate on the SERVER side: the ledger of what
// this server has accepted from every terminal, and where each submission stands.
// They are not two names for one thing, and conflating them would be a bug:
//
//	the local outbox   "has my terminal handed this to the network yet?"
//	the server ledger   "has this server durably accepted this submission?"
//
// A submission can leave the terminal's outbox (`done`) and still be `IN_FLIGHT`
// here, because the terminal's `done` means the server returned 2xx and the
// server's `IN_FLIGHT` may outlast a connection that dropped mid-commit.
//
// ── THE FOUR STATES ───────────────────────────────────────────────────────────
//
// PENDING → IN_FLIGHT → ACKNOWLEDGED
//
//	↘ CONFLICT_HELD
//
// PENDING        accepted and queued, not yet claimed by a worker
// IN_FLIGHT      claimed by a worker; the effect may or may not have committed
// ACKNOWLEDGED   durably committed; terminal may prune its copy
// CONFLICT_HELD  durably received but deliberately NOT applied, awaiting a human
//
// CONFLICT_HELD is the interesting one and the reason this is not a boolean.
// "Did it arrive?" and "did it take effect?" are different questions, and a sync
// system that collapses them either loses work or applies work twice. An order
// held for conflict is stored and inspectable — the sale HAPPENED on a terminal
// and the money is real — but it is not applied to the authoritative ledger until
// someone decides. Dropping it would lose a real sale; applying it blindly could
// double-count.
//
// ARCHITECTURE-DEMO.md §9 gives the reason an order would ever be held at all:
// "Orders: append-only, never edited, so no conflict." An ORDER is never held —
// there is nothing to reconcile. What gets held is a price or a stock balance,
// where the server wins by version and a client's stale write loses.
package domain

import (
	"fmt"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
)

// OutboxState is one of the four lifecycle states.
type OutboxState string

const (
	// StatePending means accepted and queued, not yet claimed.
	StatePending OutboxState = "PENDING"
	// StateInFlight means a worker has claimed it. The effect may or may not have
	// committed — that ambiguity is why the state exists and why a crash leaves a
	// row here rather than losing it.
	StateInFlight OutboxState = "IN_FLIGHT"
	// StateAcknowledged means durably committed. Only now may the terminal prune
	// its local copy.
	StateAcknowledged OutboxState = "ACKNOWLEDGED"
	// StateConflictHeld means durably received, deliberately not applied, awaiting
	// a human decision. The payload is preserved.
	StateConflictHeld OutboxState = "CONFLICT_HELD"
)

// stateRank gives the ordering used to reject a move that goes backwards.
//
// CONFLICT_HELD and ACKNOWLEDGED share the last rank because they are SIBLING
// terminal outcomes, not steps in a sequence: a held submission may be resolved
// into an applied one, and an acknowledged one is final. Neither is "further
// along" than the other, and a rank that pretended otherwise would refuse a
// legitimate conflict resolution.
var stateRank = map[OutboxState]int{
	StatePending:      0,
	StateInFlight:     1,
	StateAcknowledged: 2,
	StateConflictHeld: 2,
}

var knownState = map[OutboxState]bool{
	StatePending:      true,
	StateInFlight:     true,
	StateAcknowledged: true,
	StateConflictHeld: true,
}

// IsKnownState reports whether s is one of the four.
//
// Separate from stateRank because the map is also the authority for what a
// holder of a zero OutboxState means: an empty string is not PENDING, and
// defaulting it to PENDING would make an uninitialised row drainable.
func IsKnownState(s OutboxState) bool { return knownState[s] }

// IsTerminal reports whether no further transition is expected.
func (s OutboxState) IsTerminal() bool { return s == StateAcknowledged || s == StateConflictHeld }

// OutboxAction is what the submission asks the server to do.
//
// DOMAIN.md's `sync_action` column, verbatim: `push_order | push_shift |
// pull_catalog | pull_customers | pull_settings`.
type OutboxAction string

const (
	ActionPushOrder     OutboxAction = "push_order"
	ActionPushShift     OutboxAction = "push_shift"
	ActionPullCatalog   OutboxAction = "pull_catalog"
	ActionPullCustomers OutboxAction = "pull_customers"
	ActionPullSettings  OutboxAction = "pull_settings"
)

// SyncOutboxItem is one submission's row in the server-side ledger.
//
// Append-only in identity, mutable in state. The id, the action, the entity and
// the idempotency key are fixed the moment the submission is accepted; only the
// state, the attempt count and the last error change. That mirrors the terminal's
// `sync_outbox_append_only` trigger, which refuses any UPDATE that touches
// `idempotency_key` — "what happened cannot be rewritten, only delivered or
// retried". The same rule on this side stops a bug here from rewriting what a
// device said it did.
type SyncOutboxItem struct {
	ID identity.UUIDv7

	// EntityID is the record being pushed or pulled.
	EntityID identity.UUIDv7
	// EntityType names the record kind ("order", "shift", "catalog", …). Kept as
	// a string because the set of kinds is owned by DOMAIN.md, not by this
	// package, and inventing an enum here would fork it.
	EntityType string

	Action OutboxAction

	// IdempotencyKey is the duplicate-order interceptor. See IdempotencyKey.
	IdempotencyKey IdempotencyKey

	State OutboxState

	// AttemptCount is how many times delivery has been tried. It drives the
	// exponential backoff the client's sync worker uses and the alert threshold
	// here — an item that has failed many times is a support case, not a retry.
	AttemptCount int

	// LastError is for an operator. Never parsed by code — the contract is explicit
	// that `message` "is for humans and must not be parsed", and the same applies
	// here.
	LastError string

	// TerminalID is the device that submitted this. Derived from the device
	// credential on the wire, never asserted by the client — the contract is
	// explicit that "a client never asserts its own terminal identity".
	TerminalID identity.UUIDv7

	CreatedAt   time.Time
	DueAt       time.Time
	ProcessedAt *time.Time
}

// Validate checks an item on the way in.
func (i SyncOutboxItem) Validate() error {
	if i.ID.IsZero() {
		return fmt.Errorf("sync: the outbox item id is required")
	}
	if !IsKnownState(i.State) {
		return fmt.Errorf("sync: %q is not one of the four lifecycle states (PENDING, IN_FLIGHT, ACKNOWLEDGED, CONFLICT_HELD)", i.State)
	}
	if i.Action == "" {
		return fmt.Errorf("sync: outbox item %s has no action", i.ID)
	}
	if i.IdempotencyKey.IsZero() {
		return fmt.Errorf("sync: outbox item %s has no idempotency key; without one a duplicate submission cannot be recognised", i.ID)
	}
	if i.TerminalID.IsZero() {
		return fmt.Errorf("sync: outbox item %s has no terminal; it is derived from the device credential, never asserted", i.ID)
	}
	if i.AttemptCount < 0 {
		return fmt.Errorf("sync: outbox item %s has a negative attempt count %d", i.ID, i.AttemptCount)
	}
	return nil
}

// CanTransitionTo reports whether the item may move from i.State to next.
//
// Both terminal states are terminal. That is what makes the lifecycle safe under
// retry: a delivery that is retried after the server already acknowledged it
// cannot re-acknowledge, and the caller is expected to consult the idempotency
// store instead — which returns the ORIGINAL response, so a retry is harmless
// rather than an error.
func (i SyncOutboxItem) CanTransitionTo(next OutboxState) bool {
	if !IsKnownState(i.State) || !IsKnownState(next) {
		return false
	}
	if i.State.IsTerminal() {
		return false
	}
	return true
}

// TransitionTo returns a new item in state next, or an error.
//
// The receiver is not modified: a ledger row whose transition function can leave
// it half-applied is not a ledger. `now` is a parameter so the behaviour is
// testable and so `processed_at` is reproducible.
func (i SyncOutboxItem) TransitionTo(next OutboxState, now time.Time) (SyncOutboxItem, error) {
	if !IsKnownState(next) {
		return SyncOutboxItem{}, fmt.Errorf(
			"sync: %q is not one of the four lifecycle states (PENDING, IN_FLIGHT, ACKNOWLEDGED, CONFLICT_HELD)", next)
	}
	if !i.CanTransitionTo(next) {
		if i.State.IsTerminal() {
			return SyncOutboxItem{}, fmt.Errorf(
				"sync: outbox item %s is already %s and cannot move to %s; a duplicate submission "+
					"must be answered from the idempotency store, not by replaying the transition",
				i.ID, i.State, next)
		}
		return SyncOutboxItem{}, fmt.Errorf("sync: outbox item %s cannot move from %s to %s", i.ID, i.State, next)
	}

	moved := i
	moved.State = next
	if next.IsTerminal() {
		processed := now.UTC()
		moved.ProcessedAt = &processed
	}
	return moved, nil
}
