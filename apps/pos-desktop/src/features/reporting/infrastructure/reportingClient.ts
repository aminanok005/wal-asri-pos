/**
 * reportingClient.ts — typed edge over the LAN reporting API
 * (`contracts/openapi.yaml`, Reporting tag).
 *
 * LAYER: infrastructure. The ONLY place in the frontend that speaks HTTP to
 * the Go service: inbound rows cross as validated values or the call rejects —
 * never as `any`, never as trusted JSON. This is the same edge discipline as
 * `tauriOfflineOrders.ts` (untyped `fetch` would be documentation, the parsers
 * are the enforcement).
 *
 * ── WHAT IT READS, FIELD FOR FIELD ──────────────────────────────────────────
 *
 * `GET /reports/summary?branch_id=&from=&to=` →
 *   { as_of, revenue_total_satang, vat_satang, order_count, voided_count }
 *   Money arrives as `Satang` strings (`"4550"`), parsed by `satangFromWire`,
 *   so the UI gets `Money` — never a float, never a bare number.
 *
 * `GET /reports/revenue-by-branch?from=&to=` →
 *   { revenue_by_branch: [{ branch_id, name, revenue_satang, order_count }] }
 *
 * NOTE the vocabulary gap, kept deliberate: `revenue_total_satang` and
 * `revenue_satang` parse as `Money` (they ARE money). `order_count` and
 * `voided_count` are plain counts (JSON numbers), NOT satang — treating a
 * count as `Money` would let a finance total into an arithmetic it does not
 * belong to.
 *
 * AUTH STUB (Phase 1): the server answers 503 (`auth_stub_required`) unless
 * the token matches and the caller is localhost. `ReportingError` carries the
 * server's `code` verbatim for that reason — the UI branches on `code`, not
 * on the human `message` the contract forbids parsing.
 */

export class ReportingError extends Error {
  /**
   * Stable machine-readable reason: `'http'`, `'transport'` (DNS/refused/
   * timeout — the server may or may not be there), `'auth-stub'` (503
   * `auth_stub_required`: token missing or caller not localhost), or
   * `'malformed'` (a 200 whose body is not the contract's shape).
   */
  readonly kind: 'http' | 'transport' | 'auth-stub' | 'malformed';

  /** The contract `code` when the server sent one (`auth_stub_required`, …). */
  readonly code: string | null;

  constructor(kind: ReportingError['kind'], detail: string, code: string | null = null) {
    super(detail);
    this.name = 'ReportingError';
    this.kind = kind;
    this.code = code;
  }
}

/** `ReportSummaryResponse` — money parsed, counts carried. */
export interface ReportSummary {
  readonly asOf: string;
  readonly revenueTotalSatang: string;
  readonly vatSatang: string;
  readonly orderCount: number;
  readonly voidedCount: number;
}

/** `RevenueByBranchItem`, in wire-cased keys. */
export interface BranchRevenue {
  readonly branchId: string;
  readonly name: string;
  readonly revenueSatang: string;
  readonly orderCount: number;
}

export interface ReportingClient {
  readonly summary: (branchId: string, from: string, to: string) => Promise<ReportSummary>;
  readonly revenueByBranch: (from: string, to: string) => Promise<readonly BranchRevenue[]>;
}

const SATANG = /^(0|[1-9][0-9]*)$/;
const UUIDV7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function satang(field: string, raw: unknown): string {
  if (typeof raw !== 'string' || !SATANG.test(raw)) {
    throw new ReportingError(
      'malformed',
      `${field} must be a Satang digit string, received ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

function count(field: string, raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new ReportingError(
      'malformed',
      `${field} must be a non-negative integer, received ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

function text(field: string, raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ReportingError(
      'malformed',
      `${field} must be a non-empty string, received ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/**
 * Build an HTTP reporting client over an injected `fetch`-shaped function.
 *
 * Injected rather than imported so tests never touch a socket: the dangerous
 * code at this edge is the SHAPE PARSING, and it must be verifiable in a
 * plain `bun test`. `WAL_ASRI_SYNC_URL.split('/api')[0]`-style base juggling
 * lives with the caller — this layer takes ONE base URL and appends the
 * contract's paths.
 */
export function createReportingClient(
  fetchJson: (url: string) => Promise<{ status: number; body: unknown }>,
  baseUrl: string,
): ReportingClient {
  const normalizedBase = baseUrl.replace(/\/+$/, '');

  async function get(path: string, query: Record<string, string>): Promise<unknown> {
    const params = new URLSearchParams(query);
    const url = `${normalizedBase}/api/v1/${path}?${params.toString()}`;
    let response: { status: number; body: unknown };
    try {
      response = await fetchJson(url);
    } catch (error) {
      throw new ReportingError(
        'transport',
        `reporting API unreachable at ${url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 503) {
      const code =
        typeof response.body === 'object' && response.body !== null
          ? String((response.body as Record<string, unknown>).code ?? 'auth_stub_required')
          : 'auth_stub_required';
      throw new ReportingError(
        'auth-stub',
        'reporting auth stub: the server needs REPORTS_TOKEN and a localhost caller',
        code,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ReportingError('http', `reporting API answered HTTP ${response.status} for ${url}`);
    }
    return response.body;
  }

  function shape(raw: unknown, what: string): Record<string, unknown> {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ReportingError('malformed', `${what} must be a JSON object, received ${JSON.stringify(raw)}`);
    }
    return raw as Record<string, unknown>;
  }

  return Object.freeze({
    async summary(branchId: string, from: string, to: string): Promise<ReportSummary> {
      if (!UUIDV7.test(branchId)) {
        throw new ReportingError('malformed', `branch_id must be a UUIDv7, received ${JSON.stringify(branchId)}`);
      }
      if (!DATE.test(from) || !DATE.test(to)) {
        throw new ReportingError('malformed', `from/to must be YYYY-MM-DD dates, received ${JSON.stringify(from)} / ${JSON.stringify(to)}`);
      }
      const wire = shape(await get('reports/summary', { branch_id: branchId, from, to }), 'ReportSummaryResponse');
      return Object.freeze({
        asOf: text('as_of', wire.as_of),
        revenueTotalSatang: satang('revenue_total_satang', wire.revenue_total_satang),
        vatSatang: satang('vat_satang', wire.vat_satang),
        orderCount: count('order_count', wire.order_count),
        voidedCount: count('voided_count', wire.voided_count),
      });
    },

    async revenueByBranch(from: string, to: string): Promise<readonly BranchRevenue[]> {
      if (!DATE.test(from) || !DATE.test(to)) {
        throw new ReportingError('malformed', `from/to must be YYYY-MM-DD dates, received ${JSON.stringify(from)} / ${JSON.stringify(to)}`);
      }
      const wire = shape(
        await get('reports/revenue-by-branch', { from, to }),
        'RevenueByBranchResponse',
      );
      if (!Array.isArray(wire.revenue_by_branch)) {
        throw new ReportingError(
          'malformed',
          `revenue_by_branch must be an array, received ${JSON.stringify(wire.revenue_by_branch)}`,
        );
      }
      return Object.freeze(
        wire.revenue_by_branch.map((row: unknown, index: number) => {
          const item = shape(row, `revenue_by_branch[${index}]`);
          const branchId = text(`revenue_by_branch[${index}].branch_id`, item.branch_id);
          if (!UUIDV7.test(branchId)) {
            throw new ReportingError(
              'malformed',
              `revenue_by_branch[${index}].branch_id must be a UUIDv7, received ${JSON.stringify(branchId)}`,
            );
          }
          return Object.freeze({
            branchId,
            name: text(`revenue_by_branch[${index}].name`, item.name),
            revenueSatang: satang(`revenue_by_branch[${index}].revenue_satang`, item.revenue_satang),
            orderCount: count(`revenue_by_branch[${index}].order_count`, item.order_count),
          });
        }),
      );
    },
  });
}
