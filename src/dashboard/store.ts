import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Platform = "jd" | "taobao";
export type JobStatus = "queued" | "running" | "succeeded" | "failed";
export type TimeRange = "6h" | "1d" | "3d" | "7d" | "15d";
export type TimeRangeInput = TimeRange | number;

const BEIJING_OFFSET_MS = 8 * 3_600_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

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
  group_id: number | null;
  group_name: string | null;
  group_specification: string | null;
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

export interface ProductGroup {
  id: number;
  name: string;
  specification: string;
  notes: string;
  created_at: string;
  updated_at: string;
  member_count: number;
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

function beijingBucket(value: string, bucket: "hour" | "day") {
  const local = new Date(Date.parse(value) + BEIJING_OFFSET_MS).toISOString();
  return bucket === "hour"
    ? `${local.slice(0, 13).replace("T", " ")}:00`
    : local.slice(0, 10);
}

function formatBeijingHour(localEpochMs: number) {
  return `${new Date(localEpochMs).toISOString().slice(0, 13).replace("T", " ")}:00`;
}

function historyRange(input: TimeRangeInput, now: Date) {
  const beijingNow = now.getTime() + BEIJING_OFFSET_MS;
  if (input === "6h") {
    const currentHour = Math.floor(beijingNow / HOUR_MS) * HOUR_MS;
    const dates = Array.from({ length: 6 }, (_, index) =>
      formatBeijingHour(currentHour - (5 - index) * HOUR_MS),
    );
    return {
      range: "6h",
      days: 0,
      hours: 6,
      bucket: "hour" as const,
      bucketExpression: "strftime('%Y-%m-%d %H:00', o.observed_at, '+8 hours')",
      dates,
      start: new Date(currentHour - 5 * HOUR_MS - BEIJING_OFFSET_MS).toISOString(),
      end: now.toISOString(),
    };
  }

  const days = typeof input === "number" ? input : Number(input.slice(0, -1));
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new DashboardError("时间范围必须是 6 小时、1 天、3 天、7 天或 15 天");
  }
  const beijingToday = new Date(beijingNow).toISOString().slice(0, 10);
  const today = Math.floor(beijingNow / DAY_MS) * DAY_MS;
  const dates = Array.from({ length: days }, (_, index) =>
    new Date(today - (days - 1 - index) * DAY_MS).toISOString().slice(0, 10),
  );
  return {
    range: typeof input === "number" ? `${days}d` : input,
    days,
    hours: days * 24,
    bucket: "day" as const,
    bucketExpression: "date(o.observed_at, '+8 hours')",
    dates,
    start: new Date(today - (days - 1) * DAY_MS - BEIJING_OFFSET_MS).toISOString(),
    end: new Date(today + DAY_MS - BEIJING_OFFSET_MS).toISOString(),
  };
}

const productSelect = `
  SELECT p.*, o.actual_price_cents, o.daily_price_cents, o.observed_at,
         j.status AS job_status, j.error AS job_error,
         gm.group_id, g.name AS group_name, g.specification AS group_specification
  FROM products p
  LEFT JOIN group_members gm ON gm.product_id = p.id
  LEFT JOIN product_groups g ON g.id = gm.group_id
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

const groupSelect = `
  SELECT g.*, (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count
  FROM product_groups g`;

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
      CREATE TABLE IF NOT EXISTS product_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        specification TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(name, specification)
      );
      CREATE TABLE IF NOT EXISTS group_members (
        group_id INTEGER NOT NULL REFERENCES product_groups(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
        PRIMARY KEY(group_id, product_id)
      );
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

  listGroups() {
    return this.db.query<ProductGroup, []>(`${groupSelect} ORDER BY g.id DESC`).all();
  }

  requireGroup(id: number) {
    const group = this.db.query<ProductGroup, [number]>(`${groupSelect} WHERE g.id = ?`).get(id);
    if (!group) throw new DashboardError("同款商品组不存在", 404);
    return group;
  }

  createGroup(name: string, specification: string, notes = "") {
    if (this.db.query("SELECT id FROM product_groups WHERE name = ? AND specification = ?").get(name, specification)) {
      throw new DashboardError("该名称和规格的商品组已存在", 409);
    }
    const timestamp = new Date().toISOString();
    const result = this.db.query(`INSERT INTO product_groups
      (name, specification, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(name, specification, notes, timestamp, timestamp);
    return this.requireGroup(Number(result.lastInsertRowid));
  }

  updateGroup(id: number, changes: { name?: string; specification?: string; notes?: string }) {
    const group = this.requireGroup(id);
    const name = changes.name ?? group.name;
    const specification = changes.specification ?? group.specification;
    if (group.member_count && specification !== group.specification) {
      throw new DashboardError("请先移出已关联 SKU，再修改商品组规格", 409);
    }
    if (this.db.query("SELECT id FROM product_groups WHERE name = ? AND specification = ? AND id <> ?")
      .get(name, specification, id)) throw new DashboardError("该名称和规格的商品组已存在", 409);
    this.db.query("UPDATE product_groups SET name = ?, specification = ?, notes = ?, updated_at = ? WHERE id = ?")
      .run(name, specification, changes.notes ?? group.notes, new Date().toISOString(), id);
    return this.requireGroup(id);
  }

  deleteGroup(id: number) {
    this.requireGroup(id);
    // Cascades only the membership links; listings, observations and jobs remain.
    this.db.query("DELETE FROM product_groups WHERE id = ?").run(id);
  }

  groupMembers(id: number) {
    this.requireGroup(id);
    return this.db.query<ProductRow, [number]>(`${productSelect}
      WHERE gm.group_id = ? ORDER BY p.platform, p.id`).all(id).map(productFromRow);
  }

  addGroupMembers(groupId: number, productIds: number[]) {
    return this.db.transaction(() => {
      this.requireGroup(groupId);
      const ids = [...new Set(productIds)];
      for (const id of ids) {
        const product = this.requireProduct(id);
        if (product.group_id !== null && product.group_id !== groupId) {
          throw new DashboardError(`商品 ${product.item_id} 已属于「${product.group_name}」，请先从原组移出`, 409);
        }
      }
      let created = 0;
      for (const id of ids) created += this.db.query(
        "INSERT OR IGNORE INTO group_members (group_id, product_id) VALUES (?, ?)",
      ).run(groupId, id).changes;
      this.db.query("UPDATE product_groups SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), groupId);
      return { created, existing: ids.length - created, group: this.requireGroup(groupId) };
    })();
  }

  removeGroupMember(groupId: number, productId: number) {
    this.requireGroup(groupId);
    if (!this.db.query("DELETE FROM group_members WHERE group_id = ? AND product_id = ?").run(groupId, productId).changes) {
      throw new DashboardError("该 SKU 不在此商品组中", 404);
    }
    this.db.query("UPDATE product_groups SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), groupId);
  }

  groupComparison(groupId: number, rangeInput: TimeRangeInput, now = new Date()) {
    const group = this.requireGroup(groupId);
    const members = this.groupMembers(groupId);
    const today = new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
    const quoted = members.filter((member) => member.actual_price !== null && member.observed_at !== null);
    const dayOf = (value: string) => new Date(Date.parse(value) + 8 * 3_600_000).toISOString().slice(0, 10);
    const quoteDates = quoted.map((member) => dayOf(member.observed_at!)).filter((date) => date <= today).sort();
    const comparisonDate = quoteDates[quoteDates.length - 1] ?? null;
    const current = quoted.filter((member) => dayOf(member.observed_at!) === comparisonDate);
    const prices = current.map((member) => priceToCents(member.actual_price!));
    const minimum = prices.length ? Math.min(...prices) / 100 : null;
    const range = historyRange(rangeInput, now);
    const { start, end } = range;
    const rows = this.db.query<{
      product_id: number; bucket: string; actual_price_cents: number;
    }, [number, string, string]>(`
      WITH ranked AS (
        SELECT o.product_id, ${range.bucketExpression} AS bucket, o.actual_price_cents,
          ROW_NUMBER() OVER (
            PARTITION BY o.product_id, ${range.bucketExpression}
            ORDER BY o.observed_at DESC, o.id DESC
          ) AS sample_rank
        FROM price_observations o JOIN group_members gm ON gm.product_id = o.product_id
        WHERE gm.group_id = ? AND o.observed_at >= ? AND o.observed_at < ?
      )
      SELECT product_id, bucket, actual_price_cents FROM ranked WHERE sample_rank = 1
    `).all(groupId, start, end);
    const byProduct = new Map(rows.map((row) => [`${row.product_id}:${row.bucket}`, row.actual_price_cents]));
    const dayTotals = new Map<string, { sum: number; count: number }>();
    for (const row of rows) {
      const total = dayTotals.get(row.bucket) ?? { sum: 0, count: 0 };
      total.sum += row.actual_price_cents;
      total.count++;
      dayTotals.set(row.bucket, total);
    }
    return {
      group,
      comparison_date: comparisonDate,
      valid_count: current.length,
      average_actual_price: prices.length ? Math.round(prices.reduce((sum, price) => sum + price, 0) / prices.length) / 100 : null,
      lowest_price: minimum,
      highest_price: prices.length ? Math.max(...prices) / 100 : null,
      cheapest_product_ids: current.filter((member) => member.actual_price === minimum).map((member) => member.id),
      members: members.map((member) => ({
        ...member,
        comparison_status: member.actual_price === null || member.observed_at === null
          ? "missing" as const : dayOf(member.observed_at) === comparisonDate ? "current" as const : "stale" as const,
      })),
      range: range.range,
      days: range.days,
      hours: range.hours,
      points: range.dates.map((date) => {
        const total = dayTotals.get(date);
        return { date, actual_price: total ? Math.round(total.sum / total.count) / 100 : null, sample_count: total?.count ?? 0 };
      }),
      series: members.map((member) => ({
        product_id: member.id,
        platform: member.platform,
        item_id: member.item_id,
        shop_name: member.shop_name,
        name: member.name || member.item_name || member.item_id,
        points: range.dates.map((date) => ({ date, actual_price: fromCents(byProduct.get(`${member.id}:${date}`) ?? null) })),
      })),
    };
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

  history(productId: number, rangeInput: TimeRangeInput, now = new Date()) {
    this.requireProduct(productId);
    const range = historyRange(rangeInput, now);
    const observations = this.db.query<ObservationRow, [number, string, string]>(
      `${observationSelect} WHERE product_id = ? AND observed_at >= ? AND observed_at < ?
       ORDER BY observed_at, id`,
    ).all(productId, range.start, range.end).map(observationFromRow);
    const lastByBucket = new Map<string, Observation>();
    for (const observation of observations) {
      lastByBucket.set(beijingBucket(observation.observed_at, range.bucket), observation);
    }
    return {
      product_id: productId,
      range: range.range,
      days: range.days,
      hours: range.hours,
      points: range.dates.map((date) => ({
        date,
        actual_price: lastByBucket.get(date)?.actual_price ?? null,
        daily_price: lastByBucket.get(date)?.daily_price ?? null,
      })),
      observations: observations.slice(-100).reverse(),
      total_observations: observations.length,
    };
  }

  averageHistory(rangeInput: TimeRangeInput, platform?: Platform, productIds?: number[], now = new Date()) {
    const range = historyRange(rangeInput, now);
    const { start, end } = range;
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
      platform: Platform; bucket: string; average_cents: number; sample_count: number;
    }, (string | number)[]>(`
      WITH ranked AS (
        SELECT p.platform, ${range.bucketExpression} AS bucket, o.actual_price_cents,
          ROW_NUMBER() OVER (
            PARTITION BY o.product_id, ${range.bucketExpression}
            ORDER BY o.observed_at DESC, o.id DESC
          ) AS sample_rank
        FROM price_observations o JOIN products p ON p.id = o.product_id
        WHERE o.observed_at >= ? AND o.observed_at < ? ${filter}
      )
      SELECT platform, bucket, AVG(actual_price_cents) AS average_cents, COUNT(*) AS sample_count
      FROM ranked WHERE sample_rank = 1 GROUP BY platform, bucket
    `).all(...params);
    const byBucket = new Map(rows.map((row) => [`${row.platform}:${row.bucket}`, row]));
    return {
      range: range.range,
      days: range.days,
      hours: range.hours,
      series: (platform ? [platform] : ["taobao", "jd"] as Platform[]).map((source) => ({
        platform: source,
        points: range.dates.map((date) => {
          const row = byBucket.get(`${source}:${date}`);
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
