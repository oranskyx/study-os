# 交接文档 · 错题中枢（study-os）

> 给**下一个接手的人或 AI 会话**：读完这一份就能接着改，不用翻聊天记录。
> 配套阅读：[README.md](README.md) 面向使用者，本文面向开发者。
>
> 最后更新：2026-11-09

---

## 0. 30 秒速览

一个**单机自用**的错题管理 Web 应用，跑在自己家电脑上，手机通过局域网访问。

```
拍一页错题本 → AI 识题 → 逐条核对入库 → 周末自动组卷 → 打印带到学校
      ↑                                                      ↓
      └──────── 回收对错结果 ← 回校手写做完 ←────────────────┘
```

- 使用者：一名高一学生，六科（语数英物化生），**周一至周五在校无设备**，周六 17:00 到家、周日 17:00 返校。
- 所以整套设计围绕「**周末批处理**」，不是每日打卡。见第 1 节，别改坏这个前提。
- 技术栈：Node.js 24 + Express 4 + `node:sqlite` + 原生 ESM 前端（**零构建**）。
- 代码量：后端约 2100 行，前端约 2000 行，合计约 4100 行。
- 测试：**185 项断言**，`npm run test:all` 一条命令跑完（隔离环境，不碰真实数据）。
- 当前状态（2026-11-12）：服务跑在 `0.0.0.0:7788`，开机自启已装，两个本地提交**未推送**，
  下一轮从 §18 的 P1 接着做。

---

## 1. 设计意图（改之前先读）

这些决定不是随手选的，改掉会直接破坏使用场景：

| 决策 | 原因 |
|---|---|
| **不做每日推送 / 每日任务** | 学生在校 6:00–22:30，没有设备。每日提醒只会变成噪音。 |
| **遗忘曲线改成「按周末的轮次」** | 标准艾宾浩斯是 1/3/7/15 天，但人在学校。所以复习单**只按周生成**，周末打印带走。 |
| **复习单自动排到「下一周」** | 周日晚上生成时，学生要用的是下周一到周五的那张单子。 |
| **30 天没错就自动归档** | 让系统**自己结束**。不然复习队列无限增长，最后一定会放弃。 |
| **拍照在手机端先裁切/压缩** | 省流量、省钱、上传快，识别也更准（去掉边框和桌面杂物）。 |
| **零构建前端** | 学生电脑不该有 vite/webpack 工具链。改完 `Ctrl+R` 就生效。 |
| **`node:sqlite` 而不是 better-sqlite3** | 零原生依赖、不用 node-gyp 编译。Windows 上装 better-sqlite3 经常失败。 |
| **KaTeX 本地托管，不走 CDN** | 国内 jsdelivr 实测 `HTTP 000`，公式会整片退化成 `$...$`。 |
| **模型走 OpenAI 兼容协议** | 换 `baseURL` 就能换厂商，不绑定 DeepSeek。 |

---

## 2. 当前状态

### 能用的

| 模块 | 状态 |
|---|---|
| 拍照录入（裁切 + 旋转 + 压缩 + 上传） | ✅ |
| AI 识题（题干/答案/解析/考点/难度/错因） | ✅ 需配置视觉模型 |
| 逐条核对 + **LaTeX 即时预览** | ✅ |
| 错题库（筛选、搜索、详情、软删除） | ✅ |
| 错因深挖（AI 追问 + 归类） | ✅ |
| 变式训练（AI 生成 + 人工审核） | ✅ |
| 遗忘曲线调度 + 复习单生成 | ✅ |
| 打印视图（题目页 / 答案页分开） | ✅ |
| 周报 / 月报 | ✅ |
| 方法论合并（methods 表） | ✅ |
| 配置面板（baseURL / key / 模型列表可视化） | ✅ |
| 局域网 + 二维码 | ✅ |
| 开机自启动 / 停止脚本 | ✅ |
| 移动端适配（360 / 390 / 414 实测） | ✅ |

### 还没做的

见第 13 节「没做完的事」。最影响体验的是**考点树只覆盖数学**。

---

## 3. 三条命令跑起来

```powershell
cd study-os
npm install
npm start          # 或双击 start.cmd
```

打开 `http://127.0.0.1:7788`。手机连同一个 WiFi，扫首页二维码。

```powershell
npm run test:all           # 全部 184 项，隔离环境，约 20 秒
npm run autostart:install  # 开机自启（可选）
npm run stop               # 停止服务
```

---

## 4. 架构与数据流

```
浏览器（public/，零构建）
   │  fetch JSON / multipart
   ▼
Express 服务（server/index.mjs，0.0.0.0:7788）
   ├─ db.mjs       建表 + 迁移 + 数据目录
   ├─ logic.mjs    纯规则：复习间隔、状态机、组卷、周报统计
   ├─ ai.mjs       模型调用（OpenAI 兼容 /chat/completions）
   ├─ prompts.mjs  提示词（识题、追问错因、出变式、写周报）
   └─ settings.mjs 配置：库 > .env > 默认
   │
   ├──► data/study.db        SQLite（WAL）
   └──► data/uploads/        原始照片
```

**分层原则**：`logic.mjs` 里是**纯函数**（不碰网络、不碰 Express），所以规则可以单独测。
`index.mjs` 只做路由和 IO。加功能时保持这个边界。

---

## 5. 数据模型

SQLite，11 张表。`data/study.db`，WAL 模式。

| 表 | 作用 | 关键字段 |
|---|---|---|
| `subjects` | 六科字典 | `id`(math/chinese/...), `name`, `sort` |
| `kps` | 考点树 | `subject_id`, `chapter`, `name` — **目前只有数学 28 条** |
| `pages` | 上传的整页照片 | `image_path`, `status`(pending/done/failed), `error`, `raw_json`, `note` |
| `questions` | 错题 | 见下 |
| `attempts` | 每次做对/做错的流水 | `question_id`, `at`, `result`, `via` |
| `sheets` | 一张复习单（一周一张） | `week`(ISO 周如 `2026-W46`), `status`, `printed_at` |
| `sheet_items` | 单子里的每道题 | `sheet_id`, `question_id`, `day`(周内第几天), `position`, `result` |
| `variants` | 变式题 | `question_id`, `kind`, `tier`, `verdict`(审核状态), `source` |
| `methods` | 方法论 | `subject_id`, `kp_id`, `title`, `body`, `version`, `status` |
| `reports` | 周报/月报 | `kind`(weekly/monthly), `period`, `body_md`, `data_json` |
| `settings` | 配置 KV | `key`, `value` |

### questions 表要点

```
status          'first'(头次错) / 'key'(重点错题) / 'archived'(已掌握)
error_count     累计错几次 —— 到 2 次自动升 key
correct_streak  连续做对几次
review_count    复习过几次
variant_mode    变式策略
first_error_at / last_error_at / last_review_at / next_review_at
archived_at / archive_reason
deleted_at      软删除；所有查询都带 deleted_at IS NULL
```

**状态机与间隔**（`logic.mjs`）：

- 头次错：1 / 3 / 7 / 15 天
- 重点错题：1 / 2 / 4 / 7 / 14 / 21 天
- 做错一次 → 回到曲线起点，`correct_streak` 清零
- 30 天没再错 → `archived`

> 改间隔请只改 `logic.mjs` 里的常量，`test:api` 会锁住这些规则。

---

## 6. HTTP 接口

所有接口在 `server/index.mjs`，返回 JSON（错误时 `{ error }` + 非 200）。

```
元信息
  GET    /api/meta                     科目、考点、今天、本周、配置就绪状态
  GET    /api/lan                      局域网地址 + 二维码(base64 PNG)

配置
  GET    /api/settings                 读配置（key 只回后四位）
  PUT    /api/settings                 写配置
  POST   /api/settings/models          拉厂商的模型列表（填 baseURL+key 后）
  POST   /api/settings/clear-key       清空某个 key
  POST   /api/ai/test                  实测连通性

录入
  GET    /api/pages                    上传历史
  POST   /api/pages                    multipart 上传（字段 photo + subject_id）
  POST   /api/pages/:id/extract        让模型识题 → 返回草稿（不落库）
  DELETE /api/pages/:id                删页面

错题
  GET    /api/questions?status=        列表（all/first/key/archived）
  POST   /api/questions/bulk           批量入库（核对后的草稿）
  GET    /api/questions/:id            详情（含变式、attempts）
  PATCH  /api/questions/:id            改字段
  DELETE /api/questions/:id            软删除
  POST   /api/questions/:id/attempt    记录一次做对/做错 → 推进曲线
  POST   /api/questions/:id/diagnose   AI 追问错因
  POST   /api/questions/:id/variants   AI 生成变式
  POST   /api/questions/:id/variants/manual  手工加变式

复习单
  GET    /api/sheet                    本周/指定周
  POST   /api/sheet                    生成（自动排到下一周）
  GET    /api/sheet/:id                单张详情
  POST   /api/sheet/:id/fill           回填对错结果
  DELETE /api/sheet/:id

周报 / 月报 / 方法论
  GET/POST /api/report                 生成/读取周报
  GET/POST /api/report/monthly         月报
  GET    /api/methods                  方法论列表
  PATCH  /api/methods/:id              改方法论

维护
  POST   /api/maintenance/run          手动跑一次归档/调度维护
```

---

## 7. 前端结构

`public/`，**没有打包器**，浏览器直接跑原生 ESM。

- `index.html` — 外壳，引入本地 KaTeX（`/vendor/katex`，由服务端静态托管 `node_modules/katex/dist`）。
- `app.js`（约 1600 行）— 全部界面逻辑。
- `style.css` — 有专门的 `@media (max-width: 760px)` 段做移动端适配。
- `print.html` / `print.js` — 打印视图（题目页与答案页分开）。
- `sw.js` — Service Worker。

### 路由

hash 路由，`render()` 全量重渲染（不做虚拟 DOM）：

```
#/           home      首页仪表盘 + 二维码
#/capture    capture   拍照录入
#/bank       bank      错题库
#/q/:id      q         错题详情
#/sheet      sheet     复习单
#/report     report    周报/月报
#/settings   settings  配置
```

`main.dataset.view` 会同步成当前视图名，**测试就是靠它判断渲染成功**，别删。

### 三个基础设施函数

| 函数 | 作用 |
|---|---|
| `richInline(s)` / `richBlock(s)` | Markdown + `$...$` 转 HTML（所有内容字段都必须走这两个，不要直接 `mEsc`） |
| `typeset(el)` | 在这一块里跑 KaTeX，返回 `.katex` 个数；缺 KaTeX 会 toast 而不是静默 |
| `mountDraftPreview(root)` | 识别结果里每栏下面的**即时预览**（输入后 200ms 防抖渲染） |

### 录入流程（改这里前务必读）

```
<input id="capCam" capture="environment">  ┐ 两个入口都用 <label> 包住
<input id="capFile">                       ┘ （programmatic click 会让浏览器忽略 capture）
        ↓ change
pickPhoto(file)
        ↓
openImageEditor(file)   Promise<Blob|null>  裁切 + 旋转，取消返回 null
        ↓
handlePhoto(blob)      压缩(1400px) → POST /api/pages → extract → 草稿
        ↓
draftCard() + mountDraftPreview()
```

**注意**：`capture` 只在 `<label>` 触发的真实用户手势下生效；用 JS `.click()` 触发时很多浏览器会直接开相册。
另外 `http://192.168.x.x` 不是安全上下文，`getUserMedia` 用不了，所以**不能**做页内相机。

---

## 8. 配置系统

优先级：**SQLite `settings` 表 > `.env` > 代码默认值**。

| 键 | 说明 |
|---|---|
| `vision_base_url` / `vision_api_key` / `vision_model` | 识题用的多模态模型 |
| `text_base_url` / `text_api_key` / `text_model` | 文本模型（错因、变式、周报） |

- 界面上在 `#/settings`，**不需要改文件**。
- API key 只回显后四位，输入框是 `type=password`，永不回传明文。
- 「拉取模型列表」`POST /api/settings/models` 调厂商的 `GET /models`。
- 零成本预览：`mock.cmd` 起一个本地假模型（`127.0.0.1:7799/v1`，key 随便填），返回硬编码数据。

---

## 9. 测试体系

```powershell
npm run test:all     # 推荐：隔离环境跑全部 5 个套件
```

`test:all`（`tools/test-all.mjs`）做的事：

1. 在系统临时目录新建一个空 `DATA_DIR`；
2. 用随机空闲端口起**一个服务实例** + **一个 mock 模型服务**；
3. 依次跑 5 个套件，全部只对这套临时环境发请求；
4. 跑完杀掉进程、删目录。**真实 `data/` 一个字节都不动。**

| 套件 | 文件 | 断言 | 覆盖 |
|---|---|---|---|
| `test:e2e` | `tools/e2e-mock.mjs` | 17 | 上传→识题→入库→变式→组卷→周报全链路（接 mock） |
| `test:math` | `tools/mathtest.mjs` | 15 | KaTeX 真的执行、`.katex` 生成、Markdown 结构、无 CDN |
| `test:ui` | `tools/uidom.mjs` | 46 | 每个视图真实渲染（jsdom 执行 app.js）+ 点击交互 + 设置面板 |
| `test:api` | `tools/smoke.mjs` | 67 | 接口、调度规则、归档规则、复习单、周报统计、二维码可扫 |
| `test:mobile` | `tools/mobilecheck.mjs` | 39 | 无头 Edge 真排版：360/390/414 三档溢出、触摸目标、字号、拍照入口 |

### 三条纪律

1. **测试不许碰真实配置**。`tools/settings-guard.mjs` 做整表快照，跑完（含崩溃/中断）还原。
   写过库的测试都必须用它。
2. **顺序有依赖**：`test:math` 依赖 `test:e2e` 先灌入有公式的题目。
   单独跑 `test:math` 前要先跑一次 `test:e2e`。（这是已知的耦合，见第 13 节。）
3. **`--clean` 是「跑完删」不是「跑前清」**。搞反过一次，把演示数据清了。

单独跑某个套件时（需要服务已在跑）：`BASE=http://... npm run test:api`，注意它会写**真实库**。

---

## 10. Windows 特有的坑（都是踩出来的）

| 坑 | 现象 | 正确做法 |
|---|---|---|
| `.cmd` 里有中文 | `'xxx' 不是内部或外部命令`，退出码 255 | **所有 `.cmd` 必须纯 ASCII**。cmd.exe 按 OEM 代码页读文件，多字节字符会吃掉下一行。检查：`LC_ALL=C grep -c $'[\x80-\xff]' *.cmd` 必须是 0 |
| `cygpath` | `command not found` | 用 `pwd -W` 拿 Windows 路径 |
| Windows 版 python 读 MSYS 路径 | `No such file` | 传 `D:/...` 而不是 `/d/...` |
| `python - <<'PY'` heredoc | 命令**挂死**不动 | 不要给 Windows python 喂 heredoc，用 `-c` 或写成文件 |
| bash `timeout` 包装 `start` | 调到了 Windows 的 `TIMEOUT.EXE` | 不要用 `timeout` 包装 Windows 命令 |
| `taskkill` | 别用 `taskkill /IM node.exe` | DSH 自己就跑在 node 上。**只杀监听 7788 的那个 PID**（`stop.cmd` 已经这么做了） |
| 删 `data/` | `Device or resource busy` | 先停服务再删 |
| 后台任务 | mock 被提前杀掉，e2e 挂住 | mock 和 e2e 要在**同一次** shell 调用里起 |
| Edge 的 `last_visit_time` | `Value is too large to be represented as a JavaScript number` | SQL 里 `CAST(x/1000 AS INTEGER)` |
| 桌面路径 | `C:\Users\oransky\Desktop` 不存在 | 实际被重定向到 `D:\oransky\Desktop` |

---

## 11. 局域网与手机

- 服务监听 `0.0.0.0:7788`，启动横幅会打印每个网卡的真实地址。
- **IP 会变**（DHCP）。所以首页二维码是**每次请求现算**的（`GET /api/lan`），不是写死的。
- 电脑连的是手机热点，网络被识别为「公用」；防火墙已有 Node.js 的入站 Allow 规则，所以不需要管理员。
  换机器/换 Node 安装位置后要重新放行（`New-NetFirewallRule`，需管理员）。
- `http://192.168.x.x` **不是安全上下文**：`getUserMedia`、`clipboard` 等 API 不可用。
  拍照只能靠 `<input capture>`。
- 微信内置浏览器 / 部分国产浏览器会**忽略 `capture`** 直接开相册；换 Chrome / Safari 正常。
  界面上已经写了这句提示。

---

### 安全边界（重要）

这个服务**没有登录、没有鉴权**，默认 `HOST=0.0.0.0`。设计前提是「只在自己家的局域网里用」：

- 同一 WiFi 下**任何设备**都能读写你的全部数据（题目、变式、配置）；
- **API key 明文存在 `data/study.db` 的 `settings` 表**里，复制 `data/` 就等于交出 key；
- 上传的原图经 `/uploads` 公开可访问（同局域网内）；
- 「拉模型列表」接口只允许复用**同一个 Base URL** 下已存的 key；换了地址必须先填新 key——
  否则等于「任何人丢个 URL 过来就能把你的 key 发到自己的服务器」；
- 想收紧：`HOST=127.0.0.1`（手机就连不上），或只在可信 WiFi 下开。

---

## 12. 已知问题（真实存在，别当没有）

1. **手写识别不完美**：字迹潦草、多行公式、几何图会错，所以「逐条核对」是必需步骤，不是可选。
2. **几何图 / 函数图象识别不了**，会留占位符。
3. **考点树只有数学**（人教 A 版必修一，28 个考点）。其余五科 `kps` 表是空的，选考点时下拉框只有「未标注」。
4. **变式题质量不稳定**：小考点换数换情境还行，大综合题不如教辅。
5. **`test:math` 依赖 `test:e2e` 先造数据**（顺序耦合）。想解耦需要让 mathtest 自己 seed。
6. **单独跑 `test:api` / `test:ui` / `test:e2e` 仍会操作真实库**：会把配置临时改成 mock（跑完整表还原，
   崩溃也会还原），造的题跑完会真删；但 `test:e2e` 的**演练数据默认保留**（加 `--clean` 才删）。
   想绝对干净就用 `npm run test:all`。
7. **`server/index.mjs` 已经 700 行**，路由和业务混在一起，再长就该拆了。
8. **没有数据库迁移框架**：`db.mjs` 里是 `CREATE TABLE IF NOT EXISTS` + 手写 `ALTER`。改表结构要自己写兼容代码。
9. **没有导出/备份功能**：备份靠停服后复制 `data/` 目录。

---

## 13. 没做完的事（按建议优先级）

### P1 — 最影响体验

1. **补齐五科考点树**
   - 位置：`server/db.mjs` 的种子数据，表 `kps(subject_id, chapter, name)`。
   - 现在只有 `subject_id='math'` 的 28 条。语文/英语/物理/化学/生物都没有。
   - 完成后 `#/capture` 的考点下拉、`#/report` 的考点趋势分析才有意义。
2. **成绩 / 排名模块**
   - 新表 `exams(id, subject_id, date, score, full_score, rank, total_students)`。
   - 前端加 `#/exams` 视图，画成绩曲线 + 与复习量的相关性。

### P2 — 值得做

3. **家长看板**：一个只读的 `#/parent` 视图（本周做了多少题、正确率、复习完成度），不需要交互。
4. **教辅变式手工录入 UI**：`POST /api/questions/:id/variants/manual` 接口已经有了，前端没做入口。
5. **`test:math` 自造数据**，去掉对 `test:e2e` 的顺序依赖。
6. **拆分 `server/index.mjs`**：按域拆成 `routes/question.mjs` / `routes/sheet.mjs` 等。
7. **数据导出**：`GET /api/export` 返回全量 JSON（题目 + 变式 + 方法论），方便换机或备份。

### P3 — 锦上添花

8. **GitHub Actions**：`ubuntu-latest` + Node 24 跑 `test:all`。
   注意 `test:mobile` 需要 Edge（`mobilecheck.mjs` 硬编码了 Windows 的 Edge 路径），CI 上要跳过或改成 Playwright。
9. **PWA 缓存版本号是写死的**：`public/sw.js` 里 `const CACHE = 'cuoti-v1'`。
   策略是「网络优先、断网回退缓存」，所以在线时不会看到旧页面；但真要强制刷新壳子，改这个版本号即可。

---

## 14. 上传到 GitHub

**状态：已发布** → <https://github.com/oranskyx/study-os>（public，默认分支 `main`）。

日常推送：

```powershell
cd study-os
git add -A
git commit -m "feat: ..."
git push            # origin 已配置好，直接推
```

CI 在 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)：push / PR 时在
`ubuntu-latest` 和 `windows-latest` 上各跑一次 `npm ci && npm run test:all`。
Linux 上没有 Edge，`test:mobile` 按设计以退出码 2 跳过（`test:all` 记为「跳过」，不算失败）；
Windows runner 自带 Edge，39 项移动端断言会真跑。

仓库里**不该有**：`data/`、`node_modules/`、`.env`、`.npm-cache/`、`*.log` —— `.gitignore` 已经排除了。
`.gitattributes` 保证 `.cmd/.vbs` 检出时是 CRLF（cmd.exe 依赖 CRLF），其余文件统一 LF。

**推送前自查**：

- [ ] `git status` 里**没有** `data/` 和 `.env`
- [ ] 代码里没有残留的 `sk-` 明文（key 只在运行时从库里读）
- [ ] `LICENSE` 里的名字是 `oransky`，想改就改
- [ ] README 里的截图链接还有效（截图在 `data/_shots/`，**不会被提交**，想放 README 就把图拷到 `docs/`）

> 因为 `data/` 被忽略，克隆下来是**空库**：`npm install && npm start` 后会自动建表，
> 想看演示数据可以 `npm run mock` + `npm run test:e2e`。

---

## 15. 给新 AI 会话的开场提示词

把下面这段直接粘给新的对话（无上下文也能接上）：

```
我在开发一个叫 study-os 的本地错题管理系统，代码在
D:\oransky\Desktop\oransky\dsh\study-os

请先读项目根目录的 HANDOFF.md（交接文档），再读 README.md。
读完之前不要改任何代码。

背景要点：
- 使用者是我（高中生），周一到周五在校没设备，周六晚到家、周日下午返校，
  所以整套系统围绕"周末批处理"设计，不做每日推送。
- 技术栈：Node 24 + Express 4 + node:sqlite + 零构建原生 ESM 前端。
- 服务跑在本机 0.0.0.0:7788，手机通过局域网扫码访问。
- 数据库在 data/study.db，里面有我的真实数据，测试时不许污染。

工作方式要求：
- 改完必须跑 `npm run test:all`（隔离环境，不会碰真实数据），全绿才算完成。
- 所有 .cmd 文件必须保持纯 ASCII，否则 Windows cmd 会解析错乱。
- 不确定的需求先问我，不要自己猜着做。

现在我想做：<在这里写你的需求>
```

---

## 16. 变更记录

### 2026-11-13（第六轮：闭环补齐 + 批量 + 裁剪编辑器）

按「先让系统不说谎 → 补空前端 → 批量 → 重构裁剪」的顺序做完六批。

**P1 说真话**

- 首页新增「一直没排上队的题」：review_count=0 且已到期的题单列（GET /api/questions?stale=1）。
  以前这些题会被 dueNow 混在里面，看不出「排了但从来没轮到」。
- 错题库加搜索框（题干/错因，输入防抖 260ms，焦点保持），并新增「按考点」聚合
  （GET /api/questions/group?by=kp|subject|type），点聚合行直接筛到该考点。

**P1 断掉的回路**

- 归档题可「重新激活」：POST /api/questions/:id/reactivate，清 archived_at/archive_reason、
  correct_streak 归零、next_review_at 设为现在。自动归档仍是单向的，只有手动才回得来。
- 变式题人工审核：详情页每题四个按钮写 variants.verdict（good/too_hard/too_easy/wrong）。
  这一列和 PATCH /api/variants/:id 从第一版就存在，前端一次都没调用过。

**P2 空前端补上**

- #/methods 方法论视图（列表/编辑/新增），周报页加入口；新增 POST /api/methods。
- GET /api/export 全量导出 JSON（题目/记录/变式/复习单/方法论/考试），设置页加下载按钮。
  导出不含 API key（key 在 settings 表，不在导出集合里）。

**P2 批量**

- 错题库每张卡加勾选框，选中后出现批量条：改考点 / 标为重点 / 标为头次错 / 删除 / 取消。
  后端 POST /api/questions/batch，字段白名单，一次请求改多道。
- 录入核对：置信度 ≥85% 的草稿把「答案/错因/解析」折进 details，题干和考点仍然摊开；
  20 道题从 120 个检查点降到每道 2 个必看。

**P3 裁剪编辑器重构（public/app.js openImageEditor）**

| 之前 | 现在 |
|---|---|
| 不能缩放，字小的图看不清 | 工具栏 −/+ 缩放（1x~4x），舞台可滚动；缩放以按点为中心，不会跟丢 |
| 手机没法放大 | 双指捏合缩放（pointer 事件，顺带禁掉页面滚动） |
| 只有四角把手 | 四角 + 四边把手；把手尺寸随框自适应（22~44px），小框不会盖死整张图 |
| 想重框得先取消 | 「重新框选」按钮清空框，再在图上拖一下就是新框 |
| 全图缩回要靠「全图」 | 「全图」重置旋转与缩放；缩放有百分比显示 |

对齐仍然按 getBoundingClientRect 算（含滚动偏移），所以放大后拖框不会偏。

**测试**

- test:api 68 → 83 项：聚合/搜索/stale/重激活/导出/方法论。
- 新增 tools/cropcheck-extra.mjs 11 项：缩放、百分比、重新框选、边把手只改一个方向、双指缩放。
  这套没进 test:all（需要真浏览器 + 测试图），单独跑：
  BASE=http://127.0.0.1:7788 node tools/cropcheck-extra.mjs。
- 回归 tools/cropcheck.mjs 5 项：对齐偏移仍是 0,0（含旋转与缩放）。
- 总计 test:all 228 项全绿。

### 2026-11-13（第五轮：试卷分析）

新增「考试」页（第 7 个页签）：传原卷/答题卡/答案 → 自动判类型 → 识别 → 人工核对 → 收错题 → 失分分析。

**数据模型（db.mjs）**：exams / exam_pages / exam_items 三张表；questions 加 exam_id、exam_item_id 两列
（ALTER TABLE 兼容旧库，不需要重建）。删考试会连带删图片与暂存条目，但已收进错题库的题不受影响。

**接口（server/exams.mjs，独立 Router 挂 /api/exams）**

- 考试：GET/POST /，GET/PATCH/DELETE /:id
- 图片：POST /:id/pages（一次 20 张）、PATCH/DELETE /pages/:pid
- 识别：POST /pages/:pid/extract（视觉模型，返回判定的 role 与题目草稿）
- 暂存：POST /:id/merge（按题号合并、同题号补空字段不覆盖人工修改）、
  POST /:id/items（手工补一道）、GET /:id/items、PATCH/DELETE /items/:iid
- 入库：POST /:id/import（默认只收 wrong/partial，带分数与批改痕迹）
- 分析：GET /:id/analysis（失分按考点/题型/难度、丢分 Top、同科目历次）

**提示词（prompts.mjs examPageMessages）**

先把图判成 paper / answer_sheet / answer_key / graded / mixed / unknown 六类之一（给置信度和理由），
再按类型抽题。特别写了三条：手写 vs 印刷要标 handwriting；批改痕迹（×、-2、半对）要折算成
score_got 与 verdict；答案只能来自答案页/评分标准，不许自己解题。图形仍按上一轮的规则文字化。

**前端（public/exams.js，独立 ESM，挂 window.__exams）**

列表 / 新建 / 详情三段式（①上传与识别 ②人工核对 ③分析）。选图后先看类型再识别，
识别完合并，核对页把 10 个字段摊平在一张卡上改，「保存全部修改」一次性 PATCH。
app.js 通过 window.__app 提供 api/esc/toast/kpOptions 等工具，点击事件按 ^exam- 前缀委托过来。

**测试**：新增 tools/examtest.mjs（28 项），并给 mock-ai.mjs 加了"高考阅卷组"分支，
所以「上传两张 → 改类型 → 识别 → 合并 → 不重复合并」这条链路在 test:all 里是真跑通的。
总断言 213 项。

**已知取舍**

- 一场考试只对应一个科目（同一晚可以建多场），避免统计口径混乱；
- 答题卡按中高考标准卷处理，涂卡识别不准时 my_answer 留 null 并提示人工确认；
- 跨页的题目前只靠 incomplete 标记提示，没有自动拼接。

### 2026-11-13（第四轮：月报数据看板）

周报/月报原来只有 4 个数字 + 几条排行，看不出"趋势"。本轮把统计做成看板。

**服务端（server/logic.mjs）** 新增四个纯函数，挂在 stats 里随 GET /api/report 和
GET /api/report/monthly 一起返回（图表数据是算出来的，不是让模型编的）：

- dailySeries：逐日重做次数 / 做对数 / 新增错题（按本地日期分桶，不是 UTC）
- completionStats：复习单计划 / 做对 / 做错 / 待回填 / 完成率
- subjectStats：科目分布
- longTermSeries(month, 6)：近 6 个月的新增、重做、正确率
- 月报另加 by_difficulty

**前端（新文件 public/charts.js，纯 SVG，无依赖、无 CDN）**

- 每日节奏：柱=做题量，红线=当日正确率（样本少于 3 不画点）
- 科目分布：环形图 + 图例（数量与占比）
- 错因构成 / 考点 Top / 难度分布：横向条形
- 复习完成度：进度条 + 完成率过低时的提示
- 近 6 个月：柱线组合 + 表格
- 本月 vs 上月：表格带上下箭头（正确率涨是好事，错题量涨是坏事，颜色按语义分）

**周报刻意保持轻量**：7 日节奏 + 完成度 + 科目分布 + 考点 Top，四块，不做长期趋势。

加载方式：charts.js 作为独立 ESM 由 index.html 先加载，挂到 window.__charts；
app.js 取不到时降级为空字符串——这样 jsdom 的 test:ui 不需要引入图表依赖。

验证：npm run test:all 185 项全绿；tools/designcheck.mjs 加 --act 参数点进本月视图，
390/1280 两档 0 溢出、0 低对比、0 小触控（图表坐标轴最小 10px）。
### 2026-11-12 晚（第三轮：图形识别）

用户反馈"识题只给一个【图】，没法用"。根因是提示词第 5 条主动教模型写占位符：
"图片、几何图、坐标系无法转成文字时，用占位符 [图] 标注"。模型照着做了。

- **提示词改写死**（`server/prompts.mjs` 铁律 5）：图形必须翻成文字，禁止裸占位。
  按类型给了模板——几何图写点/线/角的标注与平行垂直相等中点等关系；
  函数图象写坐标系、表达式、关键点、单调性、阴影区域；表格用 Markdown；
  电路/受力图写连接方式与方向；真看不清写〔图看不清：…〕并降 confidence 到 0.5 以下。
  描述要写在图在题干中出现的位置，不堆末尾。
- **UI 兜底**：识别结果卡片里加「对照原图」折叠块（直接用 `/uploads/` 的原图），
  详情页加「看原图（第 N 页）」；模型仍给占位时，草稿卡片顶部弹黄色提示，
  引导照着原图补一句〔图：……〕。

注意：这条要靠真实视觉模型才能验证；mock 测试不覆盖提示词效果。
新拍一页含几何图的错题本，看模型是否给出文字描述而不是 [图]。

### 2026-11-12 晚（第二轮：设计收口）

用户反馈"绿色丑、圆角太大、学分 Claude 的审美"，据此重做，并顺手修了两个渲染 bug。

**设计（提交 `9df5dcc`、`756bb95`）**

- 上一版的问题是**两套语言打架**：底色改成纸感米色、强调色换成砖红，但组件层还留着 indigo
  （`theme-color #4f46e5`、主按钮 hover `#4338ca`、聚焦环 `#b9bdf5`、提示条 `#3730a3`），
  圆角从 0/6/7/8/9/10/11/12/999 混用。已全部清掉，改成单一令牌。
- 第二轮按 Claude 的观感收敛：暖纸 `#faf9f5` / 墨 `#141413` / 赭 `#c96442`；
  **主按钮和选中态用墨黑，赭色只做链接与小标记**；圆角 4/6/8，卡片不投影；
  标题换衬线（Georgia + 宋体），正文仍是无衬线。**全站不再有绿色强调**（绿色只保留"做对"语义标记）。
- 打印视图同步（赭色抬头、墨色主按钮、A4 13mm 版心）。

**修的两个 bug**

| 现象 | 根因 | 改法 |
|---|---|---|
| 复习单在 390px 横向溢出 45px | 长 LaTeX 串没有断行点，`.slot .body`/`.small` 没设 `overflow-wrap` | 两处补 `overflow-wrap: anywhere` |
| 化学题显示成裸 \`\\(\mathrm{...}\\)\` | 模型偶尔输出 MathJax 定界符，前端只认 \`$...$\` | `app.js`/`print.js` 增加 `normMath()`，渲染前统一 |

**新增**

- `tools/designcheck.mjs`（`npm run design`）：无头 Edge + CDP 量真实排版，输出
  截图（`data/_shots/design/`）与统计——横向溢出、文字对比度、触控尺寸、圆角种类、字号分布。
  当前基线：390/1280 两档 6 个视图 **0 溢出 / 0 低对比 / 0 小触控**。

**数据**

- 删掉 3 条演示题（id 1~3，2026-11-08 的 seed 数据），只删这三条；删前整库备份在
  `data/_backup/`（不进仓库）。剩余 13 条是真实错题。

**验证**：`npm run test:all` 185 项全绿；已推送 `756bb95`，GitHub Actions 双平台绿。

### 2026-11-12（本轮）

改动集中在「修 bug + 补考点 + 识题智能化 + 瑞士风格 + 防假归档」。
两次提交：`34e4e30`（功能与修复）、`2e09167`（文档）。工作区已干净，**未推送**（见 §17）。

**修的 bug**

| 问题 | 根因 | 改法 |
|---|---|---|
| 裁切框和图片不对应 | 用 `scale × 坐标` 定位，但图片在舞台里是 flex 居中，旋转后偏移更大 | 改读 `getBoundingClientRect` 按实际显示位置定位（`public/app.js` `drawCrop`） |
| 拍完照片上传失败 | 拿到 file 后**立刻清空 input**，iOS Safari 之后就读不出那个 File 了 | 读完再清（`try/finally`） |
| 手指盖不住裁切框、缩小后拖不回去 | 无留白、手柄 26px、最小尺寸按原图算 | 舞台四周留 16px、手柄 34px、最小尺寸按屏幕像素兜底、框外也能起框 |
| 选标注只有数学章节 | `/api/meta` 写死 `kpList('math')` | 补齐六科考点（28 → **129 条**），接口返回全量，下拉按章节 `<optgroup>` 分组并**按科目过滤** |
| 没复习过的题被标"已掌握" | `applyStatusRules` 只看「30 天没再错」 | 加门槛 `review_count>=2 && correct_streak>=1`；常量 `ARCHIVE_MIN_REVIEWS/STREAK` 可配 |

**新增功能**

- 录入第三个入口：**手动录入**（打字，不走模型）。
- 错题**全字段编辑**：详情页「编辑」→ 题干/答案/解析/错因/科目/错因类型/难度。
- **自动标注考点**：该科目章节清单随提示词下发，模型从里面挑（不额外多一轮对话）。
- **分区识别**：提示词要求按 题干/我的答案/正确答案/解析/错因 分栏对应。
- **缺的自动补**：页面上没写错因，则根据题干+作答+正确答案推断，并标记 `error_cause_source`。
- **解析不自动生成**：新增 `POST /api/questions/:id/solution`，详情页按钮按需生成（省 token）。
- **4.1-flash HIGH**：`chat()` 支持 `reasoning_effort` + `thinking`，默认 `high`；厂商不认这两个字段时 400 自动降级重试。
- **错题库**：科目筛选、**吸顶工具栏**、右侧 14px 可拖拽滚动条（`.bank-toolbar` / `.bank-scroll`）。

**UI**

- 全站换**瑞士国际主义风格**：令牌（纸感底/墨黑/单一红 `#d92b1c`/直角/零阴影）+ 覆盖层 + 打印样式。
- `print.html` 同步重做（A4、14mm 版心、答案页红抬头、`break-inside:avoid`）。

**测试**

- 新增 `tools/cropcheck.mjs`：5 项裁切对齐检查（真浏览器量像素，实测偏移 0,0）。
- `smoke.mjs` 归档断言改成**双向**：没复习过的不归档、复习过且连对的归档。
- 全量 **185 项**（e2e 17 / math 15 / ui 46 / api 68 / mobile 39）全绿，真实数据零改动。

**没做完**

- 回收闭环（20 道点 40 次、"没做"无状态）、同类错题聚合、考试范围抽题、手写板、家长视图。
  优先级与落点见 §18。

### 2026-11-09

**新增功能**

- 新增**开机自启动**：`tools/autostart.mjs`（install/remove/status/stop）+ `_autostart.cmd` + `_autostart.vbs`，
  登录后静默起服务、不弹窗口、不自动开浏览器；重复运行会跳过，不会起第二个实例。
- 新增 **`stop.cmd`** / `npm run stop`：只杀监听 7788 的进程。
- 新增 **`npm run test:all`**：临时目录 + 随机端口 + mock 的隔离测试环境，5 个套件 184 项一次跑完，
  真实数据零改动（前后计数一致已验证）。
- 新增 **MIT LICENSE**、`package.json` 补 `license`/`author`/`engines`/`scripts`。

**安全加固**

- 「拉模型列表」不再把已存的 API key 发往**新的** Base URL（换地址必须先填那家的 key），
  堵住局域网内钓 key 的路径。
- `.gitignore` 加 `.env.*` 通配（原来只忽略 `.env`）。

**测试加固（此前会真丢 key / 留垃圾数据）**

- `test:e2e` 原来把 key 覆盖成 `mock` 且**不还原 key** → 现在用整表快照，跑完连同 key 一起还原，
  并新增一条断言守着这件事。
- `test:api` / `test:ui` 全部改走 `settings-guard`；还原语句包进事务（`BEGIN/COMMIT`），
  中途失败回滚，不会再出现「settings 表被删空」。
- 测试造的题**真删**（`hardDeleteQuestions`）：`DELETE /api/questions/:id` 是软删除，原来会在库里永久留行。
  顺手清掉了我此前测试留下的 7 条 `临时测试题：求 $1+1$。`。
- `test:api` 不再依赖「id=1 的题还在」（改用自己刚建的题），空库上也能跑。
- `test:mobile` 找不到 Edge 时改为**退出码 2（跳过）**，不再用 0 冒充通过——`test:all` 会显示「跳过」。
- `test:all` 把 `DATA_DIR` 透传给子套件：否则子套件的配置守卫会去读写**真实** `data/study.db`，隔离白做。

**修正**

- `engines` 从 `>=22.9` 改为 `>=22.13`：低于 22.13 时 `node:sqlite` 还要 `--experimental-sqlite`。
- `_autostart.cmd` 补上 `--env-file-if-exists=.env`（否则用 `.env` 配端口/key 时自启动不生效），
  时间戳改成 ASCII（原来 `%date%` 写进日志是 GBK 乱码）。
- 删死代码：`public/app.js` 的 `$$`、`server/settings.mjs` 的 `readAllSettings`/`__all`、
  `server/db.mjs` 的 `lastId`。

**上一轮（11-08）**

- 拍照双入口（`capture` 必须用 `<label>` 包裹）、裁切旋转编辑器、识别结果 LaTeX 即时预览、
  测试配置守卫（`tools/settings-guard.mjs`）。

---

## 17. 发布到 GitHub（2026-11-09 晚）

- 仓库：<https://github.com/oranskyx/study-os>（public，`main`，两个提交）。
- 仓库门面：README 顶部加徽章 + 4 张移动端截图（`docs/images/`，源图仍在 `data/_shots/`）；
  补「功能一览 / 技术栈 / 目录 / 路线图（原第 13 节）」，原作者的论述全部保留。
- 新增 `.github/workflows/ci.yml`（ubuntu + windows 双平台跑 `npm run test:all`）与
  `.github/dependabot.yml`；首次推送后两个 job 全绿（Linux 上 `test:mobile` 跳过，Windows 上 39 项真跑）。
- 新增 `.gitattributes`（`.cmd/.vbs` 强制 CRLF）与 `.editorconfig`；`package.json` 补
  `repository/homepage/bugs/keywords` 和 `npm test` 别名。
- 提交身份：`oransky <157782068+oranskyx@users.noreply.github.com>`。
- 本机网络：GitHub 走 Watt Toolkit（SteamTools）的本机 MITM，TCP 代理 127.0.0.1:7890 是**关的**，
  所以仓库本地配置了 `http.proxy=""`；git 用 schannel 认系统根证书，能直接推。
  若哪天推送报 502，多半是 Watt Toolkit 那条线路在抽风，重试或换加速节点。

---

## 18. 下一轮优先级（来自「无上下文模拟学生」的评估）

用一个完全不知道项目背景的子智能体扮演目标用户（高一、在校无设备、周末批处理），
先自己想清楚学习循环需要什么，再对照代码找缺口。结论按「不做就没法用」排序：

### P1（系统当前会"说谎"或闭环断了）

1. **归档可能误判**（已在本轮修掉一半）
   `applyStatusRules` 现在要求 `review_count>=2 && correct_streak>=1` 才归档。
   但仍需要：首页把「逾期但从没复习过」的题单列出来，否则用户不知道有题在排队排不上。
   位置：`server/logic.mjs:105`、`GET /api/meta` 的 counts。
2. **回收只能一道一道点**（20 道 = 40 次点击）
   `POST /api/sheet/:id/fill` 建议支持 `{ default:'correct', overrides:{qid:'wrong'} }`，
   前端加「全部算做对，我只改做错的」；`sheet_items.result` 增加 `missed` 表示"没做"。
   位置：`server/logic.mjs:256 fillSheet`、`public/app.js` 的 `viewSheet`。
3. **周报只有正确率，没有完成率**
   排 20 道做了 5 道，报"正确率 80%"，等于夸用户没做。
   `weeklyStats` 增加 planned/done/missed/completion；完成率 <50% 时红字提示。
   位置：`server/logic.mjs:278`、`viewReport`。
4. **同类错题不能聚成一堆看**
   考点树这轮补齐了（六科 129 条），但错题库只能按科目/状态筛。
   建议：`GET /api/questions/group?by=kp&subject=`；`#/bank` 加「按考点」切换；
   周报里「错得最多的考点」做成可点的链接。

### P2

5. **考试范围抽题**：新表 `exams(id,subject_id,name,date,kp_scope)`，
   `POST /api/exam/build` 复用 `buildSheet` 的分配逻辑，只换候选集（范围内 + 非 archived + 错得多优先）。
   这是"考前突击"唯一能帮上忙的功能。
6. **变式题不能判对错**：`variants.verdict` 列和 `PATCH /api/variants/:id` 都已存在，
   前端一次都没调用——README 说的"人工审核"在界面上不存在。
7. **归档是单向门**：`#/q/:id` 点「又错了」其实会打回 first，但没有入口提示；
   建议加「重新激活」按钮，并在 bulk 入库时做 stem 相似度查重。
8. **核对页字段太多**：20 道 × 6 字段 = 一百多个检查点。
   置信度 ≥85% 的字段默认折叠成只读一行 +「改」，只展开低置信的。
9. **方法论没有前端**：`methods` 表 + `/api/methods` 都在，`public/app.js` 零引用。
   `#/methods` 视图（或周报底部常驻卡）是"沉淀"阶段唯一的落点。
10. **错题库没有搜索框**：`S.bank.q` 是死变量，后端 `?q=` 早就支持了。

### P3

11. 历史周切换（`?week=` 后端已支持，前端不发）。
12. 离线暂存（IndexedDB 队列）——电脑没开时手机拍的照片会丢在相册里。
13. 家长只读视图 `#/parent`（不显示题干和错因）。

### 网页设计 skill 放在哪

`D:\oransky\Desktop\oransky\网页前端skill\SKILL.md`（438 行）。
**刻意没有放进 `~/.dsh/skills/`**：那里会每次对话自动加载，用户要求不要自动加载。
需要用时把内容贴给会话，或临时复制进 `~/.dsh/skills/`。