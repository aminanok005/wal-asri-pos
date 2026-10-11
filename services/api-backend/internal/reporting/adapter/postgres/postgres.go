// Package postgres is the reporting module's PostgreSQL persistence driver.
package postgres

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
	reporting "wal-asri-pos/services/api-backend/internal/reporting/domain"
	reportinguc "wal-asri-pos/services/api-backend/internal/reporting/usecase"
)

// ─────────────────────────────────────────────────────────────────────────────
// BranchRepository
// ─────────────────────────────────────────────────────────────────────────────

type BranchRepository struct{ pool *pgxpool.Pool }

// NewBranchRepository wires the repository.
func NewBranchRepository(pool *pgxpool.Pool) *BranchRepository {
	return &BranchRepository{pool: pool}
}

var _ reportinguc.BranchRepository = (*BranchRepository)(nil)

// All returns every branch.
func (r *BranchRepository) All(ctx context.Context) ([]reporting.Branch, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, name, currency, vat_rate_bp, created_at, updated_at
		  FROM branches
		 ORDER BY name, id`)
	if err != nil {
		return nil, fmt.Errorf("reporting: reading branches: %w", err)
	}
	defer rows.Close()

	var out []reporting.Branch
	for rows.Next() {
		var b reporting.Branch
		var currency string
		var vatRateBp int64
		if err := rows.Scan(&b.ID, &b.Name, &currency, &vatRateBp, &b.CreatedAt, &b.UpdatedAt); err != nil {
			return nil, fmt.Errorf("reporting: scanning branch: %w", err)
		}
		b.Currency = currency
		b.VatRateBp = money.BasisPoints(vatRateBp)
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reporting: iterating branches: %w", err)
	}
	return out, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// TerminalRepository
// ─────────────────────────────────────────────────────────────────────────────

type TerminalRepository struct{ pool *pgxpool.Pool }

// NewTerminalRepository wires the repository.
func NewTerminalRepository(pool *pgxpool.Pool) *TerminalRepository {
	return &TerminalRepository{pool: pool}
}

var _ reportinguc.TerminalRepository = (*TerminalRepository)(nil)

// All returns every terminal with its last sync time.
func (r *TerminalRepository) All(ctx context.Context) ([]reporting.Terminal, error) {
	rows, err := r.pool.Query(ctx, `
		WITH terminal_ids AS (
			SELECT DISTINCT terminal_id AS id FROM orders
			UNION
			SELECT DISTINCT terminal_id AS id FROM sync_outbox_items
		)
		SELECT t.id,
		       MAX(CASE WHEN s.state IN ('ACKNOWLEDGED','CONFLICT_HELD') THEN s.processed_at END),
		       COUNT(DISTINCT CASE WHEN s.id IS NOT NULL THEN s.id END)
		  FROM terminal_ids t
		  LEFT JOIN sync_outbox_items s ON s.terminal_id = t.id
		 GROUP BY t.id
		 ORDER BY t.id`)
	if err != nil {
		return nil, fmt.Errorf("reporting: reading terminals: %w", err)
	}
	defer rows.Close()

	var out []reporting.Terminal
	for rows.Next() {
		var t reporting.Terminal
		var maxProcessedAt *time.Time
		var orderCount int64
		if err := rows.Scan(&t.ID, &maxProcessedAt, &orderCount); err != nil {
			return nil, fmt.Errorf("reporting: scanning terminal: %w", err)
		}
		t.LastSyncAt = maxProcessedAt
		t.OrderCount = orderCount
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reporting: iterating terminals: %w", err)
	}
	return out, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// RevenueRepository
// ─────────────────────────────────────────────────────────────────────────────

type RevenueRepository struct{ pool *pgxpool.Pool }

// NewRevenueRepository wires the repository.
func NewRevenueRepository(pool *pgxpool.Pool) *RevenueRepository {
	return &RevenueRepository{pool: pool}
}

var _ reportinguc.RevenueRepository = (*RevenueRepository)(nil)

// Summary returns the revenue summary for a branch and date range.
func (r *RevenueRepository) Summary(
	ctx context.Context, q reporting.SummaryQuery,
) (reporting.Summary, error) {
	var s reporting.Summary
	var asOf *time.Time
	var revenueTotalSatang, vatSatang sql.NullInt64
	var orderCount, voidedCount sql.NullInt64

	err := r.pool.QueryRow(ctx, `
		SELECT
			MAX(o.created_at) AS as_of,
			SUM(o.total_satang) AS revenue_total_satang,
			SUM(o.tax_satang) AS vat_satang,
			COUNT(*) FILTER (WHERE o.status NOT IN ('draft','voided')) AS order_count,
			COUNT(*) FILTER (WHERE o.status = 'voided') AS voided_count
		  FROM orders o
		 WHERE o.branch_id = $1
		   AND o.created_at >= ($2::timestamptz AT TIME ZONE 'Asia/Bangkok')::timestamptz
		   AND o.created_at < (($3::timestamptz + interval '1 day') AT TIME ZONE 'Asia/Bangkok')::timestamptz`,
		q.BranchID, q.Range.From.Format("2006-01-02"), q.Range.To.Format("2006-01-02")).
		Scan(&asOf, &revenueTotalSatang, &vatSatang, &orderCount, &voidedCount)
	if err != nil {
		return s, fmt.Errorf("reporting: reading summary: %w", err)
	}

	s.AsOf = asOf.UTC()
	if revenueTotalSatang.Valid {
		s.RevenueTotalSatang = money.Satang(revenueTotalSatang.Int64)
	}
	if vatSatang.Valid {
		s.VatSatang = money.Satang(vatSatang.Int64)
	}
	if orderCount.Valid {
		s.OrderCount = orderCount.Int64
	}
	if voidedCount.Valid {
		s.VoidedCount = voidedCount.Int64
	}
	return s, nil
}

// ByBranch returns revenue broken down by branch.
func (r *RevenueRepository) ByBranch(
	ctx context.Context, q reporting.RevenueByBranchQuery,
) ([]reporting.RevenueByBranchItem, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT
			o.branch_id,
			b.name,
			SUM(o.total_satang) AS revenue_satang,
			COUNT(*) FILTER (WHERE o.status NOT IN ('draft','voided')) AS order_count
		  FROM orders o
		  JOIN branches b ON b.id = o.branch_id
		 WHERE o.created_at >= ($1::timestamptz AT TIME ZONE 'Asia/Bangkok')::timestamptz
		   AND o.created_at < (($2::timestamptz + interval '1 day') AT TIME ZONE 'Asia/Bangkok')::timestamptz
		 GROUP BY o.branch_id, b.name
		 ORDER BY revenue_satang DESC, o.branch_id`,
		q.Range.From.Format("2006-01-02"), q.Range.To.Format("2006-01-02"))
	if err != nil {
		return nil, fmt.Errorf("reporting: reading revenue by branch: %w", err)
	}
	defer rows.Close()

	var out []reporting.RevenueByBranchItem
	for rows.Next() {
		var item reporting.RevenueByBranchItem
		var branchID identity.UUIDv7
		var revenueSatang sql.NullInt64
		if err := rows.Scan(&branchID, &item.Name, &revenueSatang, &item.OrderCount); err != nil {
			return nil, fmt.Errorf("reporting: scanning revenue by branch: %w", err)
		}
		item.BranchID = branchID
		if revenueSatang.Valid {
			item.RevenueSatang = money.Satang(revenueSatang.Int64)
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reporting: iterating revenue by branch: %w", err)
	}
	return out, nil
}

// Series returns revenue time series.
func (r *RevenueRepository) Series(
	ctx context.Context, q reporting.RevenueSeriesQuery,
) ([]reporting.RevenueSeriesItem, error) {
	var bucketExpr string
	if q.Granularity == reporting.GranularityDay {
		bucketExpr = "date_trunc('day', (o.created_at AT TIME ZONE 'Asia/Bangkok'))::date"
	} else {
		bucketExpr = "date_trunc('month', (o.created_at AT TIME ZONE 'Asia/Bangkok'))::date"
	}

	rows, err := r.pool.Query(ctx, fmt.Sprintf(`
		SELECT
			%s AS bucket,
			SUM(o.total_satang) AS revenue_satang,
			COUNT(*) FILTER (WHERE o.status NOT IN ('draft','voided')) AS order_count
		  FROM orders o
		 WHERE o.branch_id = $1
		   AND o.created_at >= ($2::timestamptz AT TIME ZONE 'Asia/Bangkok')::timestamptz
		   AND o.created_at < (($3::timestamptz + interval '1 day') AT TIME ZONE 'Asia/Bangkok')::timestamptz
		 GROUP BY bucket
		 ORDER BY bucket`, bucketExpr),
		q.BranchID, q.Range.From.Format("2006-01-02"), q.Range.To.Format("2006-01-02"))
	if err != nil {
		return nil, fmt.Errorf("reporting: reading revenue series: %w", err)
	}
	defer rows.Close()

	var out []reporting.RevenueSeriesItem
	for rows.Next() {
		var item reporting.RevenueSeriesItem
		var bucketDate time.Time
		var revenueSatang sql.NullInt64
		if err := rows.Scan(&bucketDate, &revenueSatang, &item.OrderCount); err != nil {
			return nil, fmt.Errorf("reporting: scanning revenue series: %w", err)
		}
		item.Bucket = bucketDate.Format("2006-01-02")
		if revenueSatang.Valid {
			item.RevenueSatang = money.Satang(revenueSatang.Int64)
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reporting: iterating revenue series: %w", err)
	}
	return out, nil
}
