// Package architecture holds tests, not code.
//
// This is the Go counterpart of `apps/pos-desktop/test/layers.test.ts`, and it
// exists for the same reason. That file's own note: the layer rule is enforced
// "for *every* `domain/*.ts` module from one shared allowlist (not one hand-written
// test per file, which is how new modules escape)".
//
// This file is the shared allowlist for Go. It walks every `internal/<module>/`
// directory at test time, so a module added tomorrow is checked without anyone
// remembering to add a test for it.
//
// What is being enforced, in the architecture rule's own terms:
//
//	domain/   Pure Go logic. No DB, no framework, no HTTP, no other module's
//	          usecase or adapter, and no goroutine-safe mutable global state.
//	usecase/  Application logic. MAY import domain and stdlib. May NOT import an
//	          adapter — dependency inversion means the adapter depends on the
//	          use case, never the reverse. The repository ports live HERE, which
//	          is what makes that inversion possible.
//	adapter/  HTTP handlers and SQL drivers. May import usecase and domain. These
//	          are the only packages permitted to reach a framework.
package architecture

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// forbiddenInDomain are import path fragments a `domain/` package may not reach.
//
// Three groups, and each one is a specific architecture rule rather than a
// general taste:
//
//   - The database and the wire. A domain that opens a connection or reads a
//     header cannot be tested without one, and cannot be reused from a CLI or a
//     background worker that has neither.
//   - Other modules' application and adapter layers. The rule is directional:
//     `order` may use `money`, never the reverse and never `order`'s repository.
//   - Go's concurrency primitives, oddly enough. Domain code here is pure
//     arithmetic on values. A `sync.Mutex` or a `go func` in a domain package is
//     a sign that state has leaked out of a value and into a place, and the
//     place is wrong. ARCHITECTURE-DEMO.md §2 makes business logic live in one
//     place per side; that only holds if it is deterministic.
var forbiddenInDomain = []struct {
	fragment string
	why      string
}{
	{"database/sql", "the database is an adapter concern"},
	{"net/http", "HTTP is an adapter concern"},
	{"net/url", "URL handling belongs to the transport layer"},
	{"gorm.io", "an ORM is an adapter concern"},
	{"jackc/pgx", "a Postgres driver is an adapter concern"},
	{"lib/pq", "a Postgres driver is an adapter concern"},
	{"context", "domain functions take values, not a request-scoped context"},
	{"sync", "domain code is deterministic; shared mutable state has leaked"},
	{"internal/order/usecase", "modules may not depend on another module's application layer"},
	{"internal/order/adapter", "modules may not depend on another module's adapter"},
	{"internal/catalog/usecase", "modules may not depend on another module's application layer"},
	{"internal/catalog/adapter", "modules may not depend on another module's adapter"},
	{"internal/sync/usecase", "modules may not depend on another module's application layer"},
	{"internal/sync/adapter", "modules may not depend on another module's adapter"},
	{"cmd/", "a domain package may not import the composition root"},
	{"services/api-backend/internal/order/usecase", "as above, with the full module path"},
}

// forbiddenInUsecase are import path fragments a `usecase/` package may not reach.
//
// The load-bearing one is `adapter`: the ports a use case depends on are declared
// IN the use case package, and the adapter implements them. A use case that
// imports its own adapter has the arrow pointing the wrong way, and the inversion
// that makes the domain testable is gone.
var forbiddenInUsecase = []struct {
	fragment string
	why      string
}{
	{"database/sql", "a use case talks to a repository port, not to a database"},
	{"net/http", "HTTP is an adapter concern"},
	{"gorm.io", "an ORM is an adapter concern"},
	{"jackc/pgx", "a Postgres driver is an adapter concern"},
	{"lib/pq", "a Postgres driver is an adapter concern"},
}

// moneyRuleForbidden are tokens that must never appear in a file that declares a
// money field.
//
// This is SKILL.md §5's first checkbox — "No `float` types found in money
// calculations" — as an executable assertion rather than a review instruction.
//
// It is a SOURCE SCAN, not a type check, because the case it must catch is a
// `float64` that a reviewer reads past. The scan skips comments first, for the
// reason HANDOVER.md §7 records as trap B: "A boundary guard flagged its own doc
// comment for mentioning `setItems`" — a guard that reads its own explanations as
// violations is a guard that gets deleted.
var moneyRuleForbidden = []string{"float32", "float64"}

// fieldNamesDeclaringMoney are the substrings that mark a struct field or variable
// as money.
var fieldNamesDeclaringMoney = []string{"satang", "Satang", "_baht", "amount", "Amount", "price", "Price", "total", "Total", "tax", "Tax", "discount", "Discount"}

// moduleRoot is this service's root, derived from the test's working directory.
func moduleRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("cannot determine the working directory: %v", err)
	}
	// The test runs in internal/architecture, so the module root is two levels up.
	root := filepath.Clean(filepath.Join(wd, "..", ".."))
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		t.Fatalf("expected a go.mod at %s: %v", root, err)
	}
	return root
}

// internalModules lists the module directories under internal/.
//
// The shared kernels (`money`, `identity`) and the shared cross-cutting domain
// (`sync`) are included deliberately: they are held to the same domain rules as
// `catalog` and `order`, because "it is just a helper package" is exactly how a
// domain layer stops being pure.
func internalModules(t *testing.T, root string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(root, "internal"))
	if err != nil {
		t.Fatalf("cannot read internal/: %v", err)
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() && !strings.HasPrefix(e.Name(), "_") {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out
}

// TestEveryModuleHasTheThreeLayers documents the expected shape, and fails if a
// module is added or renamed without the rest of the structure following.
//
// The two documented exceptions are the shared kernels, which have `domain/`
// only. They are value-object libraries with no application logic and no I/O;
// giving them an empty `usecase/` and `adapter/` would imply a boundary they do
// not have. Each is listed here explicitly so the exception is visible rather
// than a hole in the check.
func TestEveryModuleHasTheThreeLayers(t *testing.T) {
	root := moduleRoot(t)

	domainOnly := map[string]string{
		"money":    "a value-object library: Satang, Quantity and the VAT rule. No application logic, no I/O.",
		"identity": "a value-object library: UUIDv7 parsing and ordering. No application logic, no I/O.",
		"sync":     "cross-cutting domain only for now; its usecase and adapter arrive with the /sync/push endpoint, which the contract does not yet define.",
	}

	// `architecture` holds this test and no production code.
	selfHosted := map[string]string{"architecture": "holds the layer tests themselves"}

	for _, module := range internalModules(t, root) {
		module := module
		t.Run(module, func(t *testing.T) {
			dir := filepath.Join(root, "internal", module)
			if _, err := os.Stat(filepath.Join(dir, "domain")); err != nil {
				if why, ok := selfHosted[module]; ok {
					t.Logf("%s %s", module, why)
					return
				}
				t.Errorf("internal/%s has no domain/ directory", module)
			}

			for _, layer := range []string{"usecase", "adapter"} {
				_, err := os.Stat(filepath.Join(dir, layer))
				has := err == nil
				if why, ok := domainOnly[module]; ok {
					if has {
						t.Errorf("internal/%s has a %s/ directory, but it is a shared kernel (%s) "+
							"and should hold domain/ only", module, layer, why)
					}
					continue
				}
				if !has {
					t.Errorf("internal/%s has no %s/ directory", module, layer)
				}
			}
		})
	}
}

// TestDomainPackagesImportNothingForbidden is the core assertion.
func TestDomainPackagesImportNothingForbidden(t *testing.T) {
	root := moduleRoot(t)

	for _, module := range internalModules(t, root) {
		domainDir := filepath.Join(root, "internal", module, "domain")
		files := goFilesIn(t, domainDir)
		if len(files) == 0 {
			continue
		}
		for _, file := range files {
			file := file
			t.Run(filepath.Join(module, "domain", filepath.Base(file)), func(t *testing.T) {
				for _, imp := range parseImports(t, file) {
					for _, forbidden := range forbiddenInDomain {
						if strings.Contains(imp, forbidden.fragment) {
							t.Errorf("%s imports %q, which is forbidden in a domain package: %s",
								relativeTo(root, file), imp, forbidden.why)
						}
					}
				}
			})
		}
	}
}

// TestUsecasePackagesDoNotImportTheirAdapters is the dependency-inversion
// assertion: the arrow points adapter → usecase, never back.
func TestUsecasePackagesDoNotImportTheirAdapters(t *testing.T) {
	root := moduleRoot(t)

	for _, module := range internalModules(t, root) {
		usecaseDir := filepath.Join(root, "internal", module, "usecase")
		files := goFilesIn(t, usecaseDir)
		if len(files) == 0 {
			continue
		}
		adapterPath := "internal/" + module + "/adapter"
		for _, file := range files {
			for _, imp := range parseImports(t, file) {
				if strings.Contains(imp, adapterPath) {
					t.Errorf("%s imports %q. A use case declares its own ports and the adapter "+
						"implements them; importing the adapter inverts the arrow and makes the "+
						"use case untestable without a database",
						relativeTo(root, file), imp)
				}
				for _, forbidden := range forbiddenInUsecase {
					if strings.Contains(imp, forbidden.fragment) {
						t.Errorf("%s imports %q, which is forbidden in a use case: %s",
							relativeTo(root, file), imp, forbidden.why)
					}
				}
			}
		}
	}
}

// TestNoFloatInMoneyPaths is SKILL.md §5's money checkbox, enforced.
//
// It scans every non-test Go file in the service for a float type appearing
// alongside a money field name. The pairing matters: `float64` is legitimate in
// a metrics histogram or a similarity score, and a blanket ban would either be
// ignored or force a workaround. What is never legitimate is a float next to
// `satang`, `total`, `tax`, `discount`, `amount` or `price`.
//
// Comments are stripped first, so the extensive "why not float" commentary in this
// service does not trip the guard that enforces not using float. That specific
// trap is recorded in HANDOVER.md §7: a boundary guard once flagged its own doc
// comment, and the fix was `stripComments()`.
func TestNoFloatInMoneyPaths(t *testing.T) {
	root := moduleRoot(t)

	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			// Skip build output and VCS metadata.
			switch info.Name() {
			case ".git", "node_modules", "testdata":
				return filepath.SkipDir
			}
			return nil
		}
		name := info.Name()
		if !strings.HasSuffix(name, ".go") {
			return nil
		}
		// Test files may legitimately construct a float to prove a boundary refuses
		// one, and a test fixture is not on the money path.
		if strings.HasSuffix(name, "_test.go") {
			return nil
		}

		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		code := stripComments(string(src))

		mentionsMoney := false
		for _, name := range fieldNamesDeclaringMoney {
			if strings.Contains(code, name) {
				mentionsMoney = true
				break
			}
		}
		if !mentionsMoney {
			return nil
		}
		for _, bad := range moneyRuleForbidden {
			if strings.Contains(code, bad) {
				t.Errorf("%s uses %s in a file that declares money fields. "+
					"Every monetary value is an integer count of satang (int64): 3 * 0.1 = "+
					"0.30000000000000004 in binary floating point, and a POS that drifts a "+
					"fraction of a satang per line cannot reconcile at end of shift",
					relativeTo(root, path), bad)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking the service failed: %v", err)
	}
}

// TestTheMoneyKernelHasExactlyOneVatImplementation is the anti-drift assertion
// that this whole module exists to support.
//
// DOMAIN.md encodes the VAT rule in TypeScript, in the SQLite CHECK constraints
// and in the Go kernel. Each language needs its own copy — they run on different
// machines — but there must be EXACTLY ONE per language. A second Go copy of
// `gross * 10000 / (10000 + vat_rate_bp)` is a second encoding of one accounting
// rule, and the failure is late and quiet: the domain suite keeps testing the
// first copy while checkout starts failing at COMMIT by a satang.
func TestTheMoneyKernelHasExactlyOneVatImplementation(t *testing.T) {
	root := moduleRoot(t)

	// The one legitimate site: the shared kernel.
	allowed := filepath.Join(root, "internal", "money", "domain", "vat.go")

	var found []string
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			switch info.Name() {
			case ".git", "node_modules", "testdata":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(info.Name(), ".go") || strings.HasSuffix(info.Name(), "_test.go") {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		code := stripComments(string(src))
		// The extraction's signature: a scale of 10000 divided by (10000 + rate).
		if strings.Contains(code, "10000") || strings.Contains(code, "10_000") {
			if strings.Contains(code, "BasisPointsPerWhole") || strings.Contains(code, "vatRateBp") {
				found = append(found, relativeTo(root, path))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking the service failed: %v", err)
	}

	for _, f := range found {
		if f != relativeTo(root, allowed) {
			t.Errorf("%s appears to implement the VAT extraction. There must be exactly one Go "+
				"copy and it belongs in internal/money/domain/vat.go; a second copy would drift "+
				"from the first and from the SQL CHECK without any test noticing", f)
		}
	}
	if len(found) == 0 {
		t.Errorf("the VAT extraction was not found in %s; if it moved, update this test rather "+
			"than letting the guard quietly pass", relativeTo(root, allowed))
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────

func goFilesIn(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil //nolint:nilerr // a missing directory is handled by the shape test
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".go") {
			out = append(out, filepath.Join(dir, e.Name()))
		}
	}
	sort.Strings(out)
	return out
}

func parseImports(t *testing.T, path string) []string {
	t.Helper()
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
	if err != nil {
		t.Fatalf("cannot parse %s: %v", path, err)
	}
	var out []string
	for _, i := range f.Imports {
		p, err := strconv.Unquote(i.Path.Value)
		if err != nil {
			continue
		}
		out = append(out, p)
	}
	return out
}

// stripComments removes // and /* */ comments, preserving line structure.
//
// Line structure is preserved so that a line number in a failure still points at
// the right place. It is NOT a tokenizer — it is good enough to stop a guard from
// reading its own prose as a violation, which is trap B from HANDOVER.md §7.
func stripComments(src string) string {
	var b strings.Builder
	b.Grow(len(src))

	inBlock := false
	inLine := false
	inString := false
	inRune := false
	var quote byte

	for i := 0; i < len(src); i++ {
		c := src[i]
		next := byte(0)
		if i+1 < len(src) {
			next = src[i+1]
		}

		switch {
		case inBlock:
			if c == '*' && next == '/' {
				inBlock = false
				i++
			} else if c == '\n' {
				b.WriteByte(c)
			}
		case inLine:
			if c == '\n' {
				inLine = false
				b.WriteByte(c)
			}
		case inString || inRune:
			b.WriteByte(c)
			if c == '\\' && i+1 < len(src) {
				b.WriteByte(next)
				i++
			} else if (inString && c == quote) || (inRune && c == quote) {
				inString, inRune = false, false
			}
		case c == '/' && next == '/':
			inLine = true
			i++
		case c == '/' && next == '*':
			inBlock = true
			i++
		case c == '"':
			inString = true
			quote = c
			b.WriteByte(c)
		case c == '`':
			inRune = true
			quote = c
			b.WriteByte(c)
		case c == '\'':
			inRune = true
			quote = c
			b.WriteByte(c)
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

func relativeTo(root, path string) string {
	r, err := filepath.Rel(root, path)
	if err != nil {
		return path
	}
	return filepath.ToSlash(r)
}
