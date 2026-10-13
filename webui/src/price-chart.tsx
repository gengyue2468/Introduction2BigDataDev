import { useEffect, useRef } from "react";
import { init, use, type EChartsType } from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import type { PricePoint } from "./api";

use([LineChart, GridComponent, TooltipComponent, SVGRenderer]);

export default function PriceChart({ points, label = "实际价", height = 260 }: { points: PricePoint[]; label?: string; height?: number }) {
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
    chart.current?.setOption({
      animation: false,
      textStyle: { fontFamily: "sans-serif", color: "#555" },
      grid: { left: 12, right: 16, top: 16, bottom: 12, containLabel: true },
      tooltip: { trigger: "axis", renderMode: "richText", valueFormatter: (value: unknown) => typeof value === "number" ? `¥${value.toFixed(2)}` : "—" },
      xAxis: {
        type: "category", boundaryGap: false, data: points.map((point) => point.date),
        axisLine: { lineStyle: { color: "#ccc" } }, axisTick: { show: false },
        axisLabel: { formatter: (date: string) => date.slice(5) },
      },
      yAxis: {
        type: "value", scale: true,
        axisLabel: { formatter: (value: number) => `¥${value}` },
        splitLine: { lineStyle: { color: "#eee" } },
      },
      series: [{
        name: label, type: "line", connectNulls: false, symbolSize: 6,
        itemStyle: { color: "#222" }, lineStyle: { width: 2 },
        data: points.map((point) => point.actual_price),
      }],
    }, { notMerge: true });
  }, [points, label]);

  return <div ref={container} role="img" aria-label={`${label}，按北京时间每日有效价格绘制的曲线`} style={{ width: "100%", height }} />;
}
