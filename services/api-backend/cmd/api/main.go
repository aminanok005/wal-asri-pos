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
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	cataloghttp "wal-asri-pos/services/api-backend/internal/catalog/adapter/http"
	cataloguc "wal-asri-pos/services/api-backend/internal/catalog/usecase"
	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	inventorypostgres "wal-asri-pos/services/api-backend/internal/inventory/adapter/postgres"
	inventoryuc "wal-asri-pos/services/api-backend/internal/inventory/usecase"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
	orderhttp "wal-asri-pos/services/api-backend/internal/order/adapter/http"
	orderinventory "wal-asri-pos/services/api-backend/internal/order/adapter/inventory"
	postgres "wal-asri-pos/services/api-backend/internal/order/adapter/postgres"
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

	// ── sync, and the persistence it commits to ───────────────────────────────
	//
	// `POST /sync/push` is implemented and routed: contracts/openapi.yaml declares
	// it along with the Order, OrderLine and sync schemas, the drain interactor is
	// real, and the batch idempotency and per-command outcomes are real.
	//
	// What sits UNDER it is chosen here, and the choice is the important part:
	//
	//	real Postgres         DATABASE_URL is set. Sales are committed and the
	//	                      schema's CHECKs are the last line of defence.
	//	a LOUD refusal        DATABASE_URL is unset. Every submission fails 500, the
	//	                      terminal keeps its outbox row and retries, and nothing
	//	                      is ever acknowledged that was not stored.
	//
	// The in-memory adapters are NOT an option for the fallback. They are excellent
	// for tests and catastrophic in production: a process restart would take every
	// acknowledged sale with it, and nothing would say so.
	ingest, drainIdem, closePersistence, err := buildPersistence(clock, logger)
	if err != nil {
		return err
	}
	if closePersistence != nil {
		defer closePersistence()
	}

	drain := syncuc.NewDrainOutbox(syncuc.DrainDeps{
		Orders: syncorder.NewIngester(ingest),
		Idem:   drainIdem,
		Now:    clock,
	})
	orderhttp.NewHandler(drain, func() int64 { return clock().UnixNano() }).Route(mux)

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

// ── buildPersistence ───────────────────────────────────────────────────────────
//
// Chooses between real Postgres and a loud refusal, and returns the interactor plus
// the drain's idempotency port.
//
// A function rather than inline wiring because the two configurations have
// DIFFERENT TYPES for the same ports, and a caller that had to know which one it got
// would be a caller that could use the wrong one.
//
// ── WHY THE SCHEMA IS APPLIED HERE ────────────────────────────────────────────
//
// At startup, by the embedded runner, rather than by a separate `migrate` step.
//
// The SQL travels inside the binary via //go:embed in db/migrations, so a deployment
// cannot ship a binary whose schema disagrees with it. That is the property worth
// having, and it is only true if the binary applies its own migrations.
//
// Two instances starting simultaneously are handled by a Postgres advisory lock
// inside the runner, so they queue rather than one of them failing on a duplicate
// CREATE TABLE.
//
// Failing STARTUP on a migration error is deliberate. The alternative — log and carry
// on — means serving orders into a schema that may be missing the CHECKs they depend
// on, which is the specific failure the whole persistence layer exists to prevent.
//
// The drain's idempotency port is the SAME postgres type as the order's: one table,
// one writer, and therefore one answer when two batches overlap. Two implementations
// of one store would be two sources of truth for whether a sale was already applied.
func buildPersistence(
	clock func() time.Time,
	logger *slog.Logger,
) (*orderuc.IngestOrder, syncuc.BatchIdempotency, func(), error) {
	dsn := os.Getenv(databaseURLEnv)
	if dsn == "" {
		logger.Warn("POST "+orderhttp.BasePath+"/sync/push is routed but will REFUSE every submission",
			"reason", databaseURLEnv+" is unset, so there is nowhere to commit an accepted sale",
			"effect", "a terminal pushing a batch receives 500 and retries; nothing is acknowledged that was not stored",
			"fix", "set "+databaseURLEnv+" to this project's Postgres — note port 5433, not 5432, "+
				"which belongs to the sibling project (dev/DEV-SETUP.md)",
			"never", "this is deliberately NOT the in-memory adapters; a restart would take every "+
				"acknowledged sale with it")
		return orderuc.NewIngestOrder(orderuc.IngestOrderDeps{
			Orders: unwiredOrderRepository{},
			Rates:  unwiredBranchRates{},
			Idem:   unwiredIdempotencyStore{},
			Outbox: unwiredOutboxLedger{},
			// The stock ledger refuses too, and for the same reason as the four
			// above: a sale acknowledged without its stock recorded is a shelf that
			// silently drifts. A terminal pushing in this state is told "retry", keeps
			// its outbox row, and the deduction happens once persistence exists.
			Stock: unwiredStockLedger{},
			Now:   clock,
		}), unwiredBatchIdempotency{}, nil, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("opening the Postgres pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, nil, nil, fmt.Errorf(
			"connecting to Postgres: %w. Check the host and port: this project is on 5433, and 5432 "+
				"belongs to the sibling project pos-walasri (dev/DEV-SETUP.md)", err)
	}
	if err := postgres.Migrate(ctx, pool); err != nil {
		pool.Close()
		// Fatal on purpose: serving into a schema missing its money CHECKs is worse
		// than not serving at all.
		return nil, nil, nil, fmt.Errorf("applying the schema: %w", err)
	}

	store := postgres.NewIdempotencyStore(pool)

	// The stock deduction, wired over the SAME pool and therefore the same
	// transaction-visible schema the orders land in.
	//
	// Sharing the pool rather than opening a second one is deliberate: the
	// deduction reads `inventory_items` and writes `stock_movements`, and a second
	// pool would mean a second set of connections against the same database for no
	// benefit. It also means the migration above has already applied
	// 0002_inventory.sql — the store would fail on a missing table otherwise, and
	// failing at startup is far better than failing on the first sale of the shift.
	stockStore := inventorypostgres.NewStockStore(pool)
	logger.Info("the sync endpoint is wired to Postgres",
		"schema", "applied from the embedded db/migrations at startup",
		"driver", "github.com/jackc/pgx/v5",
		"stock", "quantities are BIGINT milli-units; a negative balance commits and is reported "+
			"as a warning rather than refused")

	ingest := orderuc.NewIngestOrder(orderuc.IngestOrderDeps{
		Orders: postgres.NewOrderRepository(pool),
		Rates:  postgres.NewBranchRate(pool),
		Idem:   store,
		Outbox: postgres.NewOutboxLedger(pool),
		Stock: orderinventory.NewStockLedger(inventoryuc.NewDeductSale(inventoryuc.DeductSaleDeps{
			Items: stockStore,
			Store: stockStore,
			Now:   clock,
		})),
		Now: clock,
	})
	return ingest, store, pool.Close, nil
}

// databaseURLEnv is the connection string's environment variable.
//
// Matches DEV-SETUP.md §4, which says the Go backend "connects over the host ports
// instead, via DATABASE_URL / REDIS_URL in .env".
const databaseURLEnv = "DATABASE_URL"

// ── the refusing placeholders ──────────────────────────────────────────────────
//
// Used only when DATABASE_URL is unset. Every one refuses with errUnwired, and the
// drain turns that into ErrInfrastructure, which the handler maps to 500 — so a
// terminal that pushes in this state is told "retry", keeps its outbox row, and the
// sale is still there when persistence exists.
//
// The drain's OrderIngester is the REAL adapter over the REAL interactor; only the
// four ports underneath it refuse. A submission therefore travels the whole pipeline
// and fails where the missing dependency actually is, rather than at a hand-written
// guard at the edge that would go stale the moment a real store is wired in.

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

type unwiredBatchIdempotency struct{}

func (unwiredBatchIdempotency) Lookup(context.Context, syncdomain.IdempotencyKey) (*syncdomain.IdempotencyRecord, error) {
	return nil, errUnwired
}
func (unwiredBatchIdempotency) Save(context.Context, syncdomain.IdempotencyRecord) error {
	return errUnwired
}

// unwiredStockLedger refuses every deduction.
//
// It refuses rather than skipping, and the distinction is the whole point. A
// ledger that silently succeeded would let the endpoint acknowledge sales whose
// stock was never recorded — the shelves would drift by exactly the amount the shop
// sold, with nothing anywhere recording that they had.
//
// So a terminal pushing in this state gets the same 500 every other unwired port
// produces, keeps its outbox row, and retries. Once DATABASE_URL is set the real
// ledger takes over and the retry deducts exactly once: a movement's id is its
// order line's id, so re-presenting the same sale collides with itself.
type unwiredStockLedger struct{}

func (unwiredStockLedger) DeductForSale(context.Context, orderuc.SaleStock) ([]orderuc.StockWarning, error) {
	return nil, errUnwired
}

var (
	_ orderuc.OrderRepository  = unwiredOrderRepository{}
	_ orderuc.BranchRateSource = unwiredBranchRates{}
	_ orderuc.IdempotencyStore = unwiredIdempotencyStore{}
	_ orderuc.OutboxLedger     = unwiredOutboxLedger{}
	_ orderuc.StockLedger      = unwiredStockLedger{}
	_ syncuc.BatchIdempotency  = unwiredBatchIdempotency{}
)
