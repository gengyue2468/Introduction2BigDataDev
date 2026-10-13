import { Divider, Flex, Grid, Heading, LabeledValue } from "@adobe/react-spectrum";
import { platformLabel, type Job, type Platform, type Product, type ProductGroup } from "./api";

const platforms: Platform[] = ["taobao", "jd"];

export function OverviewStats({ products, jobs, groups }: { products: Product[]; jobs: Job[]; groups: ProductGroup[] }) {
  return (
    <Flex direction="column" gap="size-300">
      <Heading level={2} margin="size-0">统计概览</Heading>
      <Grid columns={["1fr", "1fr"]} gap="size-300">
        <LabeledValue label="SKU / 商品链接总数" value={products.length} />
        <LabeledValue label="有价格的商品" value={products.filter((product) => product.actual_price !== null).length} />
        <LabeledValue label="排队中" value={jobs.filter((job) => job.status === "queued").length} />
        <LabeledValue label="正在采集" value={jobs.filter((job) => job.status === "running").length} />
        <LabeledValue label="采集失败的商品" value={products.filter((product) => product.job_status === "failed").length} />
        <LabeledValue label="未采集的商品" value={products.filter((product) => product.job_status === null && product.actual_price === null).length} />
        <LabeledValue label="同款商品组" value={groups.length} />
        <LabeledValue label="未归组 SKU / 链接" value={products.filter((product) => product.group_id === null).length} />
      </Grid>
      {platforms.map((platform) => {
        const items = products.filter((product) => product.platform === platform);
        const prices = items.flatMap((product) => product.actual_price === null ? [] : [product.actual_price]);
        const average = prices.length ? prices.reduce((sum, price) => sum + price, 0) / prices.length : null;
        return (
          <Flex key={platform} direction="column" gap="size-200">
            <Divider size="S" />
            <Heading level={3} margin="size-0">{platformLabel(platform)}</Heading>
            <Grid columns={["1fr", "1fr"]} gap="size-200">
              <LabeledValue label="商品数量" value={items.length} />
              <LabeledValue label="有价格的商品" value={prices.length} />
              <LabeledValue label="最新价格均值" value={average === null ? "—" : `¥${average.toFixed(2)}`} />
            </Grid>
          </Flex>
        );
      })}
    </Flex>
  );
}
