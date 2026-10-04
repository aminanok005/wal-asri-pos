// Command api is the composition root for the GreenTable POS backend.
//
// ARCHITECTURE-DEMO.md §3.2 gives it exactly one job: "Composition root — Wiring
// / DI", at `cmd/api/main.go`. It is the ONLY package permitted to import both a
// use case and an adapter, and internal/architecture/layers_test.go enforces that
// no domain package reaches it.
//
// ── WHY THIS PROGRAM STARTS AND SERVES A SMALL SURFACE ───────────────────────
//
// What is wired here today is `GET /catalog`, because that is the only endpoint
// contracts/openapi.yaml defines besides `GET /inventory/balances`. Everything else
// — the order ingest path, the outbox drain — has a complete, tested domain and
// use case and NO route, because the contract has no path for it. See
// internal/order/adapter/http for what the contract needs to gain.
//
// The alternative, wiring a speculative `/orders` handler, would fork the contract
// and leave two sources of truth for a JavaScript client to be generated from.
// SKILL.md §4's order is contract → generate types → implement, and this program
// is on step 3.
//
// ── WHAT IS DELIBERATELY ABSENT, AND WHY ──────────────────────────────────────
//
//	No database pool.   sqlc and goose are HELD (SKILL.md §3.2/§3.4) and
//	                    db/migrations is empty. The catalogue repository returns
//	                    ErrNotImplemented rather than an empty slice, and wiring it
//	                    would make the server answer 200 with an empty catalogue —
//	                    which a terminal would cache as authoritative and keep
//	                    serving all shift.
//	No auth middleware. It needs a device credential store that does not exist
//	                    yet. The contract's 401/403 are documented on the handler
//	                    and unimplemented on purpose: a handler inventing its own
//	                    weaker auth check is how a client-asserted branch id gets
//	                    trusted, which the contract calls out explicitly.
//	No outbox worker.   It needs a Postgres ledger and a destination.
//
// The failure mode when the catalogue is unserved is a loud 500 with a stable
// error code, chosen over a silent empty 200.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	cataloghttp "wal-asri-pos/services/api-backend/internal/catalog/adapter/http"
	cataloguc "wal-asri-pos/services/api-backend/internal/catalog/usecase"
	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
	orderhttp "wal-asri-pos/services/api-backend/internal/order/adapter/http"
	order "wal-asri-pos/services/api-backend/internal/order/domain"
	orderuc "wal-asri-pos/services/api-backend/internal/order/usecase"
	syncorder "wal-asri-pos/services/api-backend/internal/sync/adapter/order"
	syncdomain "wal-asri-pos/services/api-backend/internal/sync/domain"
	syncuc "wal-asri-pos/services/api-backend/internal/sync/usecase"
)

// version is stamped from the build, not from a constant that drifts.
// Set with `-ldflags "-X main.version=$(git rev-parse --short HEAD)"`.
var version = "dev"

func main() {
	if err := run(); err != nil {
		slog.Error("the api backend exited", "error", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		addr        = flag.String("addr", ":8080", "listen address; the client is a Tauri app on the same LAN")
		readTimeout = flag.Duration("read-timeout", 10*time.Second, "HTTP read timeout")
		// writeTimeout is generous because a full catalogue snapshot for a large
		// branch can be a few megabytes of JSON on a café uplink.
		writeTimeout = flag.Duration("write-timeout", 60*time.Second, "HTTP write timeout")
		idleTimeout  = flag.Duration("idle-timeout", 120*time.Second, "HTTP idle timeout")
	)
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	clock := func() time.Time { return time.Now().UTC() }

	// The clock is INJECTED into the use case, not called inside it. Two reasons:
	// the snapshot's `pulled_at` becomes the cursor the terminal resumes from, and
	// an assertion on that cursor must be exact rather than a tolerance — a sync
	// bug hides inside a tolerance.
	mux := http.NewServeMux()

	// ── catalog ───────────────────────────────────────────────────────────────
	//
	// The repository is intentionally NOT wired. See the package note. Until sqlc
	// and db/migrations exist, `GET /catalog` answers 500 with the stable code
	// `internal_error`, which is a visible outage rather than an empty menu.
	getCatalog := cataloguc.NewGetCatalog(unwiredCatalogRepository{}, clock)
	cataloghttp.NewHandler(getCatalog, clock).Route(mux)

	// ── sync ──────────────────────────────────────────────────────────────────
	//
	// `POST /sync/push` is IMPLEMENTED and its route is registered, because
	// contracts/openapi.yaml now declares it along with the Order, OrderLine and
	// sync schemas. The drain interactor is real, the batch idempotency and the
	// per-command outcomes are real, and the handler is exercised end to end by
	// internal/order/adapter/http's tests.
	//
	// What is NOT real is persistence. There is no store to commit an accepted
	// sale into, so the ingester refuses with a transient error rather than
	// pretending. That choice is the whole difference between this and the
	// catalogue's placeholder, and it is deliberate:
	//
	//	an empty slice / a silent 200  the terminal marks the sale done, prunes its
	//	                             outbox row, and the customer has paid for
	//	                             something the server will never have
	//	an error / a loud 500        the terminal keeps the row, retries with
	//	                             backoff, and the sale survives
	//
	// See internal/order/adapter/memory for the in-memory ports that prove the
	// success path, and internal/order/adapter/postgres for why the real driver
	// cannot be written yet: Go's standard library contains no PostgreSQL driver,
	// and adding one is outside what this service is permitted to depend on.
	ingest := orderuc.NewIngestOrder(orderuc.IngestOrderDeps{
		Orders: unwiredOrderRepository{},
		Rates:  unwiredBranchRates{},
		Idem:   unwiredIdempotencyStore{},
		Outbox: unwiredOutboxLedger{},
		Now:    clock,
	})
	drain := syncuc.NewDrainOutbox(syncuc.DrainDeps{
		Orders: syncorder.NewIngester(ingest),
		Idem:   unwiredBatchIdempotency{},
		Now:    clock,
	})
	orderhttp.NewHandler(drain, func() int64 { return clock().UnixNano() }).Route(mux)

	logger.Warn("POST "+orderhttp.BasePath+"/sync/push is routed but refuses every submission",
		"reason", "no persistence is wired: sqlc is HELD (SKILL.md 3.2/3.4), db/migrations is empty, "+
			"and the Go standard library contains no PostgreSQL driver",
		"implemented", "the drain interactor, batch idempotency, authoritative re-pricing and the HTTP handler",
		"proven_by", "internal/order/adapter/http + internal/sync/usecase tests against in-memory ports",
		"effect", "a terminal pushing a batch receives 500 and retries; no sale is acknowledged that was not stored")

	srv := &http.Server{
		Addr:         *addr,
		Handler:      mux,
		ReadTimeout:  *readTimeout,
		WriteTimeout: *writeTimeout,
		IdleTimeout:  *idleTimeout,
	}

	// Graceful shutdown, because the sync worker drains in-flight submissions and
	// a killed process leaves rows IN_FLIGHT that then have to be reconciled by
	// hand. SIGTERM from a container stop is the normal path.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		logger.Info("greentable pos api listening",
			"addr", *addr, "version", version, "base_path", cataloghttp.BasePath)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		logger.Info("shutting down; in-flight submissions stay IN_FLIGHT and are reclaimed by the ledger's retry")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	}
}

// unwiredCatalogRepository is a placeholder that refuses to serve.
//
// It exists so the composition root compiles and the route is registered — the
// handler's status mapping and parameter validation are worth having and testing
// NOW — while making the missing persistence impossible to overlook.
//
// It returns an error rather than an empty catalogue, and that distinction is the
// entire point. An empty slice would produce a well-formed 200 with
// `"variants": []`, which a terminal would cache as a complete snapshot and serve
// all shift with an empty menu. An error produces a 500 the operator sees.
type unwiredCatalogRepository struct{}

var errUnwired = errors.New(
	"catalog: no repository is wired. sqlc is HELD (SKILL.md §3.2/§3.4) and db/migrations " +
		"is empty, so there is no schema to generate against. This endpoint will answer 500 " +
		"until internal/catalog/adapter/postgres is implemented")

func (unwiredCatalogRepository) Categories(context.Context, identity.UUIDv7, *time.Time) ([]cataloguc.Category, error) {
	return nil, errUnwired
}
func (unwiredCatalogRepository) Products(context.Context, identity.UUIDv7, *time.Time) ([]cataloguc.Product, error) {
	return nil, errUnwired
}
func (unwiredCatalogRepository) Variants(context.Context, identity.UUIDv7, *time.Time) ([]cataloguc.ProductVariant, error) {
	return nil, errUnwired
}
func (unwiredCatalogRepository) PriceListEntries(context.Context, identity.UUIDv7, *time.Time) ([]cataloguc.PriceListEntry, error) {
	return nil, errUnwired
}

// InterfaceCheck: the placeholder must satisfy the port, or the route registration
// above would not compile and the failure would point at the wrong file.
var _ cataloguc.CatalogRepository = unwiredCatalogRepository{}

// ── the sync placeholders ─────────────────────────────────────────────────────
//
// Every one of these refuses with errUnwired, and the drain turns that into
// ErrInfrastructure, which the handler maps to 500. So a terminal that pushes
// during this state is told "retry", it keeps its outbox row, and the sale is
// still there when persistence exists.
//
// They are checked against their ports for the same reason the catalogue's is:
// the route is registered now, so a port that drifts must fail HERE rather than
// at the first real write.

type unwiredOrderRepository struct{}

func (unwiredOrderRepository) Append(context.Context, order.Order) error { return errUnwired }

type unwiredBranchRates struct{}

func (unwiredBranchRates) VATRateBp(context.Context, identity.UUIDv7) (money.BasisPoints, error) {
	return 0, errUnwired
}

type unwiredIdempotencyStore struct{}

func (unwiredIdempotencyStore) Lookup(context.Context, syncdomain.IdempotencyKey) (*syncdomain.IdempotencyRecord, error) {
	return nil, errUnwired
}
func (unwiredIdempotencyStore) Save(context.Context, syncdomain.IdempotencyRecord) error {
	return errUnwired
}

type unwiredOutboxLedger struct{}

func (unwiredOutboxLedger) Append(context.Context, syncdomain.SyncOutboxItem) error {
	return errUnwired
}
func (unwiredOutboxLedger) TransitionTo(context.Context, identity.UUIDv7, syncdomain.OutboxState, time.Time) error {
	return errUnwired
}

// The drain's OrderIngester is the REAL adapter over the REAL interactor — only the
// four ports underneath it refuse. So a submission in this state travels the whole
// pipeline, reaches `rates.VATRateBp`, fails there as transient, and comes back as
// 500 with no sale acknowledged. The failure is where the missing dependency
// actually is, rather than a hand-written refusal at the edge that would go stale
// the moment a real store is wired in.

type unwiredBatchIdempotency struct{}

func (unwiredBatchIdempotency) Lookup(context.Context, syncdomain.IdempotencyKey) (*syncdomain.IdempotencyRecord, error) {
	return nil, errUnwired
}
func (unwiredBatchIdempotency) Save(context.Context, syncdomain.IdempotencyRecord) error {
	return errUnwired
}

var (
	_ orderuc.OrderRepository  = unwiredOrderRepository{}
	_ orderuc.BranchRateSource = unwiredBranchRates{}
	_ orderuc.IdempotencyStore = unwiredIdempotencyStore{}
	_ orderuc.OutboxLedger     = unwiredOutboxLedger{}
	_ syncuc.BatchIdempotency  = unwiredBatchIdempotency{}
)
