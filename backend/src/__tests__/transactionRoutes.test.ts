import request from 'supertest';
import { jest } from '@jest/globals';
import { Keypair } from '@stellar/stellar-sdk';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';

const USER_A = Keypair.random().publicKey();
const USER_B = Keypair.random().publicKey();

const mockQuery =
  jest.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>>();

jest.unstable_mockModule('../db/connection.js', () => ({
  default: { query: mockQuery },
  query: mockQuery,
  getClient: jest.fn(),
  closePool: jest.fn(),
  withTransaction: jest.fn(),
}));

const mockCreateNotification = jest.fn();
jest.unstable_mockModule('../services/notificationService.js', () => ({
  notificationService: {
    createNotification: mockCreateNotification,
  },
}));

jest.unstable_mockModule('../services/sorobanService.js', () => ({
  sorobanService: {
    submitSignedTx: jest.fn(),
  },
}));

const fakeCacheStore = new Map<string, unknown>();
jest.unstable_mockModule('../services/cacheService.js', () => ({
  cacheService: {
    get: jest.fn(async (key: string) => fakeCacheStore.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown) => {
      fakeCacheStore.set(key, value);
    }),
    setNotExists: jest.fn(async (key: string, value: unknown) => {
      if (fakeCacheStore.has(key)) return false;
      fakeCacheStore.set(key, value);
      return true;
    }),
    delete: jest.fn(async (key: string) => {
      fakeCacheStore.delete(key);
    }),
  },
}));

const { default: app } = await import('../app.js');

const createAuthToken = (publicKey: string, scopes: string[] = ['read:remittances']) => {
  return jwt.sign({ publicKey, role: 'borrower', scopes }, process.env.JWT_SECRET!, {
    algorithm: 'HS256',
    expiresIn: '1h',
  });
};

// ── In-memory simulation of the transaction_submissions table ────────────────
interface TxRow {
  id: number;
  tx_hash: string;
  status: string;
  submitted_at: string;
  submitted_by: string;
  transaction_type: string;
  result_xdr: string;
}

let table: TxRow[] = [];
let lastSql = '';
let lastParams: unknown[] = [];

function txRow(id: number, submittedBy: string): TxRow {
  return {
    id,
    tx_hash: `tx-hash-${id}`,
    status: 'success',
    submitted_at: new Date(Date.UTC(2026, 0, 1) - id * 60_000).toISOString(),
    submitted_by: submittedBy,
    transaction_type: 'payment',
    result_xdr: `xdr-${id}`,
  };
}

// Mimics the controller's query shape: $1 = submitted_by, $2 = limit + 1,
// optional $3 = cursor (AND id < $3), ORDER BY id DESC.
const simulateQuery = async (
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  lastSql = sql;
  lastParams = params;

  const submittedBy = params[0] as string;
  const fetchCount = Number(params[1]);
  const cursor = params.length > 2 ? Number(params[2]) : null;

  let rows = table.filter((row) => row.submitted_by === submittedBy);
  if (cursor !== null) {
    rows = rows.filter((row) => row.id < cursor);
  }
  rows = rows.sort((a, b) => b.id - a.id).slice(0, fetchCount);

  return { rows, rowCount: rows.length };
};

mockQuery.mockImplementation(simulateQuery);

const normalizeSql = (sql: string): string => sql.replace(/\s+/g, ' ');

beforeEach(() => {
  jest.clearAllMocks();
  table = [];
  lastSql = '';
  lastParams = [];
  mockQuery.mockImplementation(simulateQuery);
});

describe('GET /api/transactions/me (listMyTransactions)', () => {
  describe('authentication', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const res = await request(app).get('/api/transactions/me');

      expect(res.status).toBe(401);
      expect(res.body.message).toContain('Missing or invalid Authorization header');
    });

    it('returns 401 for an invalid token', async () => {
      const res = await request(app)
        .get('/api/transactions/me')
        .set('Authorization', 'Bearer not-a-real-jwt');

      expect(res.status).toBe(401);
      expect(res.body.message).toContain('Invalid or expired');
    });

    it('returns 200 with a valid JWT token', async () => {
      table = [txRow(1, USER_A)];

      const res = await request(app)
        .get('/api/transactions/me')
        .set('Authorization', `Bearer ${createAuthToken(USER_A)}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
