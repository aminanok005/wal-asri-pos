import { describe, expect, it } from 'bun:test';
import {
  createReportingClient,
  ReportingError,
  type ReportSummary,
} from './reportingClient';

/**
 * The `fetch` the tests inject: scripted answers per path, NO socket. The
 * recording half proves the contract's paths and query names — a typo in
 * `reports/summary` or `branch_id` fails here instead of at the till.
 */
function scripted(
  answers: Record<string, { status: number; body: unknown }>,
): {
  fetchJson: (url: string) => Promise<{ status: number; body: unknown }>;
  seen: string[];
} {
  const seen: string[] = [];
  const fetchJson = async (url: string) => {
    seen.push(url);
    const path = url.split('/api/v1/')[1]!.split('?')[0]!;
    const answer = answers[path];
    if (answer === undefined) {
      throw new Error(`no scripted answer for ${path}`);
    }
    return answer;
  };
  return { fetchJson, seen };
}

const SUMMARY_BODY = {
  as_of: '2026-10-09T21:00:00Z',
  revenue_total_satang: '284000000',
  vat_satang: '18600000',
  order_count: 4821,
  voided_count: 3,
};

function summaryClient(body: unknown = SUMMARY_BODY, status = 200) {
  const { fetchJson, seen } = scripted({ 'reports/summary': { status, body } });
  return { client: createReportingClient(fetchJson, 'http://127.0.0.1:8080/'), seen };
}

describe('reportingClient — summary wire', () => {
  it('parses every field of ReportSummaryResponse without touching a socket', async () => {
    const { client, seen } = summaryClient();
    const summary: ReportSummary = await client.summary(
      '018f3c2a-0000-7000-8000-000000000001',
      '2026-10-01',
      '2026-10-31',
    );

    // The URL carries the contract's paths and query names, exactly.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(
      'http://127.0.0.1:8080/api/v1/reports/summary?branch_id=018f3c2a-0000-7000-8000-000000000001&from=2026-10-01&to=2026-10-31',
    );

    // Money arrives as CANONICAL SATANG STRINGS — a float here would compile
    // and silently round the branch's revenue.
    expect(summary.revenueTotalSatang).toBe('284000000');
    expect(typeof summary.revenueTotalSatang).toBe('string');
    expect(summary.vatSatang).toBe('18600000');
    expect(typeof summary.vatSatang).toBe('string');

    // Counts are counts, never satang — the one place integers cross as numbers.
    expect(summary.orderCount).toBe(4821);
    expect(summary.voidedCount).toBe(3);
    expect(summary.asOf).toBe('2026-10-09T21:00:00Z');
  });

  it('turns the auth stub 503 into a named auth-stub error, not a transport one', async () => {
    const { client } = summaryClient({ code: 'auth_stub_required', message: 'set REPORTS_TOKEN' }, 503);
    const failure = await client
      .summary('018f3c2a-0000-7000-8000-000000000001', '2026-10-01', '2026-10-31')
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(ReportingError);
    const typed = failure as ReportingError;
    expect(typed.kind).toBe('auth-stub');
    // The server's `code`, verbatim: the UI branches on THIS, never on `message`.
    expect(typed.code).toBe('auth_stub_required');
  });

  it('rejects a bare-number revenue — money is strings on this wire', async () => {
    const { client } = summaryClient({ ...SUMMARY_BODY, revenue_total_satang: 284000000 });
    const failure = await client
      .summary('018f3c2a-0000-7000-8000-000000000001', '2026-10-01', '2026-10-31')
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(ReportingError);
    expect((failure as ReportingError).kind).toBe('malformed');
  });

  it('refuses to send a non-UUID branch or a non-date window', async () => {
    const { client } = summaryClient();
    // Nothing was even sent — the request is refused before the socket.
    await expect(
      client.summary('branch-siam', '2026-10-01', '2026-10-31'),
    ).rejects.toThrow(/UUIDv7/);
    await expect(
      client.summary('018f3c2a-0000-7000-8000-000000000001', 'Oct 1', '2026-10-31'),
    ).rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe('reportingClient — revenue-by-branch wire', () => {
  const branchBody = {
    revenue_by_branch: [
      {
        branch_id: '018f3c2a-0000-7000-8000-000000000001',
        name: 'Siam',
        revenue_satang: '121000000',
        order_count: 1984,
      },
      {
        branch_id: '018f3c2a-0000-7000-8000-000000000002',
        name: 'On Nut',
        revenue_satang: '93000000',
        order_count: 1622,
      },
    ],
  };

  it('parses every branch row and preserves server order (revenue desc)', async () => {
    const { fetchJson, seen } = scripted({ 'reports/revenue-by-branch': { status: 200, body: branchBody } });
    const client = createReportingClient(fetchJson, 'http://127.0.0.1:8080');

    const rows = await client.revenueByBranch('2026-10-01', '2026-10-31');

    expect(seen[0]).toBe(
      'http://127.0.0.1:8080/api/v1/reports/revenue-by-branch?from=2026-10-01&to=2026-10-31',
    );
    expect(rows.map((r) => r.name)).toEqual(['Siam', 'On Nut']);
    expect(rows[0]!.revenueSatang).toBe('121000000');
    expect(typeof rows[0]!.revenueSatang).toBe('string');
    expect(rows[0]!.orderCount).toBe(1984);
    expect(rows[0]!.branchId).toBe('018f3c2a-0000-7000-8000-000000000001');
  });

  it('rejects a non-array payload rather than rendering an empty ranking', async () => {
    const { fetchJson } = scripted({
      'reports/revenue-by-branch': { status: 200, body: { revenue_by_branch: null } },
    });
    const client = createReportingClient(fetchJson, 'http://127.0.0.1:8080');

    await expect(client.revenueByBranch('2026-10-01', '2026-10-31')).rejects.toThrow(
      /revenue_by_branch must be an array/,
    );
  });
});
