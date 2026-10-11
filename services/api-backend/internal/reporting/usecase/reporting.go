// Package usecase holds the reporting's application logic — the interactors.
//
// ── LAYER RULE ────────────────────────────────────────────────────────────────
//
// The ports are declared here, in the use case package, and `adapter/postgres`
// implements them. The interface is owned by the side that consumes it.
package usecase

import (
	"context"
	"fmt"

	"wal-asri-pos/services/api-backend/internal/reporting/domain"
)

// ─────────────────────────────────────────────────────────────────────────────
// Ports
// ─────────────────────────────────────────────────────────────────────────────

// BranchRepository reads branches from the authoritative store.
type BranchRepository interface {
	All(ctx context.Context) ([]domain.Branch, error)
}

// TerminalRepository reads terminal info.
type TerminalRepository interface {
	All(ctx context.Context) ([]domain.Terminal, error)
}

// RevenueRepository reads revenue aggregates.
type RevenueRepository interface {
	Summary(ctx context.Context, q domain.SummaryQuery) (domain.Summary, error)
	ByBranch(ctx context.Context, q domain.RevenueByBranchQuery) ([]domain.RevenueByBranchItem, error)
	Series(ctx context.Context, q domain.RevenueSeriesQuery) ([]domain.RevenueSeriesItem, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// The interactors
// ─────────────────────────────────────────────────────────────────────────────

// GetBranches is the interactor behind GET /branches.
type GetBranches struct {
	repo BranchRepository
}

// NewGetBranches wires the interactor.
func NewGetBranches(repo BranchRepository) *GetBranches {
	return &GetBranches{repo: repo}
}

// Execute returns all branches.
func (g *GetBranches) Execute(ctx context.Context) ([]domain.Branch, error) {
	return g.repo.All(ctx)
}

// GetTerminals is the interactor behind GET /terminals.
type GetTerminals struct {
	repo TerminalRepository
}

// NewGetTerminals wires the interactor.
func NewGetTerminals(repo TerminalRepository) *GetTerminals {
	return &GetTerminals{repo: repo}
}

// Execute returns all terminals with their last sync time.
func (g *GetTerminals) Execute(ctx context.Context) ([]domain.Terminal, error) {
	return g.repo.All(ctx)
}

// GetReportSummary is the interactor behind GET /reports/summary.
type GetReportSummary struct {
	repo RevenueRepository
}

// NewGetReportSummary wires the interactor.
func NewGetReportSummary(repo RevenueRepository) *GetReportSummary {
	return &GetReportSummary{repo: repo}
}

// Execute returns the revenue summary for a branch and date range.
func (g *GetReportSummary) Execute(ctx context.Context, q domain.SummaryQuery) (domain.Summary, error) {
	if err := q.Validate(); err != nil {
		return domain.Summary{}, fmt.Errorf("reporting: invalid summary query: %w", err)
	}
	return g.repo.Summary(ctx, q)
}

// GetRevenueByBranch is the interactor behind GET /reports/revenue-by-branch.
type GetRevenueByBranch struct {
	repo RevenueRepository
}

// NewGetRevenueByBranch wires the interactor.
func NewGetRevenueByBranch(repo RevenueRepository) *GetRevenueByBranch {
	return &GetRevenueByBranch{repo: repo}
}

// Execute returns revenue broken down by branch.
func (g *GetRevenueByBranch) Execute(ctx context.Context, q domain.RevenueByBranchQuery) ([]domain.RevenueByBranchItem, error) {
	if err := q.Validate(); err != nil {
		return nil, fmt.Errorf("reporting: invalid revenue-by-branch query: %w", err)
	}
	return g.repo.ByBranch(ctx, q)
}

// GetRevenueSeries is the interactor behind GET /reports/revenue-series.
type GetRevenueSeries struct {
	repo RevenueRepository
}

// NewGetRevenueSeries wires the interactor.
func NewGetRevenueSeries(repo RevenueRepository) *GetRevenueSeries {
	return &GetRevenueSeries{repo: repo}
}

// Execute returns revenue time series.
func (g *GetRevenueSeries) Execute(ctx context.Context, q domain.RevenueSeriesQuery) ([]domain.RevenueSeriesItem, error) {
	if err := q.Validate(); err != nil {
		return nil, fmt.Errorf("reporting: invalid revenue-series query: %w", err)
	}
	return g.repo.Series(ctx, q)
}
