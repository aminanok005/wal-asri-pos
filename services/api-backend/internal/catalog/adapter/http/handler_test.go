package http

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	catalog "wal-asri-pos/services/api-backend/internal/catalog/domain"
	cataloguc "wal-asri-pos/services/api-backend/internal/catalog/usecase"
	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
)

var now = time.Date(2026, 10, 2, 9, 15, 0, 0, time.UTC)

func uid(n int) identity.UUIDv7 {
	u, err := identity.ParseUUIDv7(uuidFor(now.Add(time.Duration(n) * time.Millisecond)))
	if err != nil {
		panic("bad fixture: " + err.Error())
	}
	return u
}

func uuidFor(ts time.Time) string {
	ms := uint64(ts.UTC().UnixMilli())
	return fmt.Sprintf("%08x-%04x-71a2-8b3c-3c4d5e6f7089", ms>>16, ms&0xffff)
}

const branchID = "018f3c2a-7b41-7c3d-9e10-5a2b8c4d6e01"

// stubRepo serves a fixed catalogue.
type stubRepo struct{}

func (stubRepo) Categories(_ context.Context, _ identity.UUIDv7, _ *time.Time) ([]cataloguc.Category, error) {
	return []cataloguc.Category{{
		ID: uid(1), BranchID: uid(2), NameTH: "เครื่องดื่ม", NameEN: "Beverages",
		Sequence: 1, IsActive: true, Version: 3, CreatedAt: now, UpdatedAt: now,
	}}, nil
}
func (stubRepo) Products(_ context.Context, _ identity.UUIDv7, _ *time.Time) ([]cataloguc.Product, error) {
	return []cataloguc.Product{{
		ID: uid(3), BranchID: uid(2), NameTH: "กาแฟลาเต้เย็น", IsActive: true, Version: 1,
		CreatedAt: now, UpdatedAt: now,
	}}, nil
}
func (stubRepo) Variants(_ context.Context, _ identity.UUIDv7, _ *time.Time) ([]cataloguc.ProductVariant, error) {
	return []cataloguc.ProductVariant{{
		ID: uid(4), ProductID: uid(3), SKU: "BEV-LATTE-12", NameTH: "12 ออนซ์",
		IsActive: true, Version: 1, CreatedAt: now, UpdatedAt: now,
	}}, nil
}
func (stubRepo) PriceListEntries(_ context.Context, _ identity.UUIDv7, _ *time.Time) ([]cataloguc.PriceListEntry, error) {
	return []cataloguc.PriceListEntry{{
		ID: uid(5), PriceListID: uid(6), ProductVariant: uid(4),
		UnitPriceSatang: money.MustSatang(4550), CurrencyCode: catalog.THB,
		Version: 7, CreatedAt: now, UpdatedAt: now,
	}}, nil
}

// emptyRepo serves a branch with nothing in it, for the empty-collection test.
type emptyRepo struct{}

func (emptyRepo) Categories(context.Context, identity.UUIDv7, *time.Time) ([]cataloguc.Category, error) {
	return nil, nil
}
func (emptyRepo) Products(context.Context, identity.UUIDv7, *time.Time) ([]cataloguc.Product, error) {
	return nil, nil
}
func (emptyRepo) Variants(context.Context, identity.UUIDv7, *time.Time) ([]cataloguc.ProductVariant, error) {
	return nil, nil
}
func (emptyRepo) PriceListEntries(context.Context, identity.UUIDv7, *time.Time) ([]cataloguc.PriceListEntry, error) {
	return nil, nil
}

func newTestHandler() *Handler {
	uc := cataloguc.NewGetCatalog(stubRepo{}, func() time.Time { return now })
	return NewHandler(uc, func() time.Time { return now })
}

func TestGetCatalog_ReturnsTheContractEnvelope(t *testing.T) {
	mux := http.NewServeMux()
	newTestHandler().Route(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, BasePath+"/catalog?branch_id="+branchID, nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not valid JSON: %v\n%s", err, rec.Body)
	}

	// Every `required` field of the contract's CatalogResponse must be present,
	// INCLUDING the empty-ish ones.
	for _, field := range []string{
		"branch_id", "categories", "products", "variants",
		"price_list_entries", "cursor", "pulled_at", "next_cursor",
	} {
		if _, ok := body[field]; !ok {
			t.Errorf("required field %q is absent from the response", field)
		}
	}

	// cursor MUST equal pulled_at — the contract says so by name.
	cursor, _ := body["cursor"].(string)
	pulledAt, _ := body["pulled_at"].(string)
	if cursor != pulledAt {
		t.Errorf("cursor %q != pulled_at %q; a terminal resuming from the wrong one either "+
			"re-pulls the catalogue or skips a menu change", cursor, pulledAt)
	}

	// `unit_price_satang` must be a quoted canonical digit STRING. A bare JSON
	// number, a decimal point or an exponent form are all outside the contract's
	// `Satang` pattern ^(0|[1-9][0-9]*)$, and all ways for a float to enter a
	// money field.
	entries, _ := body["price_list_entries"].([]any)
	if len(entries) != 1 {
		t.Fatalf("got %d price entries, want 1", len(entries))
	}
	entry, _ := entries[0].(map[string]any)
	price, ok := entry["unit_price_satang"]
	if !ok {
		t.Fatal("unit_price_satang is absent")
	}
	switch v := price.(type) {
	case string:
		// Assert on the RAW BYTES too, not only the decoded value: the contract
		// constrains the spelling, and `4550` and `"4550"` decode to different
		// things precisely because the spelling is the guarantee.
		if !strings.Contains(rec.Body.String(), `"unit_price_satang":"4550"`) {
			t.Errorf("unit_price_satang did not serialise as the quoted digit string \"4550\"; "+
				"got %v in the raw body", price)
		}
		if v != "4550" {
			t.Errorf("unit_price_satang = %q, want \"4550\"", v)
		}
	default:
		t.Errorf("unit_price_satang decoded as %T, want a quoted digit string; a bare JSON "+
			"number or a decimal would break the contract's Satang pattern", price)
	}

	// A nullable field that has no value must be `null`, not omitted.
	if v, present := entry["currency_code"]; !present || v != "THB" {
		t.Errorf("currency_code = %v, want THB", v)
	}
}

func TestGetCatalog_EmitsEmptyCollectionsAsArraysNotNull(t *testing.T) {
	// A client that iterates `variants` must not have to nil-check it. `null` and
	// `[]` are different in TypeScript.
	uc := cataloguc.NewGetCatalog(emptyRepo{}, func() time.Time { return now })
	mux := http.NewServeMux()
	NewHandler(uc, func() time.Time { return now }).Route(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, BasePath+"/catalog?branch_id="+branchID, nil))

	body := rec.Body.String()
	for _, field := range []string{"categories", "products", "variants", "price_list_entries"} {
		if strings.Contains(body, `"`+field+`":null`) {
			t.Errorf("%q serialised as null; an empty collection must be [] so a client can "+
				"iterate it without a nil check", field)
		}
	}
	if !strings.Contains(body, `"variants":[]`) {
		t.Errorf("expected an empty array for variants, got %s", body)
	}
}

func TestGetCatalog_ParameterValidationMapsToTheContractStatuses(t *testing.T) {
	tests := []struct {
		name       string
		query      string
		wantStatus int
		wantCode   string
		why        string
	}{
		{
			name:       "branch_id is required",
			query:      "",
			wantStatus: http.StatusBadRequest,
			wantCode:   errBadRequest,
			why:        "pricing and VAT are branch-specific, so there is no sensible default",
		},
		{
			name:       "branch_id must be a UUIDv7",
			query:      "?branch_id=3f2504e0-4f89-41d3-9a0c-0305e82c3301",
			wantStatus: http.StatusBadRequest,
			wantCode:   errInvalidBranchID,
			why:        "a v4 does not sort chronologically, which is why this system requires v7",
		},
		{
			name:       "a malformed since is a 400, not a silent full pull",
			query:      "?branch_id=" + branchID + "&since=yesterday",
			wantStatus: http.StatusBadRequest,
			wantCode:   errInvalidSinceParam,
			why: "ignoring it would send the FULL catalogue to a terminal expecting a delta, " +
				"which looks like a server bug",
		},
		{
			name:       "limit above the contract maximum",
			query:      "?branch_id=" + branchID + "&limit=501",
			wantStatus: http.StatusBadRequest,
			wantCode:   errLimitOutOfRange,
			why:        "the contract declares maximum 500 and says the server caps it",
		},
		{
			name:       "limit below the contract minimum",
			query:      "?branch_id=" + branchID + "&limit=0x",
			wantStatus: http.StatusBadRequest,
			wantCode:   errBadRequest,
			why:        "a non-integer limit is malformed",
		},
		{
			name:       "include_inactive must be a boolean",
			query:      "?branch_id=" + branchID + "&include_inactive=yes-please",
			wantStatus: http.StatusBadRequest,
			wantCode:   errBadRequest,
			why:        "the contract declares type: boolean",
		},
	}

	mux := http.NewServeMux()
	newTestHandler().Route(mux)

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, BasePath+"/catalog"+tc.query, nil))

			if rec.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d. %s", rec.Code, tc.wantStatus, tc.why)
			}

			var env errorBody
			if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
				t.Fatalf("the error body is not the contract's Error envelope: %v\n%s", err, rec.Body)
			}
			if env.Code != tc.wantCode {
				t.Errorf("error code = %q, want %q", env.Code, tc.wantCode)
			}
			if env.Message == "" {
				t.Error("the Error envelope requires a message")
			}
		})
	}
}

func TestGetCatalog_AcceptsAValidSinceCursor(t *testing.T) {
	mux := http.NewServeMux()
	newTestHandler().Route(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet,
		BasePath+"/catalog?branch_id="+branchID+"&since=2026-10-02T09:00:00Z&include_inactive=true&limit=50", nil)
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body)
	}
}

func TestGetCatalog_OnlyServesTheDeclaredMethod(t *testing.T) {
	mux := http.NewServeMux()
	newTestHandler().Route(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, BasePath+"/catalog?branch_id="+branchID, nil))

	// The contract declares GET only. A POST must not be routed.
	if rec.Code == http.StatusOK {
		t.Error("POST /catalog was served; the contract declares GET, and there is deliberately " +
			"no write path — a client may not originate a price change")
	}
}
