import {
  ActionButton, ActionMenu, AlertDialog, Button, Cell, Column, Content,
  DialogContainer, Flex, Form, Heading, InlineAlert, Item, Picker,
  ProgressCircle, SearchField, Row, TableBody, TableHeader, TableView,
  TabList, TabPanels, Tabs, Text, TextArea, TextField, ToastQueue,
  type Key, type Selection,
} from "@adobe/react-spectrum";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ApiError, createProducts, deleteObservation, deleteProduct, enqueueProducts,
  fetchJobs, fetchProducts, platformLabel, productLabel, updateProduct,
  type Job, type JobStatus, type Platform, type Product,
} from "./api";
import { AveragePanel } from "./average-panel";
import { DashboardColumns } from "./dashboard-columns";
import { HistoryPanel } from "./history-panel";
import { OverviewStats } from "./overview-stats";
import { AVERAGE_KEY, chartKeyForSelection, normalizeSelection } from "./selection";

export const jobLabels: Record<JobStatus, string> = {
  queued: "排队中", running: "采集中", succeeded: "已完成", failed: "失败",
};

export function formatPrice(price: number | null) {
  return price === null ? "—" : `¥${price.toFixed(2)}`;
}

export type RunMutation = (operation: () => Promise<unknown>, message: string) => Promise<boolean>;
type DeleteTarget = { kind: "product" | "observation"; id: number; label: string };
type DashboardTab = "overview" | Platform;

export function Dashboard() {
  const refreshId = useRef(0);
  const mutationLock = useRef(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [mutationError, setMutationError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [token, setToken] = useState("");
  const [tab, setTab] = useState<DashboardTab>("overview");
  const [search, setSearch] = useState("");
  // Static JSX collection keys are strings; use strings in both controlled widgets.
  const [selected, setSelected] = useState(new Set<string>());
  const [chartKey, setChartKey] = useState(AVERAGE_KEY);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [itemIds, setItemIds] = useState("");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++refreshId.current;
    const [productResult, jobResult] = await Promise.all([fetchProducts(signal), fetchJobs(signal)]);
    if (signal?.aborted || requestId !== refreshId.current) return;
    setProducts(productResult.products);
    setJobs(jobResult.jobs);
    setLoadError(null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refresh(controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error : new Error("加载失败"));
      } finally {
        if (!controller.signal.aborted) {
          setInitialLoading(false);
          timer = setTimeout(poll, 3000);
        }
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh]);

  const runMutation: RunMutation = async (operation, message) => {
    if (mutationLock.current) return false;
    mutationLock.current = true;
    setBusy(true);
    setMutationError("");
    try {
      await operation();
      setRevision((value) => value + 1);
      ToastQueue.neutral(message, { timeout: 5000 });
      try { await refresh(); } catch (error) {
        setLoadError(error instanceof Error ? error : new Error("刷新失败"));
      }
      return true;
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "操作失败");
      return false;
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  };

  const resetForm = () => {
    setEditingId(null);
    setItemIds("");
    setName("");
    setNotes("");
  };

  const changeTab = (key: Key) => {
    if (key !== "overview" && key !== "jd" && key !== "taobao") return;
    setTab(key);
    setSelected(new Set());
    setChartKey(AVERAGE_KEY);
    setSearch("");
    setMutationError("");
    resetForm();
  };

  const focusProduct = (key: string) => {
    setSelected(new Set([key]));
    setChartKey(key);
  };

  const platformProducts = products.filter((product) => product.platform === tab);
  const needle = search.trim().toLocaleLowerCase();
  const filtered = platformProducts.filter((product) =>
    [product.item_id, productLabel(product), product.shop_name, product.notes]
      .some((value) => value.toLocaleLowerCase().includes(needle)),
  );
  const visibleSelected = normalizeSelection(selected, filtered.map((product) => product.id));
  const selectedIds = [...visibleSelected].map(Number);
  const historyProduct = platformProducts.find((product) => String(product.id) === chartKey);
  const selectedChartKey = historyProduct ? String(historyProduct.id) : AVERAGE_KEY;
  const chartOptions = [
    { id: AVERAGE_KEY, label: selectedIds.length ? `平均价格（已选 ${selectedIds.length} 个）` : "平均价格（全部商品）" },
    ...platformProducts.map((product) => ({ id: String(product.id), label: productLabel(product) })),
  ];
  const activeJobs = jobs.filter((job) => job.platform === tab && (job.status === "queued" || job.status === "running"));
  const recentFailures = platformProducts.filter((product) => product.job_status === "failed").slice(0, 5);
  const dataVersion = `${revision}:${products.map((product) => `${product.id}:${product.updated_at}:${product.observed_at}:${product.actual_price}`).join("|")}`;

  const changeSelection = (keys: Selection) => {
    const next = normalizeSelection(keys, filtered.map((product) => product.id));
    setSelected(next);
    setChartKey(chartKeyForSelection(next));
  };

  const saveProduct = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || tab === "overview") return;
    if (editingId !== null) {
      if (await runMutation(() => updateProduct(editingId, { name, notes }), "已保存修改")) resetForm();
      return;
    }
    const ids = [...new Set(itemIds.trim().split(/[\s,，;；]+/).filter(Boolean))];
    if (!ids.length || ids.length > 100 || ids.some((id) => !/^\d{1,32}$/.test(id))) {
      setMutationError("请输入 1 到 100 个数字商品 ID，使用换行或逗号分隔");
      return;
    }
    await runMutation(async () => {
      const result = await createProducts({ platform: tab, item_ids: ids, name, notes });
      const keys = normalizeSelection("all", result.products.map((product) => product.id));
      setSelected(keys);
      setChartKey(chartKeyForSelection(keys));
      setSearch("");
      setProducts((current) => [
        ...result.products, ...current.filter((product) => !keys.has(String(product.id))),
      ].sort((a, b) => b.id - a.id));
      resetForm();
    }, "已保存商品，重复 ID 已去重");
  };

  const enqueue = (ids: number[]) => runMutation(async () => {
    for (let index = 0; index < ids.length; index += 100) {
      await enqueueProducts(ids.slice(index, index + 100));
    }
  }, "已加入采集队列，已有待执行任务不会重复入队");

  const editProduct = (product: Product) => {
    focusProduct(String(product.id));
    setEditingId(product.id);
    setItemIds(product.item_id);
    setName(product.name);
    setNotes(product.notes);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const confirmDelete = async (target: DeleteTarget) => {
    setDeleteTarget(null);
    await runMutation(async () => {
      if (target.kind === "observation") {
        await deleteObservation(target.id);
        return;
      }
      await deleteProduct(target.id);
      const next = new Set([...selected].filter((key) => key !== String(target.id)));
      setSelected(next);
      if (chartKey === String(target.id)) setChartKey(chartKeyForSelection(next));
      setProducts((current) => current.filter((product) => product.id !== target.id));
      if (editingId === target.id) resetForm();
    }, target.kind === "product" ? "已删除商品及其任务和历史" : "已删除价格记录");
  };

  const needsToken = loadError instanceof ApiError && loadError.status === 401;
  if (needsToken) {
    return (
      <Form aria-label="API 鉴权" width="100%" maxWidth="28rem" onSubmit={(event) => {
        event.preventDefault();
        sessionStorage.setItem("viewview.access-token", token.trim());
        void refresh().catch((error) => setLoadError(error));
      }}>
        <TextField label="API 密钥" type="password" value={token} onChange={setToken} isRequired />
        <Button variant="primary" style="fill" staticColor="black" type="submit">连接</Button>
        <Text>{loadError.message}</Text>
      </Form>
    );
  }

  const platformSidebar = tab === "overview" ? null : (
    <Flex direction="column" gap="size-300" width="100%">
      <Form aria-label={editingId === null ? `新增${platformLabel(tab)}商品` : "编辑商品"} width="100%" onSubmit={saveProduct}>
        <TextArea label={editingId === null ? "商品 ID（可换行批量输入）" : "商品 ID"}
          value={itemIds} onChange={setItemIds} isReadOnly={editingId !== null} isDisabled={busy}
          placeholder={tab === "jd" ? "100342771276" : "1039489952733"} isRequired />
        <TextField label="名称（可选）" value={name} onChange={setName} maxLength={250} isDisabled={busy} />
        <TextField label="备注（可选）" value={notes} onChange={setNotes} maxLength={1000} isDisabled={busy} />
        <Flex gap="size-100">
          <Button variant="primary" style="fill" staticColor="black" type="submit" isPending={busy}>
            {editingId === null ? "新增" : "保存修改"}
          </Button>
          {editingId !== null ? <Button variant="secondary" onPress={resetForm} isDisabled={busy}>取消</Button> : null}
        </Flex>
      </Form>

      <SearchField aria-label="搜索商品" placeholder="搜索名称、ID、店铺或备注" value={search} width="100%" onChange={(value) => {
        setSearch(value);
        setSelected(new Set());
        setChartKey(AVERAGE_KEY);
      }} />
      <TableView aria-label={`${platformLabel(tab)}商品列表`} selectionMode="multiple" density="compact" overflowMode="wrap"
        height="size-3600" width="100%" selectedKeys={visibleSelected} onSelectionChange={changeSelection}
        disabledKeys={busy ? filtered.map((product) => String(product.id)) : []}
        onAction={(key) => focusProduct(String(key))}>
        <TableHeader>
          <Column key="product" isRowHeader>商品</Column>
          <Column key="price" width={90}>实际价</Column>
          <Column key="actions" width={70}>操作</Column>
        </TableHeader>
        <TableBody loadingState={initialLoading ? "loading" : "idle"}>
          {filtered.map((product) => (
            <Row key={String(product.id)} textValue={productLabel(product)}>
              <Cell>
                <Flex direction="column" gap="size-50">
                  <Text>{productLabel(product)}</Text>
                  <Text>{product.job_status ? jobLabels[product.job_status] : "未采集"}</Text>
                </Flex>
              </Cell>
              <Cell>{formatPrice(product.actual_price)}</Cell>
              <Cell>
                <ActionMenu aria-label={`${productLabel(product)}的操作`} isDisabled={busy} onAction={(key) => {
                  if (key === "history") focusProduct(String(product.id));
                  if (key === "edit") editProduct(product);
                  if (key === "enqueue") void enqueue([product.id]);
                  if (key === "delete") setDeleteTarget({ kind: "product", id: product.id, label: productLabel(product) });
                }}>
                  <Item key="history">价格历史</Item>
                  <Item key="edit">编辑</Item>
                  <Item key="enqueue">采集 / 重试</Item>
                  <Item key="delete">删除</Item>
                </ActionMenu>
              </Cell>
            </Row>
          ))}
        </TableBody>
      </TableView>

      <Flex alignItems="center" justifyContent="space-between" gap="size-100" wrap>
        <Text>{platformProducts.length} 个商品 · 已选 {selectedIds.length} 个</Text>
        <Button variant="primary" style="fill" staticColor="black" isDisabled={!selectedIds.length} isPending={busy}
          onPress={() => { void enqueue(selectedIds); }}>选中入队</Button>
      </Flex>
      {activeJobs.length ? (
        <Flex gap="size-100" alignItems="center">
          {activeJobs.some((job) => job.status === "running") ? <ProgressCircle aria-label="采集中" isIndeterminate size="S" /> : null}
          <div role="status"><Text>{activeJobs.some((job) => job.status === "running") ? "正在采集" : "等待采集"} · 队列剩余 {activeJobs.length} 个</Text></div>
        </Flex>
      ) : null}
      {recentFailures.length ? (
        <Flex direction="column" gap="size-100">
          {recentFailures.map((product) => (
            <Flex key={product.id} gap="size-100" alignItems="center">
              <Text flex>{productLabel(product)}：{product.job_error || "采集失败"}</Text>
              <ActionButton isDisabled={busy} onPress={() => { void enqueue([product.id]); }}>重试</ActionButton>
            </Flex>
          ))}
        </Flex>
      ) : null}

    </Flex>
  );

  const platformPanel = tab === "overview" ? null : (
    <DashboardColumns
      left={platformSidebar}
      right={
        <Flex direction="column" gap="size-300" width="100%">
          <Picker label="价格曲线" width="100%" selectedKey={selectedChartKey} items={chartOptions} isDisabled={busy} onSelectionChange={(key) => {
            if (key === AVERAGE_KEY) setChartKey(AVERAGE_KEY);
            else if (key !== null) focusProduct(String(key));
          }}>
            {(option) => <Item key={option.id} textValue={option.label}>{option.label}</Item>}
          </Picker>
          {historyProduct ? (
            <HistoryPanel key={historyProduct.id} product={historyProduct} busy={busy} revision={revision} runMutation={runMutation}
              onDelete={(observation) => setDeleteTarget({ kind: "observation", id: observation.id, label: `${formatPrice(observation.actual_price)} 的价格记录` })} />
          ) : (
            <AveragePanel platform={tab} productIds={selectedIds.length ? selectedIds : undefined} dataVersion={dataVersion} />
          )}
        </Flex>
      }
    />
  );

  return (
    <Flex direction="column" gap="size-300" width="100%">
      {loadError || mutationError ? (
        <InlineAlert variant="negative"><Heading>操作失败</Heading><Content>{mutationError || loadError?.message}</Content></InlineAlert>
      ) : null}
      <Tabs aria-label="平台" selectedKey={tab} onSelectionChange={changeTab} isDisabled={busy} width="100%">
        <TabList>
          <Item key="overview">总览</Item>
          <Item key="taobao">淘宝</Item>
          <Item key="jd">京东</Item>
        </TabList>
        <TabPanels marginTop="size-200">
          <Item key="overview">
            <DashboardColumns
              left={initialLoading ? <ProgressCircle aria-label="加载统计" isIndeterminate size="S" /> : <OverviewStats products={products} jobs={jobs} />}
              right={<AveragePanel dataVersion={dataVersion} />}
            />
          </Item>
          <Item key="taobao">{tab === "taobao" ? platformPanel : null}</Item>
          <Item key="jd">{tab === "jd" ? platformPanel : null}</Item>
        </TabPanels>
      </Tabs>
      <DialogContainer onDismiss={() => setDeleteTarget(null)}>
        {deleteTarget ? (
          <AlertDialog title={deleteTarget.kind === "product" ? "删除商品？" : "删除价格记录？"}
            variant="destructive" primaryActionLabel="删除" cancelLabel="取消"
            onPrimaryAction={() => { void confirmDelete(deleteTarget); }}>
            {deleteTarget.label}。{deleteTarget.kind === "product" ? "对应采集任务和全部价格历史也会删除。" : "曲线会根据剩余记录重新计算。"}此操作不可撤销。
          </AlertDialog>
        ) : null}
      </DialogContainer>
    </Flex>
  );
}
