import { Flex, Item, Picker, ProgressCircle, Text } from "@adobe/react-spectrum";
import { lazy, Suspense, useEffect, useState } from "react";
import { fetchAverageHistory, platformLabel, type AverageHistory, type Platform } from "./api";

const PriceChart = lazy(() => import("./price-chart"));

export function AveragePanel({ platform, productIds, dataVersion }: {
  platform?: Platform;
  productIds?: number[];
  dataVersion: string;
}) {
  const [days, setDays] = useState(30);
  const [result, setResult] = useState<{ key: string; history: AverageHistory } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  // Primitive dependencies prevent polling renders from restarting an unchanged request.
  const idsKey = productIds ? [...productIds].sort((a, b) => a - b).join(",") : "all";
  const requestKey = `${platform ?? "overview"}:${days}:${idsKey}:${dataVersion}`;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const ids = idsKey === "all" ? undefined : idsKey.split(",").map(Number);
    fetchAverageHistory(days, platform, ids, controller.signal).then((history) => {
      if (!controller.signal.aborted) setResult({ key: requestKey, history });
    }).catch((error) => {
      if (!controller.signal.aborted) setError({ key: requestKey, message: error instanceof Error ? error.message : "均价加载失败" });
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [days, platform, idsKey, requestKey]);

  const history = result?.key === requestKey ? result.history : null;
  const currentError = error?.key === requestKey ? error.message : null;

  return (
    <Flex direction="column" gap="size-200">
      <Picker label="日期范围" width="size-1600" selectedKey={String(days)} onSelectionChange={(key) => setDays(Number(key))}>
        <Item key="7">最近 7 天</Item>
        <Item key="30">最近 30 天</Item>
        <Item key="90">最近 90 天</Item>
        <Item key="365">最近 365 天</Item>
      </Picker>
      {currentError ? <div role="alert"><Text>{currentError}</Text></div> : null}
      {loading || (!history && !currentError) ? <ProgressCircle aria-label="加载平均价格" isIndeterminate size="S" /> : null}
      {history?.series.map((series) => (
        <Flex key={series.platform} direction="column" gap="size-100">
          <Text>{platformLabel(series.platform)}平均价格</Text>
          {series.points.some((point) => point.actual_price !== null) ? (
            <Suspense fallback={<ProgressCircle aria-label="加载图表" isIndeterminate size="S" />}>
              <PriceChart points={series.points} label={`${platformLabel(series.platform)}均价`} height={platform ? 360 : 260} />
            </Suspense>
          ) : <Text>这段时间暂无价格记录</Text>}
        </Flex>
      ))}
    </Flex>
  );
}
