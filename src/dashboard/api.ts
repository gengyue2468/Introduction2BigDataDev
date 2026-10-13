import { Hono, type Context } from "hono";
import { DashboardError, DashboardStore, type Platform, type TimeRange, type TimeRangeInput } from "./store";
import { DashboardQueue } from "./queue";

async function readBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new DashboardError("请求体必须是 JSON 对象");
  }
}

function positiveId(value: unknown) {
  if ((typeof value !== "string" && typeof value !== "number") || !/^\d+$/.test(String(value))) {
    throw new DashboardError("记录 ID 无效");
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new DashboardError("记录 ID 无效");
  return id;
}

function text(value: unknown, label: string, max: number) {
  if (typeof value !== "string" || value.length > max) throw new DashboardError(`${label}无效（最多 ${max} 字）`);
  return value.trim();
}

function requiredText(value: unknown, label: string, max: number) {
  const result = text(value, label, max);
  if (!result) throw new DashboardError(`${label}不能为空`);
  return result;
}

const allowedTimeRanges = new Set<TimeRange>(["6h", "1d", "3d", "7d", "15d"]);

function timeRange(c: Context): TimeRangeInput {
  const requested = c.req.query("range");
  if (requested !== undefined) {
    if (!allowedTimeRanges.has(requested as TimeRange)) {
      throw new DashboardError("时间范围只能是 6h、1d、3d、7d 或 15d");
    }
    return requested as TimeRange;
  }

  // Keep the old days query working for existing clients, while the UI uses
  // the smaller fixed range set above.
  const legacyDays = Number(c.req.query("days") ?? 7);
  if (!Number.isInteger(legacyDays) || legacyDays < 1 || legacyDays > 365) {
    throw new DashboardError("时间范围只能是 6 小时、1 天、3 天、7 天或 15 天");
  }
  return legacyDays;
}

export function createDashboardAPI(store: DashboardStore, queue: DashboardQueue, accessToken = "") {
  const api = new Hono();
  api.onError((error, c) => {
    if (error instanceof DashboardError) {
      return c.json({ error: error.message }, error.status as 400 | 404 | 409);
    }
    console.error("[dashboard api]", error);
    return c.json({ error: "数据库操作失败" }, 500);
  });

  api.use("*", async (c, next) => {
    if (accessToken && c.req.header("Authorization") !== `Bearer ${accessToken}`) {
      return c.json({ error: "请输入 API 密钥" }, 401);
    }
    // Mutating requests from browsers must originate from this API or the local WebUI.
    const origin = c.req.header("Origin");
    if (origin && c.req.method !== "GET") {
      const allowed = [new URL(c.req.url).origin, "http://127.0.0.1:5173", "http://localhost:5173"];
      if (!allowed.includes(origin)) return c.json({ error: "不允许的请求来源" }, 403);
    }
    await next();
  });

  api.get("/products", (c) => c.json({ products: store.listProducts((c.req.query("q") ?? "").slice(0, 200)) }));
  api.get("/products/:id", (c) => c.json(store.requireProduct(positiveId(c.req.param("id")))));
  api.post("/products", async (c) => {
    const body = await readBody(c);
    if (body.platform !== "jd" && body.platform !== "taobao") throw new DashboardError("平台必须是 jd 或 taobao");
    const values = body.item_ids ?? (body.item_id === undefined ? [] : [body.item_id]);
    if (!Array.isArray(values) || !values.length || values.length > 100) throw new DashboardError("一次可新增 1 到 100 个商品");
    const itemIds = values.map((value) => {
      if (typeof value !== "string" || !/^\d{1,32}$/.test(value.trim())) throw new DashboardError("商品 ID 必须为 1 到 32 位数字字符串");
      return value.trim();
    });
    const result = store.createProducts(body.platform as Platform, itemIds,
      body.name === undefined ? "" : text(body.name, "名称", 250),
      body.notes === undefined ? "" : text(body.notes, "备注", 1000));
    return c.json(result, result.created ? 201 : 200);
  });
  api.patch("/products/:id", async (c) => {
    const body = await readBody(c);
    if (Object.keys(body).some((key) => key !== "name" && key !== "notes")) {
      throw new DashboardError("只能编辑名称和备注；更换平台或商品 ID 请新增商品");
    }
    if (body.name === undefined && body.notes === undefined) throw new DashboardError("至少需要一个修改字段");
    return c.json(store.updateProduct(positiveId(c.req.param("id")), {
      name: body.name === undefined ? undefined : text(body.name, "名称", 250),
      notes: body.notes === undefined ? undefined : text(body.notes, "备注", 1000),
    }));
  });
  api.delete("/products/:id", (c) => {
    const id = positiveId(c.req.param("id"));
    store.deleteProduct(id);
    queue.cancelProduct(id);
    return c.json({ deleted: true });
  });

  api.get("/groups", (c) => c.json({ groups: store.listGroups() }));
  api.post("/groups", async (c) => {
    const body = await readBody(c);
    return c.json(store.createGroup(
      requiredText(body.name, "同款名称", 250),
      requiredText(body.specification, "型号和规格", 500),
      body.notes === undefined ? "" : text(body.notes, "备注", 1000),
    ), 201);
  });
  api.patch("/groups/:id", async (c) => {
    const body = await readBody(c);
    const keys = Object.keys(body);
    if (!keys.length || keys.some((key) => !["name", "specification", "notes"].includes(key))) {
      throw new DashboardError("只能编辑同款名称、规格和备注");
    }
    return c.json(store.updateGroup(positiveId(c.req.param("id")), {
      name: body.name === undefined ? undefined : requiredText(body.name, "同款名称", 250),
      specification: body.specification === undefined ? undefined : requiredText(body.specification, "型号和规格", 500),
      notes: body.notes === undefined ? undefined : text(body.notes, "备注", 1000),
    }));
  });
  api.delete("/groups/:id", (c) => {
    store.deleteGroup(positiveId(c.req.param("id")));
    return c.json({ deleted: true });
  });
  api.post("/groups/:id/members", async (c) => {
    const body = await readBody(c);
    if (body.confirmed_same_model !== true) throw new DashboardError("请先确认所选 SKU 型号和规格一致");
    if (!Array.isArray(body.product_ids) || !body.product_ids.length || body.product_ids.length > 1000) {
      throw new DashboardError("一次可关联 1 到 1000 个 SKU");
    }
    return c.json(store.addGroupMembers(positiveId(c.req.param("id")), body.product_ids.map(positiveId)));
  });
  api.delete("/groups/:id/members/:productId", (c) => {
    store.removeGroupMember(positiveId(c.req.param("id")), positiveId(c.req.param("productId")));
    return c.json({ deleted: true });
  });
  api.post("/groups/:id/jobs", (c) => {
    const members = store.groupMembers(positiveId(c.req.param("id")));
    if (!members.length) throw new DashboardError("请先关联 SKU");
    const result = store.enqueue(members.map((member) => member.id));
    queue.wake();
    return c.json(result, 202);
  });
  api.get("/groups/:id/comparison", (c) => {
    return c.json(store.groupComparison(positiveId(c.req.param("id")), timeRange(c)));
  });

  api.get("/jobs", (c) => c.json({ jobs: store.listJobs() }));
  api.post("/jobs", async (c) => {
    const body = await readBody(c);
    if (!Array.isArray(body.product_ids) || !body.product_ids.length || body.product_ids.length > 100) {
      throw new DashboardError("一次可入队 1 到 100 个商品");
    }
    const result = store.enqueue(body.product_ids.map(positiveId));
    queue.wake();
    return c.json(result, 202);
  });

  api.get("/products/:id/history", (c) => {
    return c.json(store.history(positiveId(c.req.param("id")), timeRange(c)));
  });
  api.get("/history/average", (c) => {
    const range = timeRange(c);
    const platform = c.req.query("platform");
    if (platform !== undefined && platform !== "jd" && platform !== "taobao") {
      throw new DashboardError("平台必须是 jd 或 taobao");
    }
    const ids = c.req.queries("product_id");
    if (ids && ids.length > 1000) throw new DashboardError("一次最多统计 1000 个商品");
    return c.json(store.averageHistory(range, platform, ids?.map(positiveId)));
  });
  api.post("/products/:id/observations", async (c) => {
    const body = await readBody(c);
    if (typeof body.actual_price !== "number") throw new DashboardError("实际价必须是数字");
    if (body.daily_price !== undefined && body.daily_price !== null && typeof body.daily_price !== "number") {
      throw new DashboardError("日常价必须是数字或 null");
    }
    return c.json(store.addObservation(positiveId(c.req.param("id")), {
      actual_price: body.actual_price,
      daily_price: (body.daily_price as number | null | undefined) ?? null,
      observed_at: text(body.observed_at, "采集时间", 40),
    }), 201);
  });
  api.delete("/observations/:id", (c) => {
    store.deleteObservation(positiveId(c.req.param("id")));
    return c.json({ deleted: true });
  });

  api.all("*", (c) => c.json({ error: "接口不存在" }, 404));
  return api;
}
