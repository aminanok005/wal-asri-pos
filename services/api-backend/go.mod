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
go 1.25

// NO require block, and that is deliberate.
//
// SKILL.md §3.4 records that `github.com/aminanok005/grit` is unresolvable (404
// on the proxy, on GitHub, and on the GitHub API) and that no framework may be
// substituted for it. Adding it here would make `go build ./...` fail on the
// very first line, taking the whole service down before a single test runs.
//
// So the money/tax/domain core is written against the STANDARD LIBRARY ONLY.
// It compiles, vets and tests green today, with zero network access, and it
// stays correct regardless of how the HTTP/DB wiring is eventually supplied.
// Third-party packages get added when the backend toolchain is unblocked and
// there is something real to import.
