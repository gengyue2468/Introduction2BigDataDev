import { afterEach, describe, expect, test } from "bun:test";
import { createDashboardAPI } from "./api";
import { DashboardQueue } from "./queue";
import { DashboardStore, normalizeTimestamp, priceToCents, type CapturedItem } from "./store";

const stores: DashboardStore[] = [];
const queues: DashboardQueue[] = [];

function createStore() {
  const store = new DashboardStore(":memory:");
  stores.push(store);
  return store;
}

function captured(price: number | null = 19.99): CapturedItem {
  return {
    item_name: "测试商品", shop_name: "测试店铺", actual_price: price,
    daily_price: 25, source_url: "https://item.jd.com/123.html",
    observed_at: "2026-10-13T02:00:00Z",
  };
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for queue");
    await Bun.sleep(1);
  }
}

afterEach(async () => {
  for (const queue of queues.splice(0)) await queue.stop();
  for (const store of stores.splice(0)) store.close();
});

describe("SQLite dashboard", () => {
  test("timestamps require a timezone and a real calendar date", () => {
    expect(normalizeTimestamp("2026-10-13T12:00:00+08:00")).toBe("2026-10-13T04:00:00.000Z");
    expect(() => normalizeTimestamp("2026-10-13T12:00:00")).toThrow();
    expect(() => normalizeTimestamp("2026-02-30T12:00:00+08:00")).toThrow();
  });

  test("add, query, edit, deduplicate and delete products with their data", () => {
    const store = createStore();
    const result = store.createProducts("jd", ["123", "123", "456"], "原名称", "原备注");
    expect(result.created).toBe(2);
    const product = result.products[0]!;
    expect(store.createProducts("jd", ["123"]).existing).toBe(1);
    expect(store.createProducts("taobao", ["123"]).created).toBe(1);
    expect(store.updateProduct(product.id, { name: "O'Reilly", notes: "100%" }).name).toBe("O'Reilly");
    expect(store.listProducts("100%")).toHaveLength(1);
    store.addObservation(product.id, { actual_price: 0, daily_price: null, observed_at: "2026-10-13T08:00:00+08:00" });
    store.enqueue([product.id]);
    store.deleteProduct(product.id);
    expect(store.getProduct(product.id)).toBeNull();
    expect(store.listJobs()).toHaveLength(0);
    expect(store.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM price_observations").get()!.count).toBe(0);
  });

  test("stores cents and recomputes latest price after deleting an observation", () => {
    const store = createStore();
    const product = store.createProducts("jd", ["123"]).products[0]!;
    store.addObservation(product.id, { actual_price: 19.99, daily_price: null, observed_at: "2026-10-12T00:00:00Z" });
    const next = store.addObservation(product.id, { actual_price: 18.5, daily_price: 20, observed_at: "2026-10-13T00:00:00Z" });
    expect(priceToCents(0.1 + 0.2)).toBe(30);
    expect(() => priceToCents(-1)).toThrow();
    expect(store.requireProduct(product.id).actual_price).toBe(18.5);
    store.deleteObservation(next.id);
    expect(store.requireProduct(product.id).actual_price).toBe(19.99);
  });

  test("daily history uses Beijing time, last sample, null gaps and the full calendar range", () => {
    const store = createStore();
    const product = store.createProducts("jd", ["123"]).products[0]!;
    store.addObservation(product.id, { actual_price: 10, daily_price: null, observed_at: "2026-10-10T16:30:00Z" });
    store.addObservation(product.id, { actual_price: 11, daily_price: null, observed_at: "2026-10-11T15:00:00Z" });
    store.addObservation(product.id, { actual_price: 9, daily_price: null, observed_at: "2026-10-12T16:01:00Z" });
    const result = store.history(product.id, 3, new Date("2026-10-13T06:00:00Z"));
    expect(result.points).toEqual([
      { date: "2026-10-11", actual_price: 11, daily_price: null },
      { date: "2026-10-12", actual_price: null, daily_price: null },
      { date: "2026-10-13", actual_price: 9, daily_price: null },
    ]);
    expect(result.total_observations).toBe(3);
  });

  test("enqueue is atomic and active jobs are unique", () => {
    const store = createStore();
    const ids = store.createProducts("jd", ["123", "456"]).products.map((product) => product.id);
    expect(() => store.enqueue([ids[0]!, 99999])).toThrow();
    expect(store.listJobs()).toHaveLength(0);
    expect(store.enqueue(ids).created).toBe(2);
    expect(store.enqueue(ids).existing).toBe(2);
    expect(store.listJobs()).toHaveLength(2);
  });

  test("daily averages weight each product once and keep marketplaces separate", () => {
    const store = createStore();
    const [first, second, missing] = store.createProducts("jd", ["123", "456", "789"]).products;
    const taobao = store.createProducts("taobao", ["123"]).products[0]!;
    const add = (id: number, price: number, time: string) => store.addObservation(id, {
      actual_price: price, daily_price: null, observed_at: time,
    });
    add(first!.id, 10, "2026-10-11T16:30:00Z"); // Beijing October 12
    add(first!.id, 30, "2026-10-12T15:00:00Z"); // Same day: only the last sample counts.
    add(second!.id, 10, "2026-10-12T04:00:00Z");
    add(taobao.id, 100, "2026-10-12T04:00:00Z");
    add(first!.id, 0, "2026-10-12T16:01:00Z"); // Beijing October 13; zero is a valid sample.
    const now = new Date("2026-10-13T06:00:00Z");
    const result = store.averageHistory(3, undefined, undefined, now);
    const jd = result.series.find((series) => series.platform === "jd")!;
    const tb = result.series.find((series) => series.platform === "taobao")!;
    expect(jd.points).toEqual([
      { date: "2026-10-11", actual_price: null, sample_count: 0 },
      { date: "2026-10-12", actual_price: 20, sample_count: 2 },
      { date: "2026-10-13", actual_price: 0, sample_count: 1 },
    ]);
    expect(tb.points[1]).toEqual({ date: "2026-10-12", actual_price: 100, sample_count: 1 });
    expect(tb.points[2]!.actual_price).toBeNull();
    expect(store.averageHistory(3, "jd", [first!.id], now).series[0]!.points[1]!.actual_price).toBe(30);
    expect(store.averageHistory(3, "jd", [missing!.id], now).series[0]!.points.every((point) => point.actual_price === null)).toBe(true);
    expect(store.averageHistory(3, "jd", [], now).series[0]!.points.every((point) => point.sample_count === 0)).toBe(true);
    expect(() => store.averageHistory(3, "jd", [taobao.id], now)).toThrow("当前平台");
  });

  test("deleting a sample or product recalculates the averages", () => {
    const store = createStore();
    const [first, second] = store.createProducts("jd", ["123", "456"]).products;
    const input = { daily_price: null, observed_at: "2026-10-13T04:00:00Z" };
    store.addObservation(first!.id, { ...input, actual_price: 10 });
    const latest = store.addObservation(first!.id, { ...input, actual_price: 20 });
    store.addObservation(second!.id, { ...input, actual_price: 40 });
    const now = new Date("2026-10-13T06:00:00Z");
    expect(store.averageHistory(1, "jd", undefined, now).series[0]!.points[0]!.actual_price).toBe(30);
    store.deleteObservation(latest.id);
    expect(store.averageHistory(1, "jd", undefined, now).series[0]!.points[0]!.actual_price).toBe(25);
    store.deleteProduct(second!.id);
    expect(store.averageHistory(1, "jd", undefined, now).series[0]!.points[0]).toEqual({
      date: "2026-10-13", actual_price: 10, sample_count: 1,
    });
  });

  test("restart recovers jobs and stale workers cannot overwrite the new attempt", () => {
    const store = createStore();
    const product = store.createProducts("jd", ["123"]).products[0]!;
    store.enqueue([product.id]);
    const old = store.claimJob()!;
    store.recoverJobs();
    const current = store.claimJob()!;
    expect(store.completeJob(old, captured(99))).toBe(false);
    expect(store.completeJob(current, captured(10))).toBe(true);
    expect(store.requireProduct(product.id).actual_price).toBe(10);
  });

  test("worker runs serially, writes successful samples, and preserves item failures", async () => {
    const store = createStore();
    const ids = store.createProducts("jd", ["123", "456"]).products.map((product) => product.id);
    let active = 0;
    let maxActive = 0;
    const queue = new DashboardQueue(store, async (job) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(2);
      active--;
      return captured(job.item_id === "123" ? 19.99 : null);
    });
    queues.push(queue);
    store.enqueue(ids);
    queue.start();
    await until(() => store.listJobs().every((job) => job.status !== "queued" && job.status !== "running"));
    expect(maxActive).toBe(1);
    expect(store.listJobs().map((job) => job.status)).toEqual(["failed", "succeeded"]);
    expect(store.requireProduct(ids[0]!).actual_price).toBe(19.99);
    expect(store.listJobs()[0]!.error).toContain("实际价");
  });

  test("deleting a product during collection does not recreate observations", async () => {
    const store = createStore();
    const product = store.createProducts("jd", ["123"]).products[0]!;
    let finish!: (item: CapturedItem) => void;
    const queue = new DashboardQueue(store, () => new Promise((resolve) => { finish = resolve; }));
    queues.push(queue);
    store.enqueue([product.id]);
    queue.start();
    await until(() => store.listJobs()[0]?.status === "running");
    store.deleteProduct(product.id);
    queue.cancelProduct(product.id);
    finish(captured());
    await queue.stop();
    expect(store.listProducts()).toHaveLength(0);
    expect(store.listJobs()).toHaveLength(0);
  });

  test("browser saturation requeues a job instead of recording a failed sample", async () => {
    const store = createStore();
    const product = store.createProducts("jd", ["123"]).products[0]!;
    let attempts = 0;
    const queue = new DashboardQueue(store, async () => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error("Too many reads"), { status: 429 });
      return captured();
    });
    queues.push(queue);
    store.enqueue([product.id]);
    queue.start();
    await until(() => attempts === 1 && store.listJobs()[0]?.status === "queued");
    await Bun.sleep(1);
    queue.wake();
    await until(() => store.listJobs()[0]?.status === "succeeded");
    expect(attempts).toBe(2);
    expect(store.history(product.id, 1, new Date("2026-10-13T06:00:00Z")).total_observations).toBe(1);
  });

  test("REST API validates requests, supports CRUD, enforces optional auth, and rejects foreign origins", async () => {
    const store = createStore();
    const queue = new DashboardQueue(store, async () => captured());
    queues.push(queue);
    const api = createDashboardAPI(store, queue);
    const create = await api.request("/products", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "jd", item_ids: ["123", "456"] }),
    });
    expect(create.status).toBe(201);
    const { products } = await create.json();
    const id = products[0].id;
    expect((await api.request("/products", { method: "POST", body: "{" })).status).toBe(400);
    expect((await api.request(`/products/${id}/history?days=0`)).status).toBe(400);
    const overview = await api.request("/history/average?days=7");
    expect(overview.status).toBe(200);
    expect((await overview.json()).series.map((series: { platform: string }) => series.platform)).toEqual(["taobao", "jd"]);
    expect((await api.request(`/history/average?platform=jd&product_id=${id}`)).status).toBe(200);
    expect((await api.request("/history/average?days=0")).status).toBe(400);
    expect((await api.request("/history/average?platform=invalid")).status).toBe(400);
    expect((await api.request("/history/average?product_id=nope")).status).toBe(400);
    expect((await api.request(`/products/${id}`, { method: "PATCH", body: JSON.stringify({ item_id: "789" }) })).status).toBe(400);
    expect((await api.request(`/products/${id}`, { method: "PATCH", body: JSON.stringify({ name: "新名称" }) })).status).toBe(200);
    const sample = await api.request(`/products/${id}/observations`, {
      method: "POST", body: JSON.stringify({ actual_price: 20, observed_at: "2026-10-13T12:00:00+08:00" }),
    });
    expect(sample.status).toBe(201);
    expect((await api.request(`/observations/${(await sample.json()).id}`, { method: "DELETE" })).status).toBe(200);
    expect((await api.request("/jobs", { method: "POST", body: JSON.stringify({ product_ids: [id] }) })).status).toBe(202);
    expect((await api.request(`/products/${id}`, { method: "DELETE", headers: { Origin: "https://other.example" } })).status).toBe(403);
    expect((await api.request(`/products/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await api.request(`/products/${id}`)).status).toBe(404);
    expect((await api.request("/unknown")).status).toBe(404);
    const secured = createDashboardAPI(store, queue, "test-token");
    expect((await secured.request("/products")).status).toBe(401);
    expect((await secured.request("/products", { headers: { Authorization: "Bearer test-token" } })).status).toBe(200);
  });
});
