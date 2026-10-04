// Package usecase holds the sync module's application logic: the interactor that
// drains a terminal's outbox batch and reports what happened to every command.
//
// ── WHY THIS IS A MODULE AND NOT A LOOP IN THE HANDLER ────────────────────────
//
// "Take the array, loop over it, call the order ingester, collect the outcomes" is
// four lines of code, and it is exactly the kind of four lines that belongs in an
// application layer, because three of the decisions it has to make are business
// rules rather than mechanics:
//
//  1. ONE BAD COMMAND MUST NOT FAIL THE BATCH. A terminal's outbox drains in local
//     sequence order, and if a single malformed event took the whole batch down the
//     terminal would retry that batch forever and never drain any of it. The sale
//     is real and the money is taken; one bad event must not block the good ones.
//
//  2. `rejected` IS PERMANENT AND EVERYTHING ELSE IS NOT. This is the decision
//     that most easily loses real sales, so it is spelled out below at
//     `OutcomeRejected`.
//
//  3. THE BATCH ITSELF IS IDEMPOTENT, SEPARATELY FROM EACH COMMAND. See the two
//     levels at `DrainOutbox`.
//
// ── WHY THIS PACKAGE MAY NOT IMPORT `internal/order/usecase` ───────────────────
//
// It cannot, and internal/architecture/layers_test.go enforces it: "modules may
// not depend on another module's application layer". So this package declares its
// OWN `OrderIngester` port, in terms of its own types, and the implementation
// lives in `internal/sync/adapter/order`, which is permitted to know what an
// order is.
//
// That inversion is not ceremony. It is what keeps the batching rules — which are
// about the OUTBOX and are shared by every aggregate that ever drains through it —
// independent of the order module. When a shift drain arrives next, it plugs into
// the same port and none of the rules below change.
package usecase

import (
	"context"
	"errors"
	"fmt"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	sync "wal-asri-pos/services/api-backend/internal/sync/domain"
)

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

var (
	// ErrBatchEnvelopeInvalid means the request itself is malformed — no terminal,
	// no commands, an unparseable payload. The whole request is refused, because
	// there is nothing in it to apply.
	ErrBatchEnvelopeInvalid = errors.New("sync: the push request is malformed")

	// ErrBatchIdempotencyRequired means the Idempotency-Key header was absent.
	// A missing key is never treated as "a distinct submission": every keyless
	// batch would then collide with every other, and the second sale of the day
	// would be swallowed as a duplicate of the first.
	ErrBatchIdempotencyRequired = errors.New("sync: the Idempotency-Key header is required")

	// ErrCommandRejected means a command failed validation permanently. It is a
	// per-command outcome, not a request failure.
	ErrCommandRejected = errors.New("sync: the command failed validation and was rejected")

	// ErrInfrastructure means the server could not complete the work — the database
	// is unreachable, a connection is refused. Deliberately NOT a per-command
	// outcome: see `OutcomeRejected`.
	ErrInfrastructure = errors.New("sync: the submission could not be completed")
)

// EnvelopeError names the part of the request that is wrong, so a terminal's log
// says which field to fix rather than only that something was.
type EnvelopeError struct {
	Field  string
	Reason string
	Err    error
}

func (e *EnvelopeError) Error() string { return e.Field + ": " + e.Reason }
func (e *EnvelopeError) Unwrap() error { return errors.Join(ErrBatchEnvelopeInvalid, e.Err) }

// ─────────────────────────────────────────────────────────────────────────────
// Ports
// ─────────────────────────────────────────────────────────────────────────────

// OrderIngester accepts one pushed order and makes it authoritative.
//
// Implemented in `internal/sync/adapter/order`. The port takes the payload as
// OPAQUE BYTES on purpose: this package must not know an order's shape, and the
// contract deliberately types `SyncCommand.payload` as a free-form JSON object
// because an old terminal draining a queue written by a new build must be able to
// hand the server something the server recognises.
//
// Returning an error that wraps ErrCommandRejected marks a PERMANENT rejection.
// Any other error is treated as transient and fails the whole batch.
type OrderIngester interface {
	IngestOrder(ctx context.Context, cmd OrderCommand) (IngestOutcome, error)
}

// BatchIdempotency records the outcome of a whole drain attempt.
//
// Declared here rather than reused from `internal/order/usecase` for the same
// reason the ingester is: cross-module application-layer imports are forbidden.
// One Postgres type will satisfy both ports.
type BatchIdempotency interface {
	Lookup(ctx context.Context, key sync.IdempotencyKey) (*sync.IdempotencyRecord, error)
	Save(ctx context.Context, rec sync.IdempotencyRecord) error
}

// ─────────────────────────────────────────────────────────────────────────────
// Request and result types
// ─────────────────────────────────────────────────────────────────────────────

// OrderCommand is one drained outbox event, as this module sees it.
type OrderCommand struct {
	// CommandID correlates the result with the request. The contract requires
	// correlation BY ID rather than by index: a terminal drains concurrently, so
	// index `n` of the request is not guaranteed to come back at index `n`.
	CommandID identity.UUIDv7

	// AggregateID is the order this command is about.
	AggregateID identity.UUIDv7

	// TerminalID is the device that submitted the batch, carried on the command so
	// the adapter that implements OrderIngester needs no constructor state and so
	// the device is recorded from the batch's authenticated terminal rather than
	// from anything inside the payload.
	TerminalID identity.UUIDv7

	// ClientKey is the command's OWN idempotency key, in the clear. Hashed per
	// order by the ingester; this package never stores it.
	ClientKey string

	// Payload is the event body, opaque.
	Payload []byte
}

// IngestOutcome is what the order module did with one command.
type IngestOutcome struct {
	OrderID identity.UUIDv7
	// State is where the submission ended up. ACKNOWLEDGED, or CONFLICT_HELD when
	// the sale happened but its figures disagree with the server's.
	State sync.OutboxState
	// Duplicate reports that a prior outcome was replayed rather than the work
	// redone. A SUCCESS from the terminal's point of view.
	Duplicate bool
	// Response is the JSON to return for this command, already rendered by the
	// module that produced it.
	Response []byte
}

// Outcome is the contract's `SyncCommandOutcome`.
type Outcome string

const (
	// OutcomeApplied means the command was newly applied.
	OutcomeApplied Outcome = "applied"

	// OutcomeDuplicate means the command's key was already applied and the stored
	// answer was returned. This is a SUCCESS, not a failure.
	//
	// It is the normal outcome of a retry after a response was lost in flight, and
	// it is reported separately from `applied` for exactly one reason: a terminal
	// that treats it as a failure retries forever, against a queue it has already
	// drained. The terminal's own outbox has no `duplicate` state, so it will
	// never distinguish the two cases on its own.
	OutcomeDuplicate Outcome = "duplicate"

	// OutcomeRejected means the server will NEVER accept this command. The terminal
	// moves it to `failed_permanent` and stops trying.
	//
	// ── WHY ONLY VALIDATION MAY USE THIS ─────────────────────────────────────
	//
	// `rejected` is permanent, so it must mean permanent. A submission that fails
	// because the database was briefly unreachable is NOT rejected — it is
	// transient, and reporting it as rejected would tell the terminal to give up on
	// a real sale. That is the failure mode this enum exists to prevent: an outage
	// that silently discards every order pushed during it.
	//
	// So the rule is mechanical: an error wrapping ErrCommandRejected becomes a
	// per-command `rejected`; ANY other error fails the entire batch with
	// ErrInfrastructure and nothing is recorded, so the terminal retries the whole
	// batch once the server is healthy.
	OutcomeRejected Outcome = "rejected"
)

// CommandResult is the contract's `SyncCommandResult`, correlated by CommandID.
type CommandResult struct {
	CommandID identity.UUIDv7
	Outcome   Outcome
	// Code and Message are present only for a rejection. Code is the stable part
	// for branching; Message is for humans and must not be parsed — the contract is
	// explicit about that asymmetry.
	Code    string
	Message string
}

// PushRequest is one drain attempt.
type PushRequest struct {
	// IdempotencyKey is the `Idempotency-Key` HEADER, in the clear. It dedupes the
	// whole attempt and is hashed with the terminal id before storage.
	IdempotencyKey string

	// TerminalID is derived from the device credential by the adapter. A use case
	// never reads a terminal identity out of a body field, because a body field is
	// client-controlled.
	TerminalID identity.UUIDv7

	// Commands in the terminal's local outbox sequence order. Order is SEMANTIC:
	// replaying a `shift_opened` after the `shift_closed` that ended it would
	// corrupt the till's day, so this loop must not reorder them.
	Commands []OrderCommand
}

// PushResult is the contract's `SyncPushResponse`.
type PushResult struct {
	Results    []CommandResult
	Applied    int
	Duplicates int
	Rejected   int
	PushedAt   time.Time
	// Cursor is the newest server cursor after the batch. A terminal hands it to
	// its next incremental pull so it does not re-fetch what this push covered.
	Cursor string

	// Response is the rendered JSON, stored for a replay. Rendered HERE rather than
	// by the adapter for the reason `IngestOrder` renders its own: the value is
	// persisted for 24 hours and replayed verbatim, so a later change to the
	// adapter's format must not change what a retry returns.
	Response []byte
}

// IsReplay reports whether this result came from a stored prior outcome rather
// than from work done now.
type PushOutcome struct {
	Result PushResult
	// Replay is true when the stored response is being returned unchanged.
	Replay bool
}

// ─────────────────────────────────────────────────────────────────────────────
// The interactor
// ─────────────────────────────────────────────────────────────────────────────

// DrainOutbox applies a terminal's drained batch.
type DrainOutbox struct {
	orders   OrderIngester
	idem     BatchIdempotency
	now      func() time.Time
	cursorFn func(context.Context) (string, error)
}

// DrainDeps is the constructor's argument bundle, so adding a port does not
// change every call site's arity.
type DrainDeps struct {
	Orders OrderIngester
	Idem   BatchIdempotency
	Now    func() time.Time
	// Cursor reads the server's current sync cursor. Optional: a nil Cursor leaves
	// the response's `cursor` null, which the contract allows.
	Cursor func(ctx context.Context) (string, error)
}

// NewDrainOutbox wires the interactor.
func NewDrainOutbox(d DrainDeps) *DrainOutbox {
	nowFn := d.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	return &DrainOutbox{orders: d.Orders, idem: d.Idem, now: nowFn, cursorFn: d.Cursor}
}

// ── THE TWO LEVELS OF IDEMPOTENCY ─────────────────────────────────────────────
//
// They are not redundant, and conflating them is a real bug:
//
//	batch header key   dedupes THIS drain attempt. Lets the server refuse a
//	                   duplicate batch before parsing the body, which is why the
//	                   contract puts it in a header.
//	per-command key    dedupes ONE event. Two DIFFERENT batches can overlap — a
//	                   terminal with two workers — and the second batch's command
//	                   must not re-apply an event the first already applied.
//
// Removing the header level is survivable: every command is still deduplicated,
// and the batch is simply re-processed. Removing the per-command level is not: two
// overlapping batches double-apply every sale in the overlap.
//
// ── WHY THE BATCH KEY IS SCOPED TO THE TERMINAL ────────────────────────────────
//
// `DeriveIdempotencyKey` hashes `terminalID || clientKey`. Two terminals that
// happen to generate the same client key — a UUIDv7 collision is unlikely but a
// constant key from a buggy build is not — must not dedup against each other.
// They are separate devices with separate sales, and one terminal's batch must
// never be answered with the other's stored response.

// Execute drains one batch.
//
// The five steps, and the order is the design:
//
//  1. ENVELOPE. Refuse a request with no terminal or no key. Nothing is applied.
//
//  2. DEDUPLICATE THE BATCH. A live record means return the stored response and
//     parse nothing further.
//
//  3. APPLY, IN ORDER. Each command's outcome is independent; one rejection does
//     not stop the loop.
//
//  4. RENDER AND RECORD. The response is rendered here and stored, so a replay is
//     byte-identical.
//
//  5. RETURN. A batch containing rejections still returns 200 — see the note on
//     `OutcomeRejected` for why a permanent refusal is a successful drain.
func (d *DrainOutbox) Execute(ctx context.Context, req PushRequest) (PushOutcome, error) {
	now := d.now().UTC()

	// ── Step 1: the envelope ──────────────────────────────────────────────────
	if req.TerminalID.IsZero() {
		return PushOutcome{}, &EnvelopeError{
			Field:  "terminal_id",
			Reason: "a terminal must submit; it is derived from the device credential and never asserted by the client",
			Err:    ErrBatchIdempotencyRequired,
		}
	}
	batchKey, err := sync.DeriveIdempotencyKey(req.TerminalID.String(), req.IdempotencyKey)
	if err != nil {
		return PushOutcome{}, &EnvelopeError{
			Field:  "Idempotency-Key",
			Reason: "a batch key is required; without one a retried drain would be applied a second time",
			Err:    err,
		}
	}

	// An empty batch is a SUCCESS, not an error. Two workers on one terminal race,
	// and the loser sends nothing. Answering that with an error makes the terminal
	// back off against a queue it has already emptied.
	if len(req.Commands) == 0 {
		result := PushResult{
			Results:  []CommandResult{},
			PushedAt: now,
			Response: d.render(PushResult{Results: []CommandResult{}, PushedAt: now}),
		}
		return PushOutcome{Result: result}, d.record(ctx, batchKey, req.TerminalID, sync.StateAcknowledged, result.Response, now)
	}

	// ── Step 2: deduplicate the whole batch ───────────────────────────────────
	prior, err := d.idem.Lookup(ctx, batchKey)
	if err != nil {
		return PushOutcome{}, fmt.Errorf("%w: looking up the batch idempotency key: %w", ErrInfrastructure, err)
	}
	if sync.Decide(batchKey, prior, now) == sync.DecisionReplay {
		// Return the STORED RESPONSE, not a recomputed one. The commands in it
		// already happened; re-running the pricing today could produce a different
		// answer for sales that were already charged.
		//
		// The bytes are carried back on Result.Response so the adapter writes the
		// same body it wrote the first time. Returning an empty body here — a 200
		// with nothing in it — would be worse than an error: a terminal that
		// validates the response before clearing its outbox would see no
		// acknowledgement and retry forever.
		return PushOutcome{
			Result: PushResult{
				Response: []byte(prior.Response),
				PushedAt: prior.CreatedAt,
			},
			Replay: true,
		}, nil
	}

	// ── Step 3: apply, in order ───────────────────────────────────────────────
	results := make([]CommandResult, 0, len(req.Commands))
	var applied, duplicates, rejected int

	for _, cmd := range req.Commands {
		cmd.TerminalID = req.TerminalID
		outcome, err := d.orders.IngestOrder(ctx, cmd)
		if err != nil {
			if !errors.Is(err, ErrCommandRejected) {
				// Transient. Fail the WHOLE batch and record nothing, so the
				// terminal retries it intact rather than being told the sales in it
				// are permanently refused.
				return PushOutcome{}, fmt.Errorf("%w: command %s: %w", ErrInfrastructure, cmd.CommandID, err)
			}
			results = append(results, CommandResult{
				CommandID: cmd.CommandID,
				Outcome:   OutcomeRejected,
				Code:      rejectionCode(err),
				Message:   err.Error(),
			})
			rejected++
			continue
		}

		switch {
		case outcome.Duplicate:
			results = append(results, CommandResult{CommandID: cmd.CommandID, Outcome: OutcomeDuplicate})
			duplicates++
		case outcome.State == sync.StateConflictHeld:
			// Stored and inspectable, but NOT applied to the authoritative ledger.
			// It is reported as a rejection because from the terminal's side the
			// work is finished: an operator reconciles it, and retrying would only
			// produce the same disagreement.
			results = append(results, CommandResult{
				CommandID: cmd.CommandID,
				Outcome:   OutcomeRejected,
				Code:      "held_for_review",
				Message:   "the order was stored but its figures disagree with the branch's current VAT rate; an operator will reconcile it",
			})
			rejected++
		default:
			results = append(results, CommandResult{CommandID: cmd.CommandID, Outcome: OutcomeApplied})
			applied++
		}
	}

	// ── Step 4: render and record ─────────────────────────────────────────────
	result := PushResult{
		Results:    results,
		Applied:    applied,
		Duplicates: duplicates,
		Rejected:   rejected,
		PushedAt:   now,
	}
	if d.cursorFn != nil {
		cursor, err := d.cursorFn(ctx)
		if err != nil {
			return PushOutcome{}, fmt.Errorf("%w: reading the sync cursor: %w", ErrInfrastructure, err)
		}
		result.Cursor = cursor
	}
	result.Response = d.render(result)

	if err := d.record(ctx, batchKey, req.TerminalID, sync.StateAcknowledged, result.Response, now); err != nil {
		return PushOutcome{}, err
	}
	return PushOutcome{Result: result}, nil
}

// record stores the batch outcome so a retry replays rather than re-applies.
//
// A failure to store is NOT swallowed: the commands in this batch have already
// been applied, and a terminal that retries will hit each command's own
// idempotency key and be told `duplicate`. That is safe, but only if the operator
// knows the batch key is unrecorded, so the error names what state the world is in
// rather than returning a success that would be a lie.
func (d *DrainOutbox) record(
	ctx context.Context,
	key sync.IdempotencyKey,
	terminalID identity.UUIDv7,
	state sync.OutboxState,
	response []byte,
	now time.Time,
) error {
	rec, err := sync.NewIdempotencyRecord(key, terminalID, state, string(response), now)
	if err != nil {
		return fmt.Errorf("sync: building the batch idempotency record: %w", err)
	}
	if err := d.idem.Save(ctx, rec); err != nil {
		return fmt.Errorf("%w: the batch was applied but its idempotency record could not be saved "+
			"(%v); each command carries its own key, so a retry is deduplicated per event rather "+
			"than creating second orders", ErrInfrastructure, err)
	}
	return nil
}

// rejectionCode picks the stable code for a permanent rejection.
//
// Falls back to a generic code rather than an empty string, because the contract
// says `code` is "a stable machine-readable string for branching" and an empty one
// is a branch the client cannot make.
func rejectionCode(err error) string {
	var ve interface{ ValidationReason() string }
	if errors.As(err, &ve) {
		return ve.ValidationReason()
	}
	return "command_rejected"
}

// render produces the stored response bytes.
//
// Hand-rolled rather than `encoding/json` so the shape is visible in one place and
// cannot drift with a struct tag. The contract's `SyncPushResponse` is five scalar
// fields plus an array of three-field objects.
func (d *DrainOutbox) render(r PushResult) []byte {
	var b []byte
	b = append(b, `{"results":[`...)
	for i, r := range r.Results {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, `{"id":"`...)
		b = append(b, r.CommandID.String()...)
		b = append(b, `","outcome":"`...)
		b = append(b, r.Outcome...)
		b = append(b, '"')
		if r.Outcome == OutcomeRejected {
			b = append(b, `,"error_code":`...)
			b = appendJSONString(b, r.Code)
			b = append(b, `,"error_message":`...)
			b = appendJSONString(b, r.Message)
		}
		b = append(b, '}')
	}
	b = append(b, `],"applied":`...)
	b = appendInt(b, r.Applied)
	b = append(b, `,"duplicates":`...)
	b = appendInt(b, r.Duplicates)
	b = append(b, `,"rejected":`...)
	b = appendInt(b, r.Rejected)
	b = append(b, `,"pushed_at":"`...)
	b = append(b, r.PushedAt.UTC().Format(time.RFC3339Nano)...)
	b = append(b, '"')
	if r.Cursor != "" {
		b = append(b, `,"cursor":`...)
		b = appendJSONString(b, r.Cursor)
	} else {
		b = append(b, `,"cursor":null`...)
	}
	b = append(b, '}')
	return b
}

// appendInt writes a non-negative int without strconv, keeping this file's only
// imports the ones the logic needs.
func appendInt(b []byte, v int) []byte {
	if v == 0 {
		return append(b, '0')
	}
	var digits [20]byte
	i := len(digits)
	for v > 0 {
		i--
		digits[i] = byte('0' + v%10)
		v /= 10
	}
	return append(b, digits[i:]...)
}

// appendJSONString writes a minimal JSON string literal.
//
// Not a general escaper: it handles the two characters that can appear in a
// rejection message (quote and backslash) plus control characters, which is what
// an error string can contain. A general escaper would be a stdlib import for a
// case that cannot occur here.
func appendJSONString(b []byte, s string) []byte {
	b = append(b, '"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '"' || c == '\\':
			b = append(b, '\\', c)
		case c == '\n':
			b = append(b, '\\', 'n')
		case c == '\r':
			b = append(b, '\\', 'r')
		case c == '\t':
			b = append(b, '\\', 't')
		case c < 0x20:
			b = append(b, '\\', 'u', '0', '0',
				"0123456789abcdef"[c>>4], "0123456789abcdef"[c&0xf])
		default:
			b = append(b, c)
		}
	}
	return append(b, '"')
}
