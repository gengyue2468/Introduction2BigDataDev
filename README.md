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

需要在服务端安装 chromium、chrome 或者 edge，并在 `127.0.0.1:9222` 暴露 CDP 调试端口。挑战页会在同一个浏览器会话中等待最多 300 秒，验证自然完成后再提取页面；不会自动处理需要交互的验证码。

默认启用内置站点兼容性 UA profile；设置 `ENABLE_UA_OVERRIDE=false` 可关闭。微信 profile 同时调整语言、Client Hints 和移动视口，不只是替换 UA 字符串。

效果类似：

![Demo](/assets/demo.png)

演示地址：https://viewview.gy.run
