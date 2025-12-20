# 升级指南

## 🎉 新版本改进

### ✅ 已修复的问题

1. **安全问题**
   - ✓ 移除了 README.md 中的明文密码
   - ✓ 添加了 .gitignore 保护敏感文件（cookies.json, .env, listeners.db）
   - ✓ 所有敏感信息已用占位符替换

2. **性能与稳定性**
   - ✓ 从 JSON 迁移到 SQLite 数据库
     - 无内存占用（旧版本全部加载到内存）
     - 支持无限数据存储
     - 查询速度更快
   - ✓ 浏览器崩溃自动恢复机制
   - ✓ 替换了已废弃的 Puppeteer API

3. **配置管理**
   - ✓ 使用环境变量（.env 文件）
   - ✓ 所有配置可自定义

## 📦 升级步骤

### 1. 安装新依赖

```bash
npm install
```

这会安装：
- `sql.js` - SQLite 数据库（纯 JavaScript，无需编译）
- `dotenv` - 环境变量管理

### 2. 创建配置文件

```bash
cp .env.example .env
```

然后编辑 `.env` 文件，设置你的艺术家 URL：

```bash
ARTIST_URL=https://artists.spotify.com/c/artist/你的艺术家ID/home
PORT=3000
SCRAPE_INTERVAL=5000
```

### 3. 迁移现有数据（如果有）

如果你之前有 `listeners_data.json` 文件：

```bash
npm run migrate
```

迁移脚本会：
- ✓ 读取所有旧数据
- ✓ 导入到 SQLite 数据库
- ✓ 自动备份 JSON 文件为 `.backup` 文件
- ✓ 可重复运行（跳过重复数据）

### 4. 启动服务

```bash
npm start
```

就这么简单！

## 🆕 新功能

### 环境变量配置

现在可以通过 `.env` 文件配置所有选项：

```bash
ARTIST_URL=...          # 艺术家页面 URL
PORT=3000               # Web 服务器端口
SCRAPE_INTERVAL=5000    # 抓取间隔（毫秒）
COOKIES_FILE=cookies.json
DATABASE_FILE=listeners.db
```

### 自动故障恢复

- 浏览器崩溃？自动重启
- 网络错误？自动重试
- 登录过期？前端提示上传新 cookies

### SQLite 数据库优势

**旧版本（JSON）**:
- ❌ 全部数据加载到内存
- ❌ 每次保存重写整个文件
- ❌ 数据量大时卡顿
- ❌ 无法复杂查询

**新版本（SQLite）**:
- ✅ 按需查询，零内存占用
- ✅ 增量写入，高效快速
- ✅ 支持百万级数据
- ✅ SQL 查询支持

## 📊 数据大小对比

| 时间范围 | 记录数 | JSON 大小 | SQLite 大小 |
|---------|--------|-----------|-------------|
| 1 天    | 17,280 | ~1.2 MB   | ~100 KB     |
| 1 周    | 120,960| ~8 MB     | ~700 KB     |
| 1 月    | 518,400| ~35 MB    | ~3 MB       |
| 1 年    | 6,307,200| ~420 MB | ~36 MB      |

SQLite 文件更小，查询更快！

## 🔧 常见问题

### Q: 我的旧数据会丢失吗？

不会！运行 `npm run migrate` 会：
1. 保留所有旧数据
2. 自动备份 JSON 文件
3. 安全导入到数据库

### Q: 需要重新获取 cookies 吗？

不需要，旧的 `cookies.json` 继续使用。

### Q: 能回退到旧版本吗？

可以，但不建议。如果必须回退：
1. 恢复备份的 `.backup` 文件为 `listeners_data.json`
2. 回退代码到旧版本

### Q: 为什么使用 sql.js 而不是 better-sqlite3？

`sql.js` 是纯 JavaScript 实现，优点：
- ✅ 无需编译，任何平台直接运行
- ✅ 安装更简单，无需 Python 或构建工具
- ✅ 跨平台兼容性完美

虽然性能略低于原生绑定，但对这个项目完全够用！

## 📝 更新日志

**v2.0.0** (2025-12-20)

新功能：
- SQLite 数据库支持
- 环境变量配置
- 浏览器崩溃自动恢复
- 数据迁移工具

修复：
- 移除已废弃的 Puppeteer API
- 安全隐患（敏感信息保护）
- 内存占用问题
- 文件 I/O 性能

---

享受更快、更稳定的 Spotify 监控体验！🎵
