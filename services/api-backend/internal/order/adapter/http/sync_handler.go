// Package http holds the order module's HTTP surface: `POST /api/v1/sync/push`,
// the offline outbox drain.
//
// The package note in ports.go used to say this module served nothing, because
// contracts/openapi.yaml declared only `GET /catalog` and `GET /inventory/balances`.
// The contract now declares `/sync/push` along with `Order`, `OrderLine` and the
// sync schemas, so the route exists and the file that documented the gap has been
// replaced by the route itself. `Routes` still exists so the composition root and
// the architecture test can see what this module serves.
//
// ── WHAT THE STATUS CODES MEAN HERE, AND WHY 200 IS NOT "EVERYTHING WENT WELL" ──
//
//	200  the batch was well-formed and processed. Some commands may still have been
//	     REJECTED, and the caller must read `results[].outcome` to find out.
//	400  the request itself is unusable: no Idempotency-Key, no terminal, an
//	     unparseable body, or a payload that is not an order.
//	500  the server could not complete the work.
//
// The 200-with-rejections case is the one worth stating plainly, because it looks
// like a bug and is not. `rejected` means PERMANENT: the payload is wrong and
// retrying it unchanged will fail identically. If a permanent refusal answered
// 400, a terminal draining a batch containing one malformed event would receive an
// error for the WHOLE batch, mark nothing done, and retry forever — never
// draining the good orders behind it. The per-command outcome exists precisely so
// that one bad event cannot block a shift's worth of real sales.
//
// And the inverse trap: a submission that fails because the DATABASE is briefly
// unreachable must never be reported as `rejected`. That would tell the terminal
// to give up on real money. The drain returns 500 for anything that is not a
// validation failure, so the terminal retries the intact batch.
package http

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	syncuc "wal-asri-pos/services/api-backend/internal/sync/usecase"
)

// BasePath is the contract's server URL prefix: `- url: /api/v1`.
const BasePath = "/api/v1"

// IdempotencyKeyHeader carries the client's key for this drain attempt.
//
// A header rather than a body field, and the contract says why: the server must be
// able to refuse a duplicate batch BEFORE parsing the body. A key that can only
// arrive inside a multi-megabyte payload cannot prevent the work it exists to
// prevent.
const IdempotencyKeyHeader = "Idempotency-Key"

// maxBodyBytes caps the request body.
//
// A drain batch is bounded by the terminal's outbox window, which is measured in
// orders, not megabytes. The cap is here so a malformed or hostile client cannot
// make the server buffer an unbounded body — this endpoint is reachable from a
// café uplink, and the whole point of the outbox is that a terminal catches up in
// batches rather than dumping a week of sales at once.
const maxBodyBytes = 8 << 20 // 8 MiB

// Routes is the set of routes this module serves.
var Routes = map[string]struct{}{
	"POST " + BasePath + "/sync/push": {},
}

// ─────────────────────────────────────────────────────────────────────────────
// Error envelope
// ─────────────────────────────────────────────────────────────────────────────

// errorBody is the contract's `Error` schema: `required: [code, message]`, where
// `code` is "a stable machine-readable string for branching" and `message` "is for
// humans and must not be parsed".
type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Stable error codes. Every code emitted here is a constant, because an ad-hoc
// string becomes a branch a client makes on a typo.
const (
	errBadRequest     = "bad_request"
	errMissingIdemKey = "idempotency_key_required"
	errInvalidBody    = "invalid_request_body"
	errInternal       = "internal_error"
	errUnimplemented  = "sync_not_wired"
)

func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errorBody{Code: code, Message: message})
}

// ─────────────────────────────────────────────────────────────────────────────
// The request body
// ─────────────────────────────────────────────────────────────────────────────

// pushRequest is the contract's `SyncPushRequest`.
//
// `Payload` stays `json.RawMessage` rather than a decoded struct: the contract
// deliberately types `SyncCommand.payload` as a free-form JSON object, because a
// terminal built against an older contract must be able to hand the server
// something the server recognises. Interpreting it is the order module's job, not
// this one's.
type pushRequest struct {
	TerminalID string        `json:"terminal_id"`
	Commands   []pushCommand `json:"commands"`
}

type pushCommand struct {
	ID             string          `json:"id"`
	AggregateType  string          `json:"aggregate_type"`
	AggregateID    string          `json:"aggregate_id"`
	EventType      string          `json:"event_type"`
	Action         string          `json:"action"`
	IdempotencyKey string          `json:"idempotency_key"`
	Payload        json.RawMessage `json:"payload"`
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

// Handler serves `POST /sync/push`.
//
// It holds the drain interactor, never a repository: the adapter depends on the
// application layer, not the other way round.
type Handler struct {
	drain *syncuc.DrainOutbox
	// now is injected so an assertion on `pushed_at` can be exact rather than a
	// tolerance — a sync bug hides inside a tolerance.
	now func() int64
}

// NewHandler wires the adapter.
func NewHandler(drain *syncuc.DrainOutbox, nowUnix func() int64) *Handler {
	if nowUnix == nil {
		nowUnix = func() int64 { return 0 }
	}
	return &Handler{drain: drain, now: nowUnix}
}

// Route registers the handler's routes on a mux, so the base path lives in exactly
// one place and cannot drift from the contract's declared server URL.
func (h *Handler) Route(mux *http.ServeMux) {
	mux.HandleFunc("POST "+BasePath+"/sync/push", h.PushSync)
}

// PushSync serves `POST /sync/push`.
func (h *Handler) PushSync(w http.ResponseWriter, r *http.Request) {
	// ── The header, before anything else ──────────────────────────────────────
	//
	// Checked FIRST and without reading the body, so a duplicate or keyless batch
	// costs the server nothing. That ordering is the whole reason the contract put
	// the key in a header.
	batchKey := r.Header.Get(IdempotencyKeyHeader)
	if batchKey == "" {
		writeError(w, http.StatusBadRequest, errMissingIdemKey,
			"the "+IdempotencyKeyHeader+" header is required. Without it a retried drain would be "+
				"applied a second time, selling the customer the same order twice")
		return
	}

	// ── The envelope ──────────────────────────────────────────────────────────
	body := http.MaxBytesReader(w, r.Body, maxBodyBytes)
	var req pushRequest
	dec := json.NewDecoder(body)
	if err := dec.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, errInvalidBody,
			"the request body is not a SyncPushRequest: "+err.Error())
		return
	}

	// Refuse TRAILING CONTENT, and the reason is silent data loss rather than
	// pedantry. `json.Decoder.Decode` reads exactly one JSON value and stops, so a
	// body of two concatenated batches decodes the first, ignores the second, and
	// answers 200. The terminal then marks its whole outbox acknowledged and the
	// sales in the second batch are gone — with nothing in any log, because from
	// the server's side the request succeeded.
	//
	// A terminal bug that concatenates, or a proxy that retries by re-sending the
	// buffered body, is exactly the shape that produces this. Refusing loudly turns
	// an invisible loss into a 400 the terminal will not clear.
	var trailing json.RawMessage
	if err := dec.Decode(&trailing); err != io.EOF {
		writeError(w, http.StatusBadRequest, errInvalidBody,
			"the request body contains more than one JSON document. Exactly one SyncPushRequest "+
				"must be sent per request: a second document would be silently ignored and the "+
				"orders in it lost while the terminal is told the batch was acknowledged")
		return
	}

	terminalID, err := identity.ParseUUIDv7(req.TerminalID)
	if err != nil {
		writeError(w, http.StatusBadRequest, errBadRequest,
			"terminal_id must be a client-generated UUIDv7: "+err.Error())
		return
	}

	commands, err := toCommands(req.Commands)
	if err != nil {
		writeError(w, http.StatusBadRequest, errBadRequest, err.Error())
		return
	}

	// ── The drain ─────────────────────────────────────────────────────────────
	outcome, err := h.drain.Execute(r.Context(), syncuc.PushRequest{
		IdempotencyKey: batchKey,
		TerminalID:     terminalID,
		Commands:       commands,
	})
	if err != nil {
		h.writeDrainError(w, err)
		return
	}

	// ── 200 ───────────────────────────────────────────────────────────────────
	//
	// The bytes rendered by the use case, written verbatim. On a replay that is the
	// STORED response, so a retry receives the same answer it received the first
	// time rather than a freshly-shaped one.
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(outcome.Result.Response)
}

// writeDrainError maps a use-case error to the contract's status codes.
//
// The mapping is the load-bearing part of this adapter, because `rejected` and
// "could not reach the database" differ only in the Go error and differ completely
// in what the terminal must do next.
func (h *Handler) writeDrainError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, syncuc.ErrBatchIdempotencyRequired),
		errors.Is(err, syncuc.ErrBatchEnvelopeInvalid):
		writeError(w, http.StatusBadRequest, errBadRequest, err.Error())

	case errors.Is(err, syncuc.ErrInfrastructure):
		// 500, NOT a per-command rejection. The terminal must retry this batch
		// intact; telling it the sales are permanently refused would lose them.
		writeError(w, http.StatusInternalServerError, errInternal,
			"the batch could not be completed and must be retried unchanged: "+err.Error())

	default:
		writeError(w, http.StatusInternalServerError, errInternal, err.Error())
	}
}

// toCommands converts the wire commands into the drain's own type.
//
// The ORDER of the slice is preserved and load-bearing: a terminal drains its
// outbox in local sequence order, and replaying a `shift_opened` after the
// `shift_closed` that ended it would corrupt the till's day.
func toCommands(in []pushCommand) ([]syncuc.OrderCommand, error) {
	out := make([]syncuc.OrderCommand, 0, len(in))
	for i, c := range in {
		id, err := identity.ParseUUIDv7(c.ID)
		if err != nil {
			return nil, &syncuc.EnvelopeError{
				Field:  fmt.Sprintf("commands[%d].id", i),
				Reason: "must be a UUIDv7: " + err.Error(),
				Err:    err,
			}
		}
		aggregateID, err := identity.ParseUUIDv7(c.AggregateID)
		if err != nil {
			return nil, &syncuc.EnvelopeError{
				Field:  fmt.Sprintf("commands[%d].aggregate_id", i),
				Reason: "must be a UUIDv7: " + err.Error(),
				Err:    err,
			}
		}
		if c.IdempotencyKey == "" {
			return nil, &syncuc.EnvelopeError{
				Field: fmt.Sprintf("commands[%d].idempotency_key", i),
				Reason: "is required; without it this event cannot be deduplicated on its own " +
					"if it appears in two overlapping batches",
				Err: syncuc.ErrCommandRejected,
			}
		}
		out = append(out, syncuc.OrderCommand{
			CommandID:   id,
			AggregateID: aggregateID,
			ClientKey:   c.IdempotencyKey,
			Payload:     c.Payload,
		})
	}
	return out, nil
}
