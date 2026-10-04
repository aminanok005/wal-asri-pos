// Package migrations holds the server's SQL schema and embeds it into the binary.
//
// ── WHY EMBEDDED RATHER THAN A MIGRATION TOOL ─────────────────────────────────
//
// SKILL.md §3.2 records that `goose` is the intended runner and is HELD, and
// DEV-SETUP.md §5 still describes `goose -dir migrations postgres "$DATABASE_URL" up`.
// Rather than block on that, the schema lives here as plain `.sql` and is embedded
// with the standard library's `//go:embed`.
//
// Three reasons this is not a workaround but the better shape:
//
//  1. THE MIGRATIONS TRAVEL IN THE BINARY. `//go:embed` cannot reach a parent
//     directory, so the SQL has to sit beside this file — which means a deployment
//     cannot ship a binary whose schema disagrees with it. The goose layout would
//     have put the SQL in a directory the binary never reads, so the two could
//     drift with nothing to catch it.
//
//  2. THE FILES ARE STILL PLAIN SQL. When `goose` is unheld, `migrations.go` can be
//     deleted and pointed at `db/migrations` instead. Nothing about the schema has
//     to change, because it was never tool-specific.
//
//  3. IT ADDS NO DEPENDENCY. The money and tax rules in this schema are the reason
//     the service exists; they should not sit behind a tool whose availability is
//     undecided.
//
// The runner that applies these files is `internal/order/adapter/postgres.Migrate`.
package migrations

import "embed"

// FS is every migration in this directory, keyed by filename.
//
// Lexical filename order IS the apply order, which is why they are numbered
// `0001_`, `0002_` and so on rather than timestamped: a timestamp makes the order
// depend on when a migration was written, which is not the same as when it has to
// run.
//
//go:embed *.sql
var FS embed.FS
