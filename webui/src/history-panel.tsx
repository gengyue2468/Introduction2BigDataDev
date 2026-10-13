import {
  ActionButton, Button, Cell, Column, Flex, Form, Item, NumberField, Picker,
  ProgressCircle, Row, TableBody, TableHeader, TableView, Text, TextField,
} from "@adobe/react-spectrum";
import { lazy, Suspense, useEffect, useState, type FormEvent } from "react";
import { addObservation, fetchHistory, type Observation, type PriceHistory, type Product } from "./api";
import type { RunMutation } from "./dashboard";

const PriceChart = lazy(() => import("./price-chart"));
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});

function todayInBeijing() {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}

export function HistoryPanel({ product, busy, revision, runMutation, onDelete }: {
  product: Product;
  busy: boolean;
  revision: number;
  runMutation: RunMutation;
  onDelete: (observation: Observation) => void;
}) {
  const [days, setDays] = useState(30);
  const [history, setHistory] = useState<PriceHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [date, setDate] = useState(todayInBeijing);
  const [actualPrice, setActualPrice] = useState(NaN);
  const [dailyPrice, setDailyPrice] = useState(NaN);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetchHistory(product.id, days, controller.signal).then((result) => {
      if (!controller.signal.aborted) setHistory(result);
    }).catch((error) => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "历史加载失败");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [product.id, product.observed_at, product.actual_price, days, revision]);

  // Never display the previously selected product's chart during a new request.
  const currentHistory = history?.product_id === product.id && history.days === days ? history : null;

  const saveObservation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (!Number.isFinite(actualPrice) || actualPrice < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError("请输入有效日期和实际价");
      return;
    }
    const saved = await runMutation(() => addObservation(product.id, {
      actual_price: actualPrice,
      daily_price: Number.isNaN(dailyPrice) ? null : dailyPrice,
      observed_at: `${date}T12:00:00+08:00`,
    }), "已新增手动价格记录");
    if (saved) { setShowForm(false); setActualPrice(NaN); setDailyPrice(NaN); }
  };

  return (
    <Flex direction="column" gap="size-200">
      <Flex gap="size-100" alignItems="end" justifyContent="space-between" wrap>
        <Picker label="日期范围" selectedKey={String(days)} onSelectionChange={(key) => setDays(Number(key))} width="size-1600">
          <Item key="7">最近 7 天</Item>
          <Item key="30">最近 30 天</Item>
          <Item key="90">最近 90 天</Item>
          <Item key="365">最近 365 天</Item>
        </Picker>
        <ActionButton onPress={() => setShowForm((value) => !value)} isDisabled={busy}>
          {showForm ? "取消新增" : "新增价格记录"}
        </ActionButton>
      </Flex>
      {product.notes ? <Text>{product.notes}</Text> : null}
      {showForm ? (
        <Form aria-label="新增手动价格记录" onSubmit={saveObservation} width="100%">
          <TextField label="日期（北京时间，每日 12:00）" type="date" value={date} onChange={setDate} isRequired isDisabled={busy} />
          <NumberField label="实际价" value={actualPrice} onChange={setActualPrice} minValue={0} maxValue={1_000_000_000}
            formatOptions={{ maximumFractionDigits: 2 }} isRequired isDisabled={busy} />
          <NumberField label="日常价（可选）" value={dailyPrice} onChange={setDailyPrice} minValue={0} maxValue={1_000_000_000}
            formatOptions={{ maximumFractionDigits: 2 }} isDisabled={busy} />
          <Button variant="primary" style="fill" staticColor="black" type="submit" isPending={busy}>新增记录</Button>
        </Form>
      ) : null}
      {error ? <div role="alert"><Text>{error}</Text></div> : null}
      {loading ? <ProgressCircle aria-label="加载价格历史" isIndeterminate size="S" /> : null}
      {currentHistory && !error ? (
        <>
          {currentHistory.total_observations ? (
            <Suspense fallback={<ProgressCircle aria-label="加载图表" isIndeterminate size="S" />}>
              <PriceChart points={currentHistory.points} height={360} />
            </Suspense>
          ) : <Text>这段时间暂无价格记录</Text>}
          {currentHistory.observations.length ? (
            <TableView aria-label="价格记录" density="compact" height="size-2400" width="100%">
              <TableHeader>
                <Column key="date" isRowHeader>时间</Column>
                <Column key="price" width={90}>实际价</Column>
                <Column key="source" width={65}>来源</Column>
                <Column key="delete" width={65}>操作</Column>
              </TableHeader>
              <TableBody>
                {currentHistory.observations.map((observation) => (
                  <Row key={observation.id}>
                    <Cell>{dateFormatter.format(new Date(observation.observed_at))}</Cell>
                    <Cell>¥{observation.actual_price.toFixed(2)}</Cell>
                    <Cell>{observation.source === "manual" ? "手动" : "抓取"}</Cell>
                    <Cell><ActionButton isQuiet isDisabled={busy} onPress={() => onDelete(observation)}>删除</ActionButton></Cell>
                  </Row>
                ))}
              </TableBody>
            </TableView>
          ) : null}
          {currentHistory.total_observations > 100 ? <Text>显示最近 100 条记录，曲线使用范围内全部记录。</Text> : null}
        </>
      ) : null}
    </Flex>
  );
}
