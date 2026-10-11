// Package domain holds the reporting business rules in pure Go.
//
// ── LAYER RULE ────────────────────────────────────────────────────────────────
//
// Nothing in this package may import a database driver, an HTTP framework, or
// anything from another module's `usecase/` or `adapter/`. It imports exactly
// two things, both shared kernels: `internal/money/domain` for the money type
// and `internal/identity/domain` for the key type. That constraint is tested —
// see internal/architecture/layers_test.go.
package domain

import (
	"fmt"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
)

// ─────────────────────────────────────────────────────────────────────────────
// Query types
// ─────────────────────────────────────────────────────────────────────────────

// DateRange represents a closed interval [from, to] in Asia/Bangkok timezone.
type DateRange struct {
	From time.Time
	To   time.Time
}

// IsZero reports whether both dates are zero.
func (r DateRange) IsZero() bool {
	return r.From.IsZero() && r.To.IsZero()
}

// SummaryQuery is the request for GET /reports/summary.
type SummaryQuery struct {
	BranchID identity.UUIDv7
	Range    DateRange
}

// RevenueByBranchQuery is the request for GET /reports/revenue-by-branch.
type RevenueByBranchQuery struct {
	Range DateRange
}

// RevenueSeriesQuery is the request for GET /reports/revenue-series.
type RevenueSeriesQuery struct {
	BranchID identity.UUIDv7
	Granularity SeriesGranularity
	Range    DateRange
}

// SeriesGranularity is the time bucket size for time series.
type SeriesGranularity string

const (
	GranularityDay   SeriesGranularity = "day"
	GranularityMonth SeriesGranularity = "month"
)

// ─────────────────────────────────────────────────────────────────────────────
// Entity types
// ─────────────────────────────────────────────────────────────────────────────

// Branch is one shop.
type Branch struct {
	ID       identity.UUIDv7
	Name     string
	Currency string
	VatRateBp money.BasisPoints
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Terminal is a device that has pushed orders.
type Terminal struct {
	ID identity.UUIDv7
	LastSyncAt *time.Time
	OrderCount int64
}

// Summary is the revenue summary for a branch and date range.
type Summary struct {
	AsOf time.Time
	RevenueTotalSatang money.Satang
	VatSatang money.Satang
	OrderCount int64
	VoidedCount int64
}

// RevenueByBranchItem is one row of revenue-by-branch.
type RevenueByBranchItem struct {
	BranchID identity.UUIDv7
	Name string
	RevenueSatang money.Satang
	OrderCount int64
}

// RevenueSeriesItem is one time bucket of a series.
type RevenueSeriesItem struct {
	Bucket string // ISO 8601: YYYY-MM-DD or YYYY-MM
	RevenueSatang money.Satang
	OrderCount int64
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

// Validate reports whether q has a valid date range.
func (q SummaryQuery) Validate() error {
	if q.BranchID.IsZero() {
		return fmt.Errorf("reporting: branch_id is required")
	}
	if q.Range.IsZero() {
		return fmt.Errorf("reporting: from and to dates are required")
	}
	if !q.Range.To.After(q.Range.From) {
		return fmt.Errorf("reporting: to date must be after from date")
	}
	return nil
}

// Validate reports whether q has a valid date range.
func (q RevenueByBranchQuery) Validate() error {
	if q.Range.IsZero() {
		return fmt.Errorf("reporting: from and to dates are required")
	}
	if !q.Range.To.After(q.Range.From) {
		return fmt.Errorf("reporting: to date must be after from date")
	}
	return nil
}

// Validate reports whether q has a valid query.
func (q RevenueSeriesQuery) Validate() error {
	if q.BranchID.IsZero() {
		return fmt.Errorf("reporting: branch_id is required")
	}
	if q.Granularity != GranularityDay && q.Granularity != GranularityMonth {
		return fmt.Errorf("reporting: granularity must be 'day' or 'month'")
	}
	if q.Range.IsZero() {
		return fmt.Errorf("reporting: from and to dates are required")
	}
	if !q.Range.To.After(q.Range.From) {
		return fmt.Errorf("reporting: to date must be after from date")
	}
	return nil
}
