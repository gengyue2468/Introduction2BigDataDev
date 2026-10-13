export type Platform = "jd" | "taobao";

export interface MarketplaceItem {
  sku_id?: string;
  item_id?: string;
  item_name: string;
  shop_name: string;
  daily_price: number | null;
  actual_price: number | null;
  source_url: string;
  observed_at: string;
  error?: string;
}

export interface HealthResponse {
  status: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function requestJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = sessionStorage.getItem("viewview.access-token");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init?.body) headers.set("Content-Type", "application/json");
  const response = await fetch(input, { ...init, headers });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new ApiError(
      payload.message || payload.error || `请求失败（${response.status}）`,
      response.status,
    );
  }

  return payload as T;
}

export async function fetchHealth(signal?: AbortSignal) {
  return requestJson<HealthResponse>("/health", { signal });
}

export async function fetchMarketplaceItem(
  platform: Platform,
  id: string,
  signal?: AbortSignal,
): Promise<MarketplaceItem> {
  const endpoint =
    platform === "jd"
      ? `/jd/items/${encodeURIComponent(id)}`
      : `/taobao/items/${encodeURIComponent(id)}`;
  return requestJson<MarketplaceItem>(endpoint, { signal });
}

export function platformLabel(platform: Platform): string {
  return platform === "jd" ? "京东" : "淘宝";
}

export function itemIdLabel(platform: Platform): string {
  return platform === "jd" ? "SKU ID" : "Item ID";
}

export function itemIdOf(item: MarketplaceItem, platform: Platform): string {
  return platform === "jd" ? item.sku_id || "—" : item.item_id || "—";
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface Product {
  id: number;
  platform: Platform;
  item_id: string;
  name: string;
  item_name: string;
  shop_name: string;
  notes: string;
  actual_price: number | null;
  daily_price: number | null;
  observed_at: string | null;
  job_status: JobStatus | null;
  job_error: string | null;
  created_at: string;
  updated_at: string;
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

export interface PricePoint {
  date: string;
  actual_price: number | null;
  daily_price?: number | null;
  sample_count?: number;
}

export interface AverageHistory {
  days: number;
  series: { platform: Platform; points: PricePoint[] }[];
}

export interface Observation {
  id: number;
  product_id: number;
  actual_price: number;
  daily_price: number | null;
  observed_at: string;
  source: "manual" | "crawl";
  source_url: string;
}

export interface PriceHistory {
  product_id: number;
  days: number;
  points: PricePoint[];
  observations: Observation[];
  total_observations: number;
}

export function productLabel(product: Product) {
  return product.name || product.item_name || product.item_id;
}

export function fetchProducts(signal?: AbortSignal) {
  return requestJson<{ products: Product[] }>("/api/products", { signal });
}

export function createProducts(input: { platform: Platform; item_ids: string[]; name: string; notes: string }) {
  return requestJson<{ products: Product[]; created: number; existing: number }>("/api/products", {
    method: "POST", body: JSON.stringify(input),
  });
}

export function updateProduct(id: number, input: { name: string; notes: string }) {
  return requestJson<Product>(`/api/products/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteProduct(id: number) {
  return requestJson<{ deleted: boolean }>(`/api/products/${id}`, { method: "DELETE" });
}

export function fetchJobs(signal?: AbortSignal) {
  return requestJson<{ jobs: Job[] }>("/api/jobs", { signal });
}

export function enqueueProducts(productIds: number[]) {
  return requestJson<{ jobs: Job[]; created: number; existing: number }>("/api/jobs", {
    method: "POST", body: JSON.stringify({ product_ids: productIds }),
  });
}

export function fetchHistory(productId: number, days: number, signal?: AbortSignal) {
  return requestJson<PriceHistory>(`/api/products/${productId}/history?days=${days}`, { signal });
}

export function fetchAverageHistory(days: number, platform?: Platform, productIds?: number[], signal?: AbortSignal) {
  const query = new URLSearchParams({ days: String(days) });
  if (platform) query.set("platform", platform);
  for (const id of productIds ?? []) query.append("product_id", String(id));
  return requestJson<AverageHistory>(`/api/history/average?${query}`, { signal });
}

export function addObservation(productId: number, input: {
  actual_price: number; daily_price: number | null; observed_at: string;
}) {
  return requestJson<Observation>(`/api/products/${productId}/observations`, {
    method: "POST", body: JSON.stringify(input),
  });
}

export function deleteObservation(id: number) {
  return requestJson<{ deleted: boolean }>(`/api/observations/${id}`, { method: "DELETE" });
}
