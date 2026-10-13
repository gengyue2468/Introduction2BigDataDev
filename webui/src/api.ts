export type Platform = "jd" | "taobao";
export type TimeRange = "6h" | "1d" | "3d" | "7d" | "15d";

export const timeRangeOptions: { key: TimeRange; label: string }[] = [
  { key: "6h", label: "最近 6 小时" },
  { key: "1d", label: "最近 1 天" },
  { key: "3d", label: "最近 3 天" },
  { key: "7d", label: "最近 7 天" },
  { key: "15d", label: "最近 15 天" },
];

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
  group_id: number | null;
  group_name: string | null;
  group_specification: string | null;
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
  range: TimeRange | string;
  days: number;
  hours: number;
  series: { platform: Platform; points: PricePoint[] }[];
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

export interface GroupComparison {
  group: ProductGroup;
  comparison_date: string | null;
  valid_count: number;
  average_actual_price: number | null;
  lowest_price: number | null;
  highest_price: number | null;
  cheapest_product_ids: number[];
  members: (Product & { comparison_status: "current" | "stale" | "missing" })[];
  range: TimeRange | string;
  days: number;
  hours: number;
  points: PricePoint[];
  series: {
    product_id: number; platform: Platform; item_id: string; shop_name: string; name: string; points: PricePoint[];
  }[];
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
  range: TimeRange | string;
  days: number;
  hours: number;
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

export function fetchGroups(signal?: AbortSignal) {
  return requestJson<{ groups: ProductGroup[] }>("/api/groups", { signal });
}

export function createGroup(input: { name: string; specification: string; notes: string }) {
  return requestJson<ProductGroup>("/api/groups", { method: "POST", body: JSON.stringify(input) });
}

export function updateGroup(id: number, input: { name: string; specification: string; notes: string }) {
  return requestJson<ProductGroup>(`/api/groups/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteGroup(id: number) {
  return requestJson<{ deleted: boolean }>(`/api/groups/${id}`, { method: "DELETE" });
}

export function addGroupMembers(id: number, productIds: number[]) {
  return requestJson<{ created: number; existing: number; group: ProductGroup }>(`/api/groups/${id}/members`, {
    method: "POST", body: JSON.stringify({ product_ids: productIds, confirmed_same_model: true }),
  });
}

export function removeGroupMember(id: number, productId: number) {
  return requestJson<{ deleted: boolean }>(`/api/groups/${id}/members/${productId}`, { method: "DELETE" });
}

export function enqueueGroup(id: number) {
  return requestJson<{ created: number; existing: number; jobs: Job[] }>(`/api/groups/${id}/jobs`, { method: "POST" });
}

export function fetchGroupComparison(id: number, range: TimeRange, signal?: AbortSignal) {
  return requestJson<GroupComparison>(`/api/groups/${id}/comparison?range=${encodeURIComponent(range)}`, { signal });
}

export function enqueueProducts(productIds: number[]) {
  return requestJson<{ jobs: Job[]; created: number; existing: number }>("/api/jobs", {
    method: "POST", body: JSON.stringify({ product_ids: productIds }),
  });
}

export function fetchHistory(productId: number, range: TimeRange, signal?: AbortSignal) {
  return requestJson<PriceHistory>(`/api/products/${productId}/history?range=${encodeURIComponent(range)}`, { signal });
}

export function fetchAverageHistory(range: TimeRange, platform?: Platform, productIds?: number[], signal?: AbortSignal) {
  const query = new URLSearchParams({ range });
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
