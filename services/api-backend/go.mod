// Module path is a LOCAL placeholder.
//
// HANDOVER.md §9: this repository has no remote, so there is no real import
// path to use yet. A path with no dot in its first element is never fetched by
// the go tool, which is what we want — this module is never a dependency of
// anything. Replace this line with the real repository path in the same commit
// that adds the remote.
module wal-asri-pos/services/api-backend

// SKILL.md §3.1 requires Go >= 1.22.0; the backend is written against 1.25 as
// specified for this service. Local toolchain is go1.25.1.
go 1.25.0

// THE ONLY DEPENDENCY IS A POSTGRESQL DRIVER. That is a deliberate, narrow
// exception and this comment says exactly what it is and is not.
//
// SKILL.md §3.4 records that `github.com/aminanok005/grit` is unresolvable (404
// on the proxy, on GitHub, and on the GitHub API) and that NO FRAMEWORK may be
// substituted for it. That constraint is UNCHANGED and still honoured: there is no
// web framework here, no ORM, no DI container, and no HTTP router. The handler is
// net/http and the ports are hand-declared interfaces.
//
// What changed is narrower than it looks. This module previously had NO require
// block at all, because Go's standard library contains no PostgreSQL driver — so
// `database/sql` alone cannot open a connection, and a working persistence layer
// was not writable without adding something. `github.com/jackc/pgx/v5` is that
// something, and it is a DATABASE DRIVER, not a framework: it speaks the wire
// protocol and nothing else. It makes no decision about money, tax, validation or
// routing.
//
// The money and tax core therefore remains STANDARD LIBRARY ONLY, which is the
// property that actually mattered:
//
//	internal/money/domain      stdlib only. Satang, Quantity, the VAT split.
//	internal/identity/domain   stdlib only. UUIDv7.
//	internal/*/domain          stdlib only, and enforced by
//	                           internal/architecture/layers_test.go.
//	internal/*/usecase         stdlib only, enforced by the same test.
//
// The dependency appears in exactly one layer — internal/*/adapter/postgres — and
// the architecture test FAILS THE BUILD if it ever reaches a domain or usecase
// package. So the rule that "the money rules have no third-party code in them"
// is now enforced mechanically rather than merely intended.
//
// ── WHY THE `go` DIRECTIVE IS 1.25.0 AND NOT 1.25 ─────────────────────────────
//
// Adding a dependency made the go tool canonicalise the directive. They are
// equivalent; 1.25 and 1.25.0 are the same language version. Note that
// .github/workflows/verify.yml reads this file via `go-version-file`, so CI tracks
// whatever is written here rather than a copy-pasted number.

require github.com/jackc/pgx/v5 v5.11.0

require (
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	golang.org/x/sync v0.17.0 // indirect
	golang.org/x/text v0.29.0 // indirect
)
