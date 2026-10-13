# viewview

用 `Bun.Webview` 方法实现的抓取页面的妙妙小玩具，绿皮科技，似乎不太稳定

程序会首先用 `cheerio` 和 `sanitize-html` 解析并清洗 HTML，然后尝试用 `@mizchi/readability` 将正文转换成人类可读的 Markdown 格式，如果失败了会用 `turndown` 再尝试一次转换，最后组成一个包含 frontmatter 元数据的 Markdown 文档返回。

此外，程序套壳了一个 `Hono` HTTP 服务端，通过 `.env` 配置鉴权和允许的 HTTP 方法，默认只允许 POST 请求。

可选的类似 Jina Reader 的 GET 请求接口：

```
GET http://localhost:9233/https://www.google.com
```

和通用的 POST 请求接口（可配置鉴权）：

```
curl -X POST http://localhost:9233/read \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my-magic-auth-token" \
  -d '{"url":"https://www.gengyue.site"}'
```

---

## 一些例子

```text
GET http://localhost:9233/jd/items/100342771276
GET http://localhost:9233/jd/average?sku_id=100342771276&sku_id=100000000000
GET http://localhost:9233/taobao/items/1039489952733
GET http://localhost:9233/taobao/average?item_id=1039489952733&item_id=100000000000
```

商品接口返回 `sku_id` / `item_id`、`item_name`、`shop_name`、`daily_price`、`actual_price` 等字段。批量均价接口会对有效的 `actual_price` 计算平均值，并保留每个商品的结果和错误信息。批量任务默认串行执行，也可以通过 `JD_BATCH_CONCURRENCY` 或 `TAOBAO_BATCH_CONCURRENCY` 调整并发数，但不应超过 `MAX_CONCURRENT_READS`。

## Dashboard

`webui/` 使用 React Router v8、React Spectrum 和 Apache ECharts。仅保留首页，标题为 `dashboard`，无 header、无卡片。桌面使用左右两栏布局，小屏自动改为单列，支持：

- 商品新增（支持换行、逗号分隔批量 ID）、搜索、编辑名称/备注、确认删除。
- 多选入队、采集进度、失败重试。新增商品不会自动采集，选择商品后点击「选中入队」。
- 总览 / 淘宝 / 京东 / 同款比价四个 tab。总览左侧显示商品、队列和分平台统计，右侧分别展示淘宝、京东均价曲线；平台 tab 左侧是表单和商品列表，右侧支持单品或已选商品均价曲线。
- 同款商品组按型号和规格手动归组，可关联跨平台的多个商品记录、整组入队、移出关联、编辑和删除组。右侧显示各店铺报价、最低价、同款均价和多条 SKU 价格曲线。
- 新增、编辑、删除和入队成功使用 Spectrum 中性 toast 提示，不再占用页面正文。
- 6 小时 / 1 天 / 3 天 / 7 天 / 15 天实际价曲线；6 小时按北京时间逐小时取最后一次有效价格，其余范围按天取最后一次有效价格，缺失时间段留空。
- 手动新增、删除价格记录，方便补录历史数据。手动记录时间为所选日期的北京时间 12:00，与抓取记录分开标记。

安装和启动（在 `viewview/` 下）：

```powershell
bun install
bun --cwd webui install
bun run dev
```

打开 <http://127.0.0.1:5173>。API 仍为 `9233`，WebUI 通过 Vite 代理 `/api`；也可用 `bun run dev:api` / `bun run dev:webui` 分别启动。已有 Vite 服务需要重启一次以加载新增的代理配置。

使用 `bun:sqlite`，首次启动自动创建 `data/viewview.sqlite` 和表；可通过 `DATABASE_PATH` 改变数据库文件位置。价格以整数「分」保存。数据库、WAL 文件及前端构建产物不提交到 Git。

SQLite 保存商品、价格历史和任务队列。队列由单个 worker 按顺序调用现有抓取器；同一商品不会重复排队，重启恢复未完成任务。抓取不到有效实际价会记为失败，而不是写入零值。删除商品会级联删除其任务和全部历史，正在执行的旧任务不会重新写入已删除商品。

### 同款比价

先在淘宝或京东 tab 中新增商品记录，再到「同款比价」创建商品组，填写一致的型号、容量、频率等规格，勾选待关联记录并确认同款后关联。每个商品记录最多属于一个同款组，换组前需先移出原组。组内已有记录时规格不可直接修改，防止不同配置混算。

比价摘要以组内最新有效报价的北京时间日期为比较日期，只使用同一日期的记录；不同日期的旧报价仍会显示，但不参与该日期的最低价和均价。这是历史记录比较，不代表实时最低价。曲线按所选范围按小时或按天取每个 SKU 的最后一次有效价格再算均价，不会让重复采集的 SKU 获得更高权重，也不会用零填补缺失记录。

分组仅新增 `product_groups` 和 `group_members` 表，不重建现有商品表或清空数据。移出关联、删除组都保留商品、任务和价格历史；已有历史会按当前关联成员重新计算同款曲线。

同款由用户确认，不根据标题自动匹配。京东跟踪 SKU ID；淘宝目前跟踪 item 页面展示价，没有自动切换具体淘宝 SKU 规格，所以多规格商品必须确认展示价对应的规格后再关联。平台总览均价仍只是监控指标，不能代替同款比价。

新增 REST 接口不受旧抓取接口的 `ALLOW_GET` / `ALLOW_POST` 开关限制。配置了 `ACCESS_TOKEN` 时，全部 `/api` 请求需要 Bearer token，前端会显示密钥输入框并仅在当前浏览器会话保存。对外开放服务前请配置密钥；这些接口包含数据库写入和删除操作。

```text
GET    /api/products?q=搜索词
POST   /api/products                       { platform, item_ids: ["123"], name?, notes? }
GET    /api/products/:id
PATCH  /api/products/:id                   { name?, notes? }
DELETE /api/products/:id
GET    /api/jobs
POST   /api/jobs                           { product_ids: [1, 2] }
GET    /api/products/:id/history?range=7d
GET    /api/history/average?range=7d&platform=jd&product_id=1&product_id=2
POST   /api/products/:id/observations       { actual_price, daily_price?, observed_at }
DELETE /api/observations/:id
GET    /api/groups
POST   /api/groups                         { name, specification, notes? }
PATCH  /api/groups/:id                    { name?, specification?, notes? }
DELETE /api/groups/:id
POST   /api/groups/:id/members             { product_ids: [1, 2], confirmed_same_model: true }
DELETE /api/groups/:id/members/:productId
POST   /api/groups/:id/jobs
GET    /api/groups/:id/comparison?range=7d
```

商品 `item_ids` 是平台商品 ID 的字符串；`product_ids` / 路径 `:id` 是 SQLite 的商品记录编号。批量新增与入队每次最多 100 个。平台和商品 ID 不可编辑，以免混合不同商品的价格历史；更换商品请删除并重新新增。手动记录的 `observed_at` 必须是带时区的 ISO 时间。

数据层和队列测试使用独立的内存数据库，不需要连接浏览器，也不会修改正式数据：

```powershell
bun run test
```

---

服务端需要安装 chromium、chrome 或者 edge。默认情况下，API 启动时会自动侦测浏览器位置，启动一个独立窗口并打开 `about:blank`，方便先登录京东和淘宝；浏览器在 `127.0.0.1:9222` 暴露 CDP 调试端口，已有的 CDP 实例会直接复用。设置 `AUTO_LAUNCH_BROWSER=false` 可关闭自动启动并恢复为手动提供 CDP。

浏览器启动参数中的 profile 使用 Chromium 实际支持的 `--profile-directory`，例如 `PROFILE_NAME=Default` 或 `PROFILE_NAME=Profile 1`；不会使用不存在的 `--profile` 参数。自动启动默认使用临时目录下独立的 `viewview` 用户数据目录，以避开 Edge/Chrome 的单实例锁和 Chrome 136+ 对默认用户目录 CDP 的限制。可用 `BROWSER_PATH` 指定可执行文件、`BROWSER_USER_DATA_DIR` 指定一个专用用户数据目录，但不要指向日常浏览器的 `User Data` 目录。

挑战页会在同一个浏览器会话中等待最多 300 秒，验证自然完成后再提取页面；不会自动处理需要交互的验证码。

默认启用内置站点兼容性 UA profile；设置 `ENABLE_UA_OVERRIDE=false` 可关闭。微信 profile 同时调整语言、Client Hints 和移动视口，不只是替换 UA 字符串。

效果类似：

![Demo](/assets/demo.png)

演示地址：https://viewview.gy.run
