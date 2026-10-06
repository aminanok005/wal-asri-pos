// Guard on db/migrations/0002_inventory.sql.
//
// ── WHY THIS IS A SOURCE SCAN AND NOT AN INTEGRATION TEST ─────────────────────
//
// It is the executable form of the rule this change was specified with: quantity
// columns are BIGINT milli-units, never NUMERIC and never FLOAT.
//
// The reason it cannot be an integration test is worth stating, because the
// obvious objection is "you already have a live-Postgres suite, put it there".
// That suite only runs in CI and only when WASRI_TEST_DATABASE_URL is set. A guard
// that fires once a day, in one environment, is a guard that is skipped on every
// developer's machine and on any branch where the database is unavailable — and the
// failure it catches (a quantity column quietly retyped to NUMERIC) is invisible in
// review, because `NUMERIC(12,3)` looks perfectly reasonable to a reader.
//
// This test needs no database and no build tag, so it runs on EVERY `go test ./...`
// and in the same command a developer already types. That is the same reasoning
// layers_test.go gives for scanning sources rather than exercising behaviour, and
// for the same related reason: a guard that does not run is a guard that does not
// guard.
//
// ── WHY IT PARSES THE SQL INSTEAD OF MATCHING SUBSTRINGS ─────────────────────
//
// Naively, "is on_hand_milli a BIGINT" is `strings.Contains(sql, "on_hand_milli BIGINT")`.
// That check passes on a file where the column is `NUMERIC(12,3)`, because the
// declaration it looks for is absent but so is the thing it forbids — a `Contains`
// for a positive string cannot fail when the file is rewritten around it.
//
// So each column is extracted by NAME and inspected in isolation. A comment
// mentioning NUMERIC, or a constraint mentioning FLOAT, therefore cannot trip the
// guard, and a retyped column cannot slip past it.
package postgres_test

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// migrationPath is the schema under guard, relative to this package.
const migrationPath = "../../../../db/migrations/0002_inventory.sql"

// readMigration loads the schema, failing loudly rather than skipping.
func readMigration(t *testing.T) string {
	t.Helper()
	src, err := os.ReadFile(filepath.Clean(migrationPath))
	if err != nil {
		t.Fatalf("reading %s: %v. This guard is the only thing standing between the schema and "+
			"a quantity column that silently accepts a float.", migrationPath, err)
	}
	return string(src)
}

// stripSQLComments removes `--` and `/* */` comments, preserving line structure.
//
// The same rule layers_test.go's stripComments follows, for the same reason: the
// file under guard explains at length WHY it uses no NUMERIC, and a guard that read
// its own explanation as a violation would be a guard somebody deletes.
//
// Preserving line numbers is what lets a failure point at the offending line.
func stripSQLComments(src string) string {
	var b strings.Builder
	b.Grow(len(src))

	inBlock, inLine, inString, inSingleQuote := false, false, false, false
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
		case inString, inSingleQuote:
			b.WriteByte(c)
			if c == '\'' {
				inString, inSingleQuote = false, false
			}
		case c == '-' && next == '-':
			inLine = true
			i++
		case c == '/' && next == '*':
			inBlock = true
			i++
		case c == '\'':
			inSingleQuote = true
			b.WriteByte(c)
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// quantityColumns are every column in this schema that holds a quantity.
//
// The list is EXPLICIT rather than derived, and that is the point: a new quantity
// column that nobody adds here is a column this guard knows nothing about. Writing
// them out means the next person adding one is looking at a list that does not
// contain theirs.
var quantityColumns = []struct {
	name string
	// why exists so the failure message says what the column is FOR, which is what
	// makes a retyped column recognisable rather than just wrong.
	why string
}{
	{"on_hand_milli", "the derived balance on the shelf"},
	{"reserved_milli", "quantity committed to open orders"},
	{"quantity_milli", "a movement's signed delta"},
}

// columnDecl matches a column declaration inside a CREATE TABLE body.
//
// Requires the name to sit at the start of a line, optionally after indentation, so
// a mention inside a CHECK constraint or a COMMENT does not read as a declaration.
// The type is captured up to the next column or constraint keyword.
var columnDecl = regexp.MustCompile(`(?m)^\s*([a-z_][a-z0-9_]*)\s+([A-Za-z]+(?:\s*\([^)]*\))?)`)

// extractColumn returns the declared SQL type of one column, or "" when absent.
func extractColumn(t *testing.T, sql, column string) string {
	t.Helper()
	for _, m := range columnDecl.FindAllStringSubmatch(sql, -1) {
		if m[1] == column {
			return strings.ToUpper(strings.Join(strings.Fields(m[2]), " "))
		}
	}
	return ""
}

// TestQuantityColumnsAreBigInt is the headline constraint of this change.
//
// A milli-unit count is an INTEGER at every layer, and the `_milli` suffix is what
// keeps it that way: an integer whose unit is written in its name cannot be misread
// by a reader and cannot be written into by a caller who forgot the scale.
func TestQuantityColumnsAreBigInt(t *testing.T) {
	sql := stripSQLComments(readMigration(t))

	for _, col := range quantityColumns {
		decl := extractColumn(t, sql, col.name)
		if decl == "" {
			t.Errorf("column %s is not declared in %s; if it was renamed, add the new name to "+
				"quantityColumns in this test rather than letting the guard quietly stop checking it",
				col.name, migrationPath)
			continue
		}
		if decl != "BIGINT" {
			t.Errorf("column %s (%s) is declared %s, want BIGINT. Quantities are exact milli-unit "+
				"integers: a decimal or floating column reintroduces the drift the satang rule exists "+
				"to prevent, and `0.1 + 0.2` is 0.30000000000000004.", col.name, col.why, decl)
		}
	}
}

// TestTheSchemaContainsNoDecimalOrFloatQuantityType is the blanket form of the
// rule, over the whole file rather than the three columns above.
//
// It catches a FOURTH quantity column nobody remembered to list — the case the
// explicit loop above cannot see. Scan and replace are both needed: a column typed
// `DOUBLE PRECISION` must be caught as well as one typed `NUMERIC(12,3)`.
//
// Note it is `NUMERIC` and not `NUMERIC(`, because the terminal's own
// 0001_init.sql legitimately declares order-line quantities as NUMERIC(12,3) and
// someone reading this guard will wonder why the two schemas differ. The answer is
// in each file's header: there the quantity is a scaled DECIMAL read back as a
// string, here it is a milli-unit INTEGER. This file must contain no NUMERIC at all.
func TestTheSchemaContainsNoDecimalOrFloatQuantityType(t *testing.T) {
	sql := stripSQLComments(readMigration(t))

	for _, banned := range []string{"NUMERIC", "FLOAT", "REAL", "DOUBLE PRECISION", "DECIMAL"} {
		if strings.Contains(strings.ToUpper(sql), banned) {
			t.Errorf("the schema contains %s. Every quantity in this schema is an exact count of "+
				"milli-units in a BIGINT column; see the header for why this file differs from the "+
				"terminal's 0001_init.sql, which does use NUMERIC for order-line quantities.", banned)
		}
	}
}

// TestOnHandHasNoNonNegativeCheck is the ratified negative-stock policy, enforced
// by the ABSENCE of a constraint.
//
// This is the assertion most likely to look wrong to a future reader, so it states
// the reasoning rather than merely forbidding a string. A `CHECK (on_hand_milli >=
// 0)` — or a CHECK on the table that constrains it — would make it impossible for
// the server to RECORD an offline oversell, and the oversell is the one fact an
// operator needs: the flour is already sold, the money is taken, and the receipt is
// printed. Refusing the record does not prevent it; it only hides it.
//
// Three layers have already committed to this — contracts/openapi.yaml
// ("May be negative if an offline terminal oversold before reconciling"), the
// terminal's 0003_stock_balances.sql, and ARCHITECTURE-DEMO.md §9 — so this schema
// is the fourth, and a fourth copy of a rule that three layers already hold is
// exactly the kind of drift this service's guards exist to prevent.
func TestOnHandHasNoNonNegativeCheck(t *testing.T) {
	sql := stripSQLComments(readMigration(t))

	if !strings.Contains(sql, "on_hand_milli") {
		t.Fatal("the schema no longer declares on_hand_milli; update this test rather than letting it pass vacuously")
	}

	// Any CHECK mentioning on_hand_milli must be a RANGE bound, never a lower bound
	// at zero. Collecting the constraint bodies and inspecting them is what makes
	// this specific: a blanket "no CHECK on this column" would forbid the
	// decimal(12,3) bound, which is wanted.
	checks := checkBodies(sql)
	for _, check := range checks {
		if !strings.Contains(check, "on_hand_milli") {
			continue
		}
		if strings.Contains(check, ">= 0") || strings.Contains(check, "> 0") {
			t.Errorf("a CHECK forbids a negative on_hand_milli: %s. An offline oversell is a real, "+
				"already-honoured sale; the balance must commit negative and be reported as a warning, "+
				"not be refused. See the header and domain.StockBalance.IsOversold.", collapse(check))
		}
	}
}

// TestReservedKeepsItsNonNegativeCheck is the deliberate ASYMMETRY with the test
// above, and it is why that one is not a blanket ban.
//
//	a negative on_hand  says "we oversold; buy more"
//	a negative reserved says "the arithmetic is broken; ignore it"
//
// Only the first is a fact about the shop. A negative reservation would report more
// available stock than physically exists, which is the one direction of drift that
// sells product a shop does not have.
func TestReservedKeepsItsNonNegativeCheck(t *testing.T) {
	sql := stripSQLComments(readMigration(t))

	if extractColumn(t, sql, "reserved_milli") == "" {
		t.Fatal("the schema no longer declares reserved_milli; update this test rather than letting it pass vacuously")
	}

	guards := false
	for _, check := range checkBodies(sql) {
		if strings.Contains(check, "reserved_milli") && strings.Contains(check, ">= 0") {
			guards = true
			break
		}
	}
	if !guards {
		t.Error("reserved_milli has no `>= 0` guard. The asymmetry with on_hand_milli is deliberate: " +
			"a negative reservation reports more available stock than exists, and unlike an oversell " +
			"that is a bookkeeping error rather than a fact about the shop.")
	}
}

// TestOnHandIsBoundedToTheContractQuantityRange checks that the signed balance is
// bounded by decimal(12,3) — the range money.maxQuantityMilli accepts and the
// contract's `Quantity` string pattern can express.
//
// Signed FULL-RANGE is the point: the bound must span both signs, because a bound
// that only pinned the top would be a softer way of refusing a negative.
func TestOnHandIsBoundedToTheContractQuantityRange(t *testing.T) {
	sql := stripSQLComments(readMigration(t))

	// ±999999999999 is 999,999,999.999 in milli-units — decimal(12,3)'s range.
	bounded := strings.Contains(sql, "-999999999999 AND 999999999999")
	if !bounded {
		t.Errorf("on_hand_milli is not bounded to the decimal(12,3) range " + "(-999999999999 AND 999999999999). " +
			"A balance outside that could not be put on the wire — money.maxQuantityMilli and the " +
			"contract's `Quantity` pattern both stop there — so storing it would create a row the " +
			"contract cannot describe.")
	}
}

// TestASaleMovementIsKeyedByItsOrderLine pins the idempotency mechanism at the
// schema, so a future writer cannot undo it while still "fixing" the Go side.
//
// The server must never mint an id for a record the client created
// (internal/identity/domain/uuidv7.go), and a sale movement is caused by an order
// line the client created offline. So the movement's id IS the line's id, and the
// primary key becomes the double-deduction guard: a terminal retrying the batch
// that carried the line collides and the second attempt is a no-op. That is the
// NORMAL case, not an edge case.
func TestASaleMovementIsKeyedByItsOrderLine(t *testing.T) {
	sql := stripSQLComments(readMigration(t))

	checks := strings.Join(checkBodies(sql), " ")
	if !strings.Contains(checks, "reference_order_line_id") {
		t.Error("no CHECK ties a sale movement's id to its reference_order_line_id. That identity is " +
			"what makes a retried batch a no-op instead of a second deduction, and what stops a " +
			"server-side writer minting a movement id for a record the client created.")
	}
}

// TestTheLedgerIsAppendOnly checks that the movements table refuses both an UPDATE
// and a DELETE, the way 0001_orders.sql does for a committed sale.
//
// The rule this protects is "stock is a ledger of movements, never an overwritten
// number". A ledger whose rows can be edited is not a ledger, and a correction that
// rewrites history rather than appending a `count_correction` movement makes the
// reconciliation question unanswerable.
func TestTheLedgerIsAppendOnly(t *testing.T) {
	sql := stripSQLComments(readMigration(t))

	for _, needle := range []string{"stock_movements_no_update", "stock_movements_no_delete"} {
		if !strings.Contains(sql, needle) {
			t.Errorf("the schema has no %s trigger. stock_movements is the ledger; a ledger whose "+
				"rows can be rewritten or deleted is not a ledger, and a correction must be a new "+
				"count_correction movement rather than an edit.", needle)
		}
	}
}

// checkBodies returns the bodies of every CHECK constraint in the schema.
//
// Comments are already stripped by the caller, so a CHECK named in prose does not
// count as a constraint — which matters here, because this file discusses its
// constraints at length in the header.
func checkBodies(sql string) []string {
	var bodies []string
	rest := sql
	for {
		i := strings.Index(strings.ToUpper(rest), "CHECK (")
		if i < 0 {
			return bodies
		}
		rest = rest[i+len("CHECK ("):]
		depth := 1
		end := 0
		for j := 0; j < len(rest); j++ {
			switch rest[j] {
			case '(':
				depth++
			case ')':
				depth--
				if depth == 0 {
					end = j
				}
			}
			if end > 0 {
				break
			}
		}
		if end == 0 {
			return bodies
		}
		bodies = append(bodies, rest[:end])
		rest = rest[end:]
	}
}

// collapse squashes a SQL fragment onto one line so a failure message reads as a
// sentence rather than as indented source.
func collapse(s string) string {
	return strings.Join(strings.Fields(s), " ")
}
