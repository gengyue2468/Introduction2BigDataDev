import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Platform = "jd" | "taobao";
export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export class DashboardError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

interface ProductRow {
  id: number;
  platform: Platform;
  item_id: string;
  name: string;
  item_name: string;
  shop_name: string;
  notes: string;
  created_at: string;
  updated_at: string;
  actual_price_cents: number | null;
  daily_price_cents: number | null;
  observed_at: string | null;
  job_status: JobStatus | null;
  job_error: string | null;
}

export interface Product extends Omit<ProductRow, "actual_price_cents" | "daily_price_cents"> {
  actual_price: number | null;
  daily_price: number | null;
}

export interface Job {
  id: number;
  product_id: number;
  platform: Platform;
  item_id: string;
  product_name: string;
  status: JobStatus;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface ClaimedJob extends Job {
  run_token: string;
}

interface ObservationRow {
  id: number;
  product_id: number;
  actual_price_cents: number;
  daily_price_cents: number | null;
  observed_at: string;
  source: "manual" | "crawl";
  source_url: string;
}

export interface Observation extends Omit<ObservationRow, "actual_price_cents" | "daily_price_cents"> {
  actual_price: number;
  daily_price: number | null;
}

export interface CapturedItem {
  item_name: string;
  shop_name: string;
  actual_price: number | null;
  daily_price: number | null;
  source_url: string;
  observed_at: string;
}

export function priceToCents(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
    throw new DashboardError("价格必须是 0 到 10 亿之间的有效数字");
  }
  return Math.round(value * 100);
}

function fromCents(value: number | null) {
  return value === null ? null : value / 100;
}

function productFromRow(row: ProductRow): Product {
  const { actual_price_cents, daily_price_cents, ...product } = row;
  return {
    ...product,
    actual_price: fromCents(actual_price_cents),
    daily_price: fromCents(daily_price_cents),
  };
}

function observationFromRow(row: ObservationRow): Observation {
  const { actual_price_cents, daily_price_cents, ...observation } = row;
  return {
    ...observation,
    actual_price: actual_price_cents / 100,
    daily_price: fromCents(daily_price_cents),
  };
}

function historyRange(days: number, now: Date) {
  const beijingToday = new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
  const today = Date.parse(`${beijingToday}T00:00:00Z`);
  const dates = Array.from({ length: days }, (_, index) =>
    new Date(today - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10),
  );
  return {
    dates,
    start: new Date(Date.parse(`${dates[0]}T00:00:00+08:00`)).toISOString(),
    end: new Date(Date.parse(`${beijingToday}T00:00:00+08:00`) + 86_400_000).toISOString(),
  };
}

const productSelect = `
  SELECT p.*, o.actual_price_cents, o.daily_price_cents, o.observed_at,
         j.status AS job_status, j.error AS job_error
  FROM products p
  LEFT JOIN price_observations o ON o.id = (
    SELECT id FROM price_observations WHERE product_id = p.id
    ORDER BY observed_at DESC, id DESC LIMIT 1
  )
  LEFT JOIN jobs j ON j.id = (
    SELECT id FROM jobs WHERE product_id = p.id ORDER BY id DESC LIMIT 1
  )`;

const jobSelect = `
  SELECT j.id, j.product_id, p.platform, p.item_id,
         COALESCE(NULLIF(p.name, ''), NULLIF(p.item_name, ''), p.item_id) AS product_name,
         j.status, j.error, j.created_at, j.started_at, j.finished_at
  FROM jobs j JOIN products p ON p.id = j.product_id`;

const observationSelect = `
  SELECT id, product_id, actual_price_cents, daily_price_cents,
         observed_at, source, source_url FROM price_observations`;

export class DashboardStore {
  readonly db: Database;

  constructor(filename: string) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename, { create: true, strict: true });
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL CHECK(platform IN ('jd', 'taobao')),
        item_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        item_name TEXT NOT NULL DEFAULT '',
        shop_name TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(platform, item_id)
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed')),
        error TEXT,
        run_token TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active
        ON jobs(product_id) WHERE status IN ('queued', 'running');
      CREATE INDEX IF NOT EXISTS jobs_status_id ON jobs(status, id);
      CREATE INDEX IF NOT EXISTS jobs_product_id ON jobs(product_id, id);
      CREATE TABLE IF NOT EXISTS price_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        job_id INTEGER UNIQUE REFERENCES jobs(id) ON DELETE SET NULL,
        actual_price_cents INTEGER NOT NULL CHECK(actual_price_cents >= 0),
        daily_price_cents INTEGER CHECK(daily_price_cents >= 0),
        observed_at TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('manual', 'crawl')),
        source_url TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS observations_product_time
        ON price_observations(product_id, observed_at, id);
    `);
  }

  close() {
    this.db.close();
  }

  listProducts(search = "") {
    const term = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    return this.db.query<ProductRow, [string, string, string, string]>(`${productSelect}
      WHERE p.item_id LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\'
         OR p.item_name LIKE ? ESCAPE '\\' OR p.notes LIKE ? ESCAPE '\\'
      ORDER BY p.id DESC`).all(term, term, term, term).map(productFromRow);
  }

  getProduct(id: number): Product | null {
    const row = this.db.query<ProductRow, [number]>(`${productSelect} WHERE p.id = ?`).get(id);
    return row ? productFromRow(row) : null;
  }

  requireProduct(id: number) {
    const product = this.getProduct(id);
    if (!product) throw new DashboardError("商品不存在", 404);
    return product;
  }

  createProducts(platform: Platform, itemIds: string[], name = "", notes = "") {
    return this.db.transaction(() => {
      const timestamp = new Date().toISOString();
      let created = 0;
      const products: Product[] = [];
      for (const itemId of new Set(itemIds)) {
        const result = this.db.query(`
          INSERT INTO products (platform, item_id, name, notes, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(platform, item_id) DO NOTHING
        `).run(platform, itemId, name, notes, timestamp, timestamp);
        created += result.changes;
        const row = this.db.query<{ id: number }, [Platform, string]>(
          "SELECT id FROM products WHERE platform = ? AND item_id = ?",
        ).get(platform, itemId)!;
        products.push(this.requireProduct(row.id));
      }
      return { products, created, existing: products.length - created };
    })();
  }

  updateProduct(id: number, changes: { name?: string; notes?: string }) {
    const product = this.requireProduct(id);
    this.db.query("UPDATE products SET name = ?, notes = ?, updated_at = ? WHERE id = ?")
      .run(changes.name ?? product.name, changes.notes ?? product.notes, new Date().toISOString(), id);
    return this.requireProduct(id);
  }

  deleteProduct(id: number) {
    this.requireProduct(id);
    this.db.query("DELETE FROM products WHERE id = ?").run(id);
  }

  enqueue(productIds: number[]) {
    return this.db.transaction(() => {
      const ids = [...new Set(productIds)];
      ids.forEach((id) => this.requireProduct(id));
      const jobs: Job[] = [];
      let created = 0;
      for (const id of ids) {
        const result = this.db.query(`
          INSERT OR IGNORE INTO jobs (product_id, status, created_at) VALUES (?, 'queued', ?)
        `).run(id, new Date().toISOString());
        created += result.changes;
        jobs.push(this.db.query<Job, [number]>(`${jobSelect}
          WHERE j.product_id = ? AND j.status IN ('queued', 'running')`).get(id)!);
      }
      return { jobs, created, existing: ids.length - created };
    })();
  }

  listJobs() {
    // Keep every active job visible, plus the latest 50 completed jobs.
    return this.db.query<Job, []>(`${jobSelect}
      WHERE j.status IN ('queued', 'running') OR j.id IN (
        SELECT id FROM jobs WHERE status IN ('succeeded', 'failed') ORDER BY id DESC LIMIT 50
      ) ORDER BY j.id DESC`).all();
  }

  recoverJobs() {
    this.db.query(`UPDATE jobs SET status = 'queued', run_token = NULL,
      started_at = NULL, finished_at = NULL, error = NULL WHERE status = 'running'`).run();
  }

  claimJob(): ClaimedJob | null {
    return this.db.transaction(() => {
      const job = this.db.query<Job, []>(`${jobSelect}
        WHERE j.status = 'queued' ORDER BY j.id LIMIT 1`).get();
      if (!job) return null;
      const runToken = crypto.randomUUID();
      const startedAt = new Date().toISOString();
      this.db.query("UPDATE jobs SET status = 'running', run_token = ?, started_at = ? WHERE id = ?")
        .run(runToken, startedAt, job.id);
      return { ...job, status: "running" as const, run_token: runToken, started_at: startedAt };
    })();
  }

  completeJob(job: ClaimedJob, item: CapturedItem) {
    if (item.actual_price === null) throw new DashboardError("页面未识别到有效实际价，请确认登录态或商品规格");
    const actual = priceToCents(item.actual_price);
    const daily = item.daily_price === null ? null : priceToCents(item.daily_price);
    const observedAt = normalizeTimestamp(item.observed_at);
    return this.db.transaction(() => {
      // A deleted product or an old hot-reload worker must never recreate data.
      const active = this.db.query<{ id: number }, [number, string]>(
        "SELECT id FROM jobs WHERE id = ? AND status = 'running' AND run_token = ?",
      ).get(job.id, job.run_token);
      if (!active) return false;
      this.db.query(`INSERT INTO price_observations
        (product_id, job_id, actual_price_cents, daily_price_cents, observed_at, source, source_url)
        VALUES (?, ?, ?, ?, ?, 'crawl', ?)`)
        .run(job.product_id, job.id, actual, daily, observedAt, item.source_url);
      this.db.query("UPDATE products SET item_name = ?, shop_name = ?, updated_at = ? WHERE id = ?")
        .run(item.item_name, item.shop_name, new Date().toISOString(), job.product_id);
      this.db.query("UPDATE jobs SET status = 'succeeded', finished_at = ?, run_token = NULL WHERE id = ?")
        .run(new Date().toISOString(), job.id);
      return true;
    })();
  }

  failJob(job: ClaimedJob, error: string) {
    this.db.query(`UPDATE jobs SET status = 'failed', error = ?, finished_at = ?, run_token = NULL
      WHERE id = ? AND status = 'running' AND run_token = ?`)
      .run(error.slice(0, 2000), new Date().toISOString(), job.id, job.run_token);
  }

  requeueJob(job: ClaimedJob) {
    this.db.query(`UPDATE jobs SET status = 'queued', run_token = NULL, started_at = NULL
      WHERE id = ? AND status = 'running' AND run_token = ?`).run(job.id, job.run_token);
  }

  addObservation(productId: number, input: { actual_price: number; daily_price: number | null; observed_at: string }) {
    this.requireProduct(productId);
    const result = this.db.query(`INSERT INTO price_observations
      (product_id, actual_price_cents, daily_price_cents, observed_at, source)
      VALUES (?, ?, ?, ?, 'manual')`).run(
      productId, priceToCents(input.actual_price),
      input.daily_price === null ? null : priceToCents(input.daily_price),
      normalizeTimestamp(input.observed_at),
    );
    return observationFromRow(this.db.query<ObservationRow, [number]>(
      `${observationSelect} WHERE id = ?`,
    ).get(Number(result.lastInsertRowid))!);
  }

  deleteObservation(id: number) {
    if (!this.db.query("DELETE FROM price_observations WHERE id = ?").run(id).changes) {
      throw new DashboardError("价格记录不存在", 404);
    }
  }

  history(productId: number, days: number, now = new Date()) {
    this.requireProduct(productId);
    const { dates, start, end } = historyRange(days, now);
    const observations = this.db.query<ObservationRow, [number, string, string]>(
      `${observationSelect} WHERE product_id = ? AND observed_at >= ? AND observed_at < ?
       ORDER BY observed_at, id`,
    ).all(productId, start, end).map(observationFromRow);
    const lastByDay = new Map<string, Observation>();
    for (const observation of observations) {
      const day = new Date(Date.parse(observation.observed_at) + 8 * 3_600_000).toISOString().slice(0, 10);
      lastByDay.set(day, observation);
    }
    return {
      product_id: productId,
      days,
      points: dates.map((date) => ({
        date,
        actual_price: lastByDay.get(date)?.actual_price ?? null,
        daily_price: lastByDay.get(date)?.daily_price ?? null,
      })),
      observations: observations.slice(-100).reverse(),
      total_observations: observations.length,
    };
  }

  averageHistory(days: number, platform?: Platform, productIds?: number[], now = new Date()) {
    const { dates, start, end } = historyRange(days, now);
    const params: (string | number)[] = [start, end];
    let filter = "";
    if (platform) { filter += " AND p.platform = ?"; params.push(platform); }
    if (productIds !== undefined) {
      const ids = [...new Set(productIds)];
      for (const id of ids) {
        const product = this.requireProduct(id);
        if (platform && product.platform !== platform) throw new DashboardError("所选商品不属于当前平台");
      }
      filter += ids.length ? ` AND p.id IN (${ids.map(() => "?").join(",")})` : " AND 0";
      params.push(...ids);
    }
    const rows = this.db.query<{
      platform: Platform; day: string; average_cents: number; sample_count: number;
    }, (string | number)[]>(`
      WITH ranked AS (
        SELECT p.platform, date(o.observed_at, '+8 hours') AS day, o.actual_price_cents,
          ROW_NUMBER() OVER (
            PARTITION BY o.product_id, date(o.observed_at, '+8 hours')
            ORDER BY o.observed_at DESC, o.id DESC
          ) AS sample_rank
        FROM price_observations o JOIN products p ON p.id = o.product_id
        WHERE o.observed_at >= ? AND o.observed_at < ? ${filter}
      )
      SELECT platform, day, AVG(actual_price_cents) AS average_cents, COUNT(*) AS sample_count
      FROM ranked WHERE sample_rank = 1 GROUP BY platform, day
    `).all(...params);
    const byDay = new Map(rows.map((row) => [`${row.platform}:${row.day}`, row]));
    return {
      days,
      series: (platform ? [platform] : ["taobao", "jd"] as Platform[]).map((source) => ({
        platform: source,
        points: dates.map((date) => {
          const row = byDay.get(`${source}:${date}`);
          return {
            date,
            actual_price: row ? Math.round(row.average_cents) / 100 : null,
            sample_count: row?.sample_count ?? 0,
          };
        }),
      })),
    };
  }
}

export function normalizeTimestamp(value: string) {
  // Require an explicit timezone; otherwise results depend on the server's locale.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new DashboardError("时间必须为带时区的 ISO 日期");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new DashboardError("时间无效");
  const day = value.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
    throw new DashboardError("日期无效");
  }
  return new Date(timestamp).toISOString();
}
