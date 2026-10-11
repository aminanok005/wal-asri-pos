// Package http adapts the reporting use case to the wire.
package http

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	reporting "wal-asri-pos/services/api-backend/internal/reporting/domain"
	reportinguc "wal-asri-pos/services/api-backend/internal/reporting/usecase"
)

// BasePath is the contract's server URL: `/api/v1`.
const BasePath = "/api/v1"

// Handler serves the reporting endpoints.
type Handler struct {
	getBranches      *reportinguc.GetBranches
	getTerminals     *reportinguc.GetTerminals
	getSummary       *reportinguc.GetReportSummary
	getRevenueByBranch *reportinguc.GetRevenueByBranch
	getRevenueSeries *reportinguc.GetRevenueSeries
	now              func() time.Time
	logger           *slog.Logger
}

// NewHandler wires the adapter.
func NewHandler(
	getBranches *reportinguc.GetBranches,
	getTerminals *reportinguc.GetTerminals,
	getSummary *reportinguc.GetReportSummary,
	getRevenueByBranch *reportinguc.GetRevenueByBranch,
	getRevenueSeries *reportinguc.GetRevenueSeries,
	now func() time.Time,
	logger *slog.Logger,
) *Handler {
	return &Handler{
		getBranches:      getBranches,
		getTerminals:     getTerminals,
		getSummary:       getSummary,
		getRevenueByBranch: getRevenueByBranch,
		getRevenueSeries: getRevenueSeries,
		now:              now,
		logger:           logger,
	}
}

// Route registers the handler's routes on a mux.
func (h *Handler) Route(mux *http.ServeMux) {
	mux.HandleFunc("GET "+BasePath+"/branches", h.getBranchesWrapper)
	mux.HandleFunc("GET "+BasePath+"/terminals", h.getTerminalsWrapper)
	mux.HandleFunc("GET "+BasePath+"/reports/summary", h.getSummaryWrapper)
	mux.HandleFunc("GET "+BasePath+"/reports/revenue-by-branch", h.getRevenueByBranchWrapper)
	mux.HandleFunc("GET "+BasePath+"/reports/revenue-series", h.getRevenueSeriesWrapper)
}

// authCheck middleware for Phase 1 reporting endpoints.
//
// REQUIREMENTS (per Phase 1 design):
//   - X-Report-Token header must match REPORTS_TOKEN environment variable
//   - Caller must be localhost (127.0.0.1 or ::1)
//
// Without these, 503 with code `auth_stub_required`.
func (h *Handler) authCheck(r *http.Request) error {
	reportToken := os.Getenv("REPORTS_TOKEN")
	if reportToken == "" {
		return fmt.Errorf("REPORTS_TOKEN not configured")
	}
	if r.Header.Get("X-Report-Token") != reportToken {
		return fmt.Errorf("invalid X-Report-Token header")
	}
	remoteAddr := r.RemoteAddr
	// Extract IP from remote addr (may include port)
	ip := remoteAddr
	if idx := strings.LastIndex(remoteAddr, ":"); idx != -1 {
		ip = remoteAddr[:idx]
	}
	if ip != "127.0.0.1" && ip != "::1" {
		return fmt.Errorf("must be localhost")
	}
	return nil
}

// writeError emits the contract's error envelope with the given status.
func (h *Handler) writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"code":    code,
		"message": message,
	})
}

const (
	errBadRequest      = "bad_request"
	errAuthStubRequired = "auth_stub_required"
	errInternal        = "internal_error"
)

// getBranchesWrapper wraps the use case with auth check.
func (h *Handler) getBranchesWrapper(w http.ResponseWriter, r *http.Request) {
	if err := h.authCheck(r); err != nil {
		if errors.Is(err, fmt.Errorf("REPORTS_TOKEN not configured")) {
			h.writeError(w, http.StatusServiceUnavailable, errAuthStubRequired,
				"REPORTS_TOKEN environment variable is not set. This is a Phase 1 stub.")
			return
		}
		h.writeError(w, http.StatusServiceUnavailable, errAuthStubRequired,
			"authentication stub failed: invalid token or not localhost")
		return
	}
	branches, err := h.getBranches.Execute(r.Context())
	if err != nil {
		h.logger.Error("reading branches", "error", err)
		h.writeError(w, http.StatusInternalServerError, errInternal,
			"the branches could not be read")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"branches": h.toBranches(branches),
	})
}

// getTerminalsWrapper wraps the use case with auth check.
func (h *Handler) getTerminalsWrapper(w http.ResponseWriter, r *http.Request) {
	if err := h.authCheck(r); err != nil {
		h.writeError(w, http.StatusServiceUnavailable, errAuthStubRequired,
			"authentication stub failed: invalid token or not localhost")
		return
	}
	terminals, err := h.getTerminals.Execute(r.Context())
	if err != nil {
		h.logger.Error("reading terminals", "error", err)
		h.writeError(w, http.StatusInternalServerError, errInternal,
			"the terminals could not be read")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"terminals": h.toTerminals(terminals),
	})
}

// getSummaryWrapper wraps the use case with auth check.
func (h *Handler) getSummaryWrapper(w http.ResponseWriter, r *http.Request) {
	if err := h.authCheck(r); err != nil {
		h.writeError(w, http.StatusServiceUnavailable, errAuthStubRequired,
			"authentication stub failed: invalid token or not localhost")
		return
	}
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	branchID := r.URL.Query().Get("branch_id")
	
	// Parse branch_id
	branchIDParsed, err := identity.ParseUUIDv7(branchID)
	if err != nil {
		h.writeError(w, http.StatusBadRequest, errBadRequest,
			"branch_id must be a UUIDv7")
		return
	}
	
	// Parse dates
	fromTime, err := time.Parse("2006-01-02", from)
	if err != nil {
		h.writeError(w, http.StatusBadRequest, errBadRequest,
			"from must be a date in YYYY-MM-DD format")
		return
	}
	toTime, err := time.Parse("2006-01-02", to)
	if err != nil {
		h.writeError(w, http.StatusBadRequest, errBadRequest,
			"to must be a date in YYYY-MM-DD format")
		return
	}
	
	query := reporting.SummaryQuery{
		BranchID: branchIDParsed,
		Range:    reporting.DateRange{From: fromTime, To: toTime},
	}
	
	summary, err := h.getSummary.Execute(r.Context(), query)
	if err != nil {
		h.logger.Error("reading summary", "error", err)
		h.writeError(w, http.StatusInternalServerError, errInternal,
			"the summary could not be read")
		return
	}
	
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(h.toSummaryResponse(summary))
}

// getRevenueByBranchWrapper wraps the use case with auth check.
func (h *Handler) getRevenueByBranchWrapper(w http.ResponseWriter, r *http.Request) {
	if err := h.authCheck(r); err != nil {
		h.writeError(w, http.StatusServiceUnavailable, errAuthStubRequired,
			"authentication stub failed: invalid token or not localhost")
		return
	}
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	
	fromTime, err := time.Parse("2006-01-02", from)
	if err != nil {
		h.writeError(w, http.StatusBadRequest, errBadRequest,
			"from must be a date in YYYY-MM-DD format")
		return
	}
	toTime, err := time.Parse("2006-01-02", to)
	if err != nil {
		h.writeError(w, http.StatusBadRequest, errBadRequest,
			"to must be a date in YYYY-MM-DD format")
		return
	}
	
	query := reporting.RevenueByBranchQuery{
		Range: reporting.DateRange{From: fromTime, To: toTime},
	}
	
	items, err := h.getRevenueByBranch.Execute(r.Context(), query)
	if err != nil {
		h.logger.Error("reading revenue by branch", "error", err)
		h.writeError(w, http.StatusInternalServerError, errInternal,
			"the revenue by branch could not be read")
		return
	}
	
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"revenue_by_branch": h.toRevenueByBranch(items),
	})
}

// getRevenueSeriesWrapper wraps the use case with auth check.
func (h *Handler) getRevenueSeriesWrapper(w http.ResponseWriter, r *http.Request) {
	if err := h.authCheck(r); err != nil {
		h.writeError(w, http.StatusServiceUnavailable, errAuthStubRequired,
			"authentication stub failed: invalid token or not localhost")
		return
	}
	branchID := r.URL.Query().Get("branch_id")
	granularity := r.URL.Query().Get("granularity")
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	
	if granularity != "day" && granularity != "month" {
		h.writeError(w, http.StatusBadRequest, errBadRequest,
			"granularity must be 'day' or 'month'")
		return
	}
	
	branchIDParsed, err := identity.ParseUUIDv7(branchID)
	if err != nil {
		h.writeError(w, http.StatusBadRequest, errBadRequest,
			"branch_id must be a UUIDv7")
		return
	}
	
	fromTime, err := time.Parse("2006-01-02", from)
	if err != nil {
		h.writeError(w, http.StatusBadRequest, errBadRequest,
			"from must be a date in YYYY-MM-DD format")
		return
	}
	toTime, err := time.Parse("2006-01-02", to)
	if err != nil {
		h.writeError(w, http.StatusBadRequest, errBadRequest,
			"to must be a date in YYYY-MM-DD format")
		return
	}
	
	query := reporting.RevenueSeriesQuery{
		BranchID: branchIDParsed,
		Granularity: reporting.SeriesGranularity(granularity),
		Range:    reporting.DateRange{From: fromTime, To: toTime},
	}
	
	items, err := h.getRevenueSeries.Execute(r.Context(), query)
	if err != nil {
		h.logger.Error("reading revenue series", "error", err)
		h.writeError(w, http.StatusInternalServerError, errInternal,
			"the revenue series could not be read")
		return
	}
	
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"series": h.toRevenueSeries(items),
	})
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire DTOs
// ─────────────────────────────────────────────────────────────────────────────

func (h *Handler) toBranches(branches []reporting.Branch) []map[string]any {
	result := make([]map[string]any, 0, len(branches))
	for _, b := range branches {
		result = append(result, map[string]any{
			"id":         b.ID.String(),
			"name":       b.Name,
			"currency":   string(b.Currency),
			"vat_rate_bp": int64(b.VatRateBp),
			"created_at": b.CreatedAt.UTC().Format(time.RFC3339Nano),
			"updated_at": b.UpdatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	return result
}

func (h *Handler) toTerminals(terminals []reporting.Terminal) []map[string]any {
	result := make([]map[string]any, 0, len(terminals))
	for _, t := range terminals {
		var lastSyncAt *string
		if t.LastSyncAt != nil {
			s := t.LastSyncAt.UTC().Format(time.RFC3339Nano)
			lastSyncAt = &s
		}
		result = append(result, map[string]any{
			"id":          t.ID.String(),
			"last_sync_at": lastSyncAt,
			"order_count": t.OrderCount,
		})
	}
	return result
}

func (h *Handler) toSummaryResponse(s reporting.Summary) map[string]any {
	return map[string]any{
		"as_of":                     s.AsOf.UTC().Format(time.RFC3339Nano),
		"revenue_total_satang":      s.RevenueTotalSatang.String(),
		"vat_satang":                s.VatSatang.String(),
		"order_count":               s.OrderCount,
		"voided_count":              s.VoidedCount,
	}
}

func (h *Handler) toRevenueByBranch(items []reporting.RevenueByBranchItem) []map[string]any {
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		result = append(result, map[string]any{
			"branch_id":     item.BranchID.String(),
			"name":          item.Name,
			"revenue_satang": item.RevenueSatang.String(),
			"order_count":   item.OrderCount,
		})
	}
	return result
}

func (h *Handler) toRevenueSeries(items []reporting.RevenueSeriesItem) []map[string]any {
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		result = append(result, map[string]any{
			"bucket":         item.Bucket,
			"revenue_satang": item.RevenueSatang.String(),
			"order_count":    item.OrderCount,
		})
	}
	return result
}
