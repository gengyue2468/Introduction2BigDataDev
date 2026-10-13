import { useEffect, useRef } from "react";
import { init, use, type EChartsType } from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import type { PricePoint } from "./api";

use([LineChart, GridComponent, LegendComponent, TooltipComponent, SVGRenderer]);

export interface PriceSeries {
  id: string;
  label: string;
  points: PricePoint[];
}

export default function PriceChart({ points, series, label = "实际价", height = 260 }: {
  points?: PricePoint[]; series?: PriceSeries[]; label?: string; height?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const instance = init(container.current, undefined, { renderer: "svg" });
    chart.current = instance;
    const resizeObserver = new ResizeObserver(() => instance.resize());
    resizeObserver.observe(container.current);
    return () => {
      resizeObserver.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const lines = series ?? [{ id: "price", label, points: points ?? [] }];
    const dates = [...new Set(lines.flatMap((line) => line.points.map((point) => point.date)))].sort();
    const multiple = lines.length > 1;
    chart.current?.setOption({
      animation: false,
      textStyle: { fontFamily: "sans-serif", color: "#555" },
      grid: { left: 12, right: 16, top: multiple ? 56 : 16, bottom: 12, containLabel: true },
      legend: { show: multiple, type: "scroll", top: 0, textStyle: { fontFamily: "sans-serif" } },
      tooltip: { trigger: "axis", renderMode: "richText", valueFormatter: (value: unknown) => typeof value === "number" ? `¥${value.toFixed(2)}` : "—" },
      xAxis: {
        type: "category", boundaryGap: false, data: dates,
        axisLine: { lineStyle: { color: "#ccc" } }, axisTick: { show: false },
        axisLabel: { formatter: (date: string) => date.slice(5) },
      },
      yAxis: {
        type: "value", scale: true,
        axisLabel: { formatter: (value: number) => `¥${value}` },
        splitLine: { lineStyle: { color: "#eee" } },
      },
      series: lines.map((line, index) => {
        const values = new Map(line.points.map((point) => [point.date, point.actual_price]));
        return {
          id: line.id, name: line.label, type: "line", connectNulls: false, symbolSize: 5,
          symbol: ["circle", "rect", "triangle", "diamond"][index % 4],
          itemStyle: { color: ["#222", "#666", "#888"][index % 3] },
          lineStyle: { width: line.id === "average" ? 3 : 2, type: ["solid", "dashed", "dotted"][index % 3] },
          data: dates.map((date) => values.get(date) ?? null),
        };
      }),
    }, { notMerge: true });
  }, [points, series, label]);

  return <div ref={container} role="img" aria-label={`${label}，按北京时间绘制的价格曲线`} style={{ width: "100%", height }} />;
}
