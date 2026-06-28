import pg from "pg";
import type { AppDataPort } from "../ports/types.js";
import type { Doc } from "../mongo.js";
import { matchFilter, applyUpdate } from "../mongo.js";
import { randomUUID } from "node:crypto";
import { PortError } from "../errors.js";

/**
 * Prod AppDataPort backed by external Postgres with engine-enforced row-level
 * security. Unlike the PGLite prototype (which can't enforce RLS policies and
 * relies on an app-level wrapper), this impl makes the DATABASE the authority:
 * every method opens a transaction, runs `SELECT set_config('app.user_id',
 * $userId, true)` (transaction-local), and lets `FORCE ROW LEVEL SECURITY` +
 * the policy enforce that the function can only touch rows whose `user_id`
 * matches. A bug in the query cannot leak another user's rows, because the
 * engine filters them out before any row is returned.
 *
 * Selected by `HYPER_MCP_APP_DATA_BACKEND=pg` + `HYPER_MCP_APP_DATA_PG_URL`.
 * Tests are gated on `PG_TEST_URL` (real Postgres required).
 */
export class PgAppDataPort implements AppDataPort {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async init(): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query(`
        CREATE TABLE IF NOT EXISTS app_data (
          account_id text NOT NULL,
          user_id text NOT NULL,
          collection text NOT NULL,
          id text NOT NULL,
          document jsonb NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (account_id, user_id, collection, id)
        );
        ALTER TABLE app_data ENABLE ROW LEVEL SECURITY;
        ALTER TABLE app_data FORCE ROW LEVEL SECURITY;
        CREATE POLICY IF NOT EXISTS app_data_user_rls ON app_data
          USING (user_id = current_setting('app.user_id', true))
          WITH CHECK (user_id = current_setting('app.user_id', true));
      `);
    } finally {
      c.release();
    }
  }

  async close(): Promise<void> { await this.pool.end(); }

  private async tx<R>(accountId: string, userId: string, fn: (c: pg.PoolClient) => Promise<R>): Promise<R> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      await c.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  async appDataCreate(_accountId: string | undefined, userId: string, collection: string, document: Doc) {
    const aid = _accountId || "default";
    const id = typeof document._id === "string" ? document._id : randomUUID();
    const doc = { ...structuredClone(document), _id: id };
    try {
      await this.tx(aid, userId, async (c) => {
        await c.query(
          `INSERT INTO app_data(account_id,user_id,collection,id,document) VALUES($1,$2,$3,$4,$5::jsonb)`,
          [aid, userId, collection, id, JSON.stringify(doc)],
        );
      });
    } catch (e) {
      throw new PortError("APP_DATA_DUPLICATE", `Document with _id ${id} already exists`, 409);
    }
    return { ok: true, id };
  }

  async appDataGet(_accountId: string | undefined, userId: string, collection: string, id: string) {
    const aid = _accountId || "default";
    return this.tx(aid, userId, async (c) => {
      const r = await c.query<{ document: Doc }>(
        `SELECT document FROM app_data WHERE account_id=$1 AND collection=$2 AND id=$3`,
        [aid, collection, id],
      );
      return r.rows[0] ? { document: r.rows[0].document, found: true } : { document: null, found: false };
    });
  }

  async appDataFind(_accountId: string | undefined, userId: string, collection: string, options: { filter?: Doc; limit?: number; skip?: number } = {}) {
    const aid = _accountId || "default";
    return this.tx(aid, userId, async (c) => {
      const r = await c.query<{ document: Doc }>(
        `SELECT document FROM app_data WHERE account_id=$1 AND collection=$2`,
        [aid, collection],
      );
      const matched = r.rows.map((x) => x.document).filter((d) => matchFilter(d, options.filter));
      const total = matched.length;
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 1000);
      const skip = options.skip ?? 0;
      return { documents: matched.slice(skip, skip + limit), total };
    });
  }

  async appDataUpdate(_accountId: string | undefined, userId: string, collection: string, id: string, patch: Doc) {
    const aid = _accountId || "default";
    return this.tx(aid, userId, async (c) => {
      const r = await c.query<{ document: Doc }>(
        `SELECT document FROM app_data WHERE account_id=$1 AND collection=$2 AND id=$3`,
        [aid, collection, id],
      );
      if (!r.rows[0]) return { ok: true, id, matchedCount: 0 };
      const { doc, modified } = applyUpdate(r.rows[0].document, patch);
      await c.query(
        `UPDATE app_data SET document=$4::jsonb, updated_at=now() WHERE account_id=$1 AND collection=$2 AND id=$3`,
        [aid, collection, id, JSON.stringify(doc)],
      );
      return { ok: true, id, matchedCount: modified ? 1 : 0 };
    });
  }

  async appDataDelete(_accountId: string | undefined, userId: string, collection: string, id: string) {
    const aid = _accountId || "default";
    return this.tx(aid, userId, async (c) => {
      const r = await c.query<{ id: string }>(
        `DELETE FROM app_data WHERE account_id=$1 AND collection=$2 AND id=$3 RETURNING id`,
        [aid, collection, id],
      );
      return { deleted: r.rows.length > 0 };
    });
  }

  async appDataCount(_accountId: string | undefined, userId: string, collection: string, filter?: Doc) {
    const f = await this.appDataFind(_accountId, userId, collection, { filter, limit: 1000 });
    return { count: f.total };
  }
}