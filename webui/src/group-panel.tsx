import {
  ActionButton, ActionMenu, AlertDialog, Button, Cell, Checkbox, Column,
  DialogContainer, Flex, Form, Grid, Item, LabeledValue, Picker, ProgressCircle,
  Row, SearchField, TableBody, TableHeader, TableView, Text, TextField,
} from "@adobe/react-spectrum";
import { lazy, Suspense, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  addGroupMembers, createGroup, deleteGroup, enqueueGroup, fetchGroupComparison,
  platformLabel, productLabel, removeGroupMember, timeRangeOptions, updateGroup,
  type GroupComparison, type Product, type ProductGroup, type TimeRange,
} from "./api";
import { DashboardColumns } from "./dashboard-columns";
import type { RunMutation } from "./dashboard";
import type { PriceSeries } from "./price-chart";
import { normalizeSelection } from "./selection";

const PriceChart = lazy(() => import("./price-chart"));
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "2-digit", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
const price = (value: number | null) => value === null ? "—" : `¥${value.toFixed(2)}`;

export function GroupPanel({ groups, products, busy, dataVersion, runMutation, onViewProduct }: {
  groups: ProductGroup[];
  products: Product[];
  busy: boolean;
  dataVersion: string;
  runMutation: RunMutation;
  onViewProduct: (product: Product) => void;
}) {
  const [groupId, setGroupId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [specification, setSpecification] = useState("");
  const [notes, setNotes] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(new Set<string>());
  const [confirmed, setConfirmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [range, setRange] = useState<TimeRange>("7d");
  const [curveMode, setCurveMode] = useState("skus");
  const [result, setResult] = useState<{ key: string; data: GroupComparison } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const group = groups.find((candidate) => candidate.id === groupId);
  const pendingMembers = products.filter((product) => product.group_id === groupId &&
    (product.job_status === "queued" || product.job_status === "running"));
  const requestKey = `${groupId}:${range}:${dataVersion}`;
  const comparison = result?.key === requestKey ? result.data : null;
  const currentError = error?.key === requestKey ? error.message : null;

  useEffect(() => {
    if (groupId === null) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchGroupComparison(groupId, range, controller.signal).then((data) => {
      if (!controller.signal.aborted) setResult({ key: requestKey, data });
    }).catch((error) => {
      if (!controller.signal.aborted) setError({ key: requestKey, message: error instanceof Error ? error.message : "同款比价加载失败" });
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [groupId, range, requestKey]);

  const series = useMemo<PriceSeries[]>(() => {
    if (!comparison) return [];
    const average = { id: "average", label: "同款均价", points: comparison.points };
    return curveMode === "average" ? [average] : [average, ...comparison.series.map((sku) => ({
      id: `sku-${sku.product_id}`,
      label: `${platformLabel(sku.platform)} / ${sku.shop_name || "未知店铺"} / ${sku.item_id}`,
      points: sku.points,
    }))];
  }, [comparison, curveMode]);

  const reset = () => {
    setGroupId(null);
    setName("");
    setSpecification("");
    setNotes("");
    setSelected(new Set());
    setConfirmed(false);
    setSearch("");
    setResult(null);
    setError(null);
    setLoading(false);
  };

  const saveGroup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    await runMutation(async () => {
      const input = { name, specification, notes };
      const saved = groupId === null ? await createGroup(input) : await updateGroup(groupId, input);
      setGroupId(saved.id);
      setName(saved.name);
      setSpecification(saved.specification);
      setNotes(saved.notes);
    }, groupId === null ? "已创建同款商品组" : "已保存商品组");
  };

  const candidates = products.filter((product) => product.group_id === null &&
    [productLabel(product), product.item_id, product.shop_name, platformLabel(product.platform)]
      .some((value) => value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())),
  );
  const visibleSelected = normalizeSelection(selected, candidates.map((product) => product.id));
  const selectedIds = [...visibleSelected].map(Number);

  return (
    <>
      <DashboardColumns
        left={
          <Flex direction="column" gap="size-300">
            <Picker label="同款商品组" placeholder="选择已有商品组" width="100%" selectedKey={group ? String(group.id) : null}
              isDisabled={busy} items={groups} onSelectionChange={(key) => {
                const chosen = groups.find((candidate) => String(candidate.id) === String(key));
                if (!chosen) return;
                setGroupId(chosen.id);
                setName(chosen.name);
                setSpecification(chosen.specification);
                setNotes(chosen.notes);
                setSelected(new Set());
                setConfirmed(false);
                setSearch("");
              }}>
              {(candidate) => <Item key={String(candidate.id)} textValue={`${candidate.name} / ${candidate.specification}`}>
                {candidate.name} / {candidate.specification}
              </Item>}
            </Picker>
            <Form aria-label={groupId === null ? "新建同款商品组" : "编辑同款商品组"} width="100%" onSubmit={saveGroup}>
              <TextField label="同款名称" value={name} onChange={setName} maxLength={250} isRequired isDisabled={busy} />
              <TextField label="型号和规格" placeholder="例如 DDR5 16GB 5600MHz，同一型号" value={specification}
                onChange={setSpecification} maxLength={500} isRequired isReadOnly={!!group?.member_count} isDisabled={busy} />
              <TextField label="备注（可选）" value={notes} onChange={setNotes} maxLength={1000} isDisabled={busy} />
              <Flex gap="size-100" wrap>
                <Button variant="primary" style="fill" staticColor="black" type="submit" isPending={busy}>
                  {groupId === null ? "创建商品组" : "保存修改"}
                </Button>
                {groupId !== null ? <Button variant="secondary" onPress={reset} isDisabled={busy}>新建组</Button> : null}
                {group ? <ActionButton onPress={() => setDeleting(true)} isDisabled={busy}>删除组</ActionButton> : null}
              </Flex>
            </Form>
            {group ? (
              <>
                <Flex justifyContent="space-between" alignItems="center" gap="size-100" wrap>
                  <Text>已关联 {group.member_count} 个 SKU / 商品链接</Text>
                  <Button variant="primary" style="fill" staticColor="black" isDisabled={!group.member_count} isPending={busy}
                    onPress={() => { void runMutation(() => enqueueGroup(group.id), "组内 SKU 已加入采集队列"); }}>采集整组</Button>
                </Flex>
                {pendingMembers.length ? (
                  <Flex gap="size-100" alignItems="center">
                    {pendingMembers.some((product) => product.job_status === "running") ? <ProgressCircle aria-label="采集组内 SKU" isIndeterminate size="S" /> : null}
                    <div role="status"><Text>组内还有 {pendingMembers.length} 个 SKU 待完成采集</Text></div>
                  </Flex>
                ) : null}
                <SearchField aria-label="搜索待关联 SKU" placeholder="搜索未归组的名称、ID、店铺或平台" width="100%"
                  value={search} onChange={(value) => { setSearch(value); setSelected(new Set()); setConfirmed(false); }} />
                <TableView aria-label="待关联 SKU" selectionMode="multiple" selectedKeys={visibleSelected}
                  density="compact" overflowMode="wrap" height="size-3000" width="100%"
                  disabledKeys={busy ? candidates.map((product) => String(product.id)) : []}
                  onSelectionChange={(keys) => {
                    setSelected(normalizeSelection(keys, candidates.map((product) => product.id)));
                    setConfirmed(false);
                  }}>
                  <TableHeader><Column key="sku" isRowHeader>待关联 SKU</Column><Column key="price" width={90}>实际价</Column></TableHeader>
                  <TableBody>
                    {candidates.map((product) => (
                      <Row key={String(product.id)} textValue={productLabel(product)}>
                        <Cell><Flex direction="column" gap="size-50"><Text>{productLabel(product)}</Text><Text>{platformLabel(product.platform)} / {product.item_id}</Text></Flex></Cell>
                        <Cell>{price(product.actual_price)}</Cell>
                      </Row>
                    ))}
                  </TableBody>
                </TableView>
                <Checkbox isSelected={confirmed} onChange={setConfirmed} isDisabled={busy || !selectedIds.length}>
                  确认所选链接与商品组型号、规格一致
                </Checkbox>
                <Text>淘宝多规格页面请先确认展示价对应的规格，当前不会自动切换 SKU。</Text>
                <Button variant="primary" style="fill" staticColor="black" isDisabled={!selectedIds.length || !confirmed} isPending={busy}
                  onPress={() => {
                    void runMutation(async () => {
                      await addGroupMembers(group.id, selectedIds);
                      setSelected(new Set());
                      setConfirmed(false);
                    }, "已关联选中 SKU，历史价格已纳入同款曲线");
                  }}>关联选中 {selectedIds.length} 个 SKU</Button>
              </>
            ) : <Text>先创建或选择同款商品组，再关联淘宝、京东的商品记录。</Text>}
          </Flex>
        }
        right={
          <Flex direction="column" gap="size-300">
            {groupId !== null ? (
              <>
                <Flex gap="size-200" wrap>
                  <Picker label="时间范围" selectedKey={range} width="size-1600" onSelectionChange={(key) => setRange(String(key) as TimeRange)}>
                    {timeRangeOptions.map((option) => <Item key={option.key}>{option.label}</Item>)}
                  </Picker>
                  <Picker label="价格曲线" selectedKey={curveMode} width="size-2000" onSelectionChange={(key) => setCurveMode(String(key))}>
                    <Item key="skus">SKU 报价与同款均价</Item><Item key="average">仅同款均价</Item>
                  </Picker>
                </Flex>
                {loading || (!comparison && !currentError) ? <ProgressCircle aria-label="加载同款比价" isIndeterminate size="S" /> : null}
                {currentError ? <div role="alert"><Text>{currentError}</Text></div> : null}
                {comparison ? (
                  <>
                    <Text>{comparison.group.name} / {comparison.group.specification}</Text>
                    <Grid columns={{ base: ["1fr", "1fr"], L: ["1fr", "1fr", "1fr"] }} gap="size-200">
                      <LabeledValue label="同日最低价" value={price(comparison.lowest_price)} />
                      <LabeledValue label="同日均价" value={price(comparison.average_actual_price)} />
                      <LabeledValue label="可比日期 / 样本" value={comparison.comparison_date ? `${comparison.comparison_date} / ${comparison.valid_count} 个` : "—"} />
                    </Grid>
                    <TableView aria-label="同款 SKU 报价比较" density="compact" overflowMode="wrap" height="size-3000" width="100%">
                      <TableHeader>
                        <Column key="sku" isRowHeader>SKU / 店铺</Column>
                        <Column key="price" width={105}>最新报价</Column>
                        <Column key="date" width={130}>记录时间</Column>
                        <Column key="actions" width={70}>操作</Column>
                      </TableHeader>
                      <TableBody>
                        {comparison.members.map((member) => (
                          <Row key={String(member.id)} textValue={`${platformLabel(member.platform)} ${member.item_id}`}>
                            <Cell><Flex direction="column" gap="size-50"><Text>{platformLabel(member.platform)} / {member.shop_name || "未识别店铺"}</Text><Text>{member.item_id}</Text></Flex></Cell>
                            <Cell>{price(member.actual_price)}{comparison.cheapest_product_ids.includes(member.id) ? " · 最低" : ""}</Cell>
                            <Cell><Flex direction="column" gap="size-50">
                              <Text>{member.observed_at ? dateFormatter.format(new Date(member.observed_at)) : "未采集"}</Text>
                              {member.comparison_status === "stale" ? <Text>日期不同，不参与当前比价</Text> : null}
                            </Flex></Cell>
                            <Cell>
                              <ActionMenu aria-label={`${member.item_id}的操作`} isDisabled={busy} onAction={(key) => {
                                if (key === "history") onViewProduct(member);
                                if (key === "remove") void runMutation(() => removeGroupMember(comparison.group.id, member.id), "已移出商品组，商品和历史数据保留");
                              }}>
                                <Item key="history">单品历史</Item>
                                <Item key="source" href={member.platform === "jd" ? `https://item.jd.com/${member.item_id}.html` : `https://item.taobao.com/item.htm?id=${member.item_id}`} target="_blank" rel="noreferrer">原页面</Item>
                                <Item key="remove">移出此组</Item>
                              </ActionMenu>
                            </Cell>
                          </Row>
                        ))}
                      </TableBody>
                    </TableView>
                    {comparison.points.some((point) => point.actual_price !== null) ? (
                      <Suspense fallback={<ProgressCircle aria-label="加载图表" isIndeterminate size="S" />}>
                        <PriceChart series={series} label="同款 SKU 报价与均价" height={360} />
                      </Suspense>
                    ) : <Text>此日期范围暂无价格记录，关联 SKU 后可采集整组。</Text>}
                  </>
                ) : null}
              </>
            ) : null}
          </Flex>
        }
      />
      <DialogContainer onDismiss={() => setDeleting(false)}>
        {deleting && group ? (
          <AlertDialog title="删除同款商品组？" variant="destructive" primaryActionLabel="删除组" cancelLabel="取消"
            onPrimaryAction={() => {
              setDeleting(false);
              void runMutation(async () => { await deleteGroup(group.id); reset(); }, "已删除商品组，关联的商品和价格历史保留");
            }}>
            删除「{group.name}」只移除分组及关联，不删除商品、采集任务或价格历史。
          </AlertDialog>
        ) : null}
      </DialogContainer>
    </>
  );
}
