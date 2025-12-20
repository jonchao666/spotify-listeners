# 🚀 服务器部署指南

## 📋 前置要求

- Linux服务器（Ubuntu/CentOS/Debian等）
- Node.js 14+ 已安装
- Git 已安装
- PM2（推荐，用于进程管理）

---

## 🔧 首次部署

### 1. 克隆项目

```bash
cd ~
git clone https://github.com/jonchao666/spotify-listeners.git
cd spotify-listeners
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量

```bash
# 复制配置模板
cp .env.example .env

# 编辑配置文件
nano .env
# 或者用 vim .env
```

**修改以下配置项**：
```bash
ARTIST_URL=https://artists.spotify.com/c/artist/你的艺术家ID/home
PORT=3000
SCRAPE_INTERVAL=5000
```

### 4. 安装 Chromium 依赖（Linux无头环境必需）

**Ubuntu/Debian:**
```bash
sudo apt-get update
sudo apt-get install -y \
  ca-certificates \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libc6 \
  libcairo2 \
  libcups2 \
  libdbus-1-3 \
  libexpat1 \
  libfontconfig1 \
  libgbm1 \
  libgcc1 \
  libglib2.0-0 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libpango-1.0-0 \
  libpangocairo-1.0-0 \
  libstdc++6 \
  libx11-6 \
  libx11-xcb1 \
  libxcb1 \
  libxcomposite1 \
  libxcursor1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxi6 \
  libxrandr2 \
  libxrender1 \
  libxss1 \
  libxtst6 \
  lsb-release \
  wget \
  xdg-utils
```

**CentOS/RHEL:**
```bash
sudo yum install -y \
  alsa-lib \
  atk \
  cups-libs \
  gtk3 \
  libXcomposite \
  libXcursor \
  libXdamage \
  libXext \
  libXi \
  libXrandr \
  libXScrnSaver \
  libXtst \
  pango \
  xorg-x11-fonts-100dpi \
  xorg-x11-fonts-75dpi \
  xorg-x11-fonts-cyrillic \
  xorg-x11-fonts-misc \
  xorg-x11-fonts-Type1 \
  xorg-x11-utils
```

### 5. 上传 Cookies（两种方式）

#### 方式A：Web界面上传（推荐）

1. 先启动服务：
```bash
node index.js
```

2. 浏览器访问：`http://服务器IP:3000`

3. 点击页面上的"重新登录"按钮，选择"远程模式"

4. 在本地电脑浏览器登录 Spotify for Artists

5. 使用浏览器插件导出 Cookies：
   - Chrome: 安装 [EditThisCookie](https://chrome.google.com/webstore/detail/editthiscookie/fngmhnnpilhplaeedifhccceomclgfbg)
   - Firefox: 安装 [Cookie-Editor](https://addons.mozilla.org/zh-CN/firefox/addon/cookie-editor/)

6. 导出为 JSON 格式，粘贴到网页上传

7. 停止服务（Ctrl+C）准备用PM2启动

#### 方式B：手动上传文件

1. 在本地电脑运行 `login.js` 获取 cookies：
```bash
node login.js
```

2. 上传 `cookies.json` 到服务器：
```bash
scp cookies.json root@服务器IP:~/spotify-listeners/
```

### 6. 配置防火墙

```bash
# UFW (Ubuntu)
sudo ufw allow 3000/tcp

# Firewalld (CentOS)
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload

# 或者使用云服务商的安全组开放 3000 端口
```

### 7. 使用 PM2 启动服务（推荐）

```bash
# 安装 PM2
npm install -g pm2

# 启动应用
pm2 start index.js --name spotify-tracker

# 查看日志
pm2 logs spotify-tracker

# 保存配置
pm2 save

# 设置开机自启
pm2 startup
# 根据提示执行输出的命令（通常需要 sudo）
```

### 8. 验证运行

```bash
# 检查进程状态
pm2 status

# 查看日志
pm2 logs spotify-tracker --lines 50

# 访问 Web 界面
curl http://localhost:3000/api/status
```

浏览器访问：`http://服务器IP:3000`

---

## 🔄 更新代码

### 本地修改后推送

```bash
# 在本地项目目录
cd C:\Users\97046\Documents\Code\spotify-listeners-server

# 查看修改
git status

# 添加所有修改
git add .

# 提交修改（描述你的改动）
git commit -m "修复抓取逻辑"

# 推送到 GitHub
git push
```

### 服务器拉取更新

```bash
# 进入项目目录
cd ~/spotify-listeners

# 拉取最新代码
git pull

# 如果有新依赖，重新安装
npm install

# 重启服务
pm2 restart spotify-tracker

# 查看日志确认运行正常
pm2 logs spotify-tracker
```

---

## 🛠️ 常用维护命令

### PM2 进程管理

```bash
# 查看状态
pm2 status

# 查看日志
pm2 logs spotify-tracker

# 停止服务
pm2 stop spotify-tracker

# 重启服务
pm2 restart spotify-tracker

# 删除进程
pm2 delete spotify-tracker

# 查看详细信息
pm2 show spotify-tracker

# 监控资源占用
pm2 monit
```

### 数据库维护

```bash
# 查看数据库大小
ls -lh listeners.db

# 备份数据库
cp listeners.db listeners.db.backup-$(date +%Y%m%d)

# 导出 CSV（通过 API）
curl http://localhost:3000/api/download/csv > backup.csv
```

### 日志管理

```bash
# PM2 日志位置
~/.pm2/logs/

# 清理 PM2 日志
pm2 flush

# 查看实时日志
pm2 logs spotify-tracker --lines 100
```

---

## 🐛 常见问题

### 1. Puppeteer 无法启动浏览器

**症状**：报错 `Error: Failed to launch the browser process`

**解决**：
```bash
# 重新安装 Chromium 依赖（见上方"安装 Chromium 依赖"）

# 或手动指定 Chromium 路径
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
```

### 2. 登录过期

**症状**：页面显示"登录已过期，需要重新登录"

**解决**：
1. 访问 `http://服务器IP:3000`
2. 点击"重新登录"
3. 上传新的 Cookies

### 3. 端口被占用

**症状**：`Error: listen EADDRINUSE :::3000`

**解决**：
```bash
# 查找占用端口的进程
lsof -i :3000

# 或者
netstat -tulpn | grep 3000

# 修改 .env 中的 PORT 配置
nano .env
```

### 4. 数据库损坏

**症状**：数据无法保存或读取错误

**解决**：
```bash
# 停止服务
pm2 stop spotify-tracker

# 删除损坏的数据库（注意备份！）
mv listeners.db listeners.db.broken

# 重启服务（会自动创建新数据库）
pm2 start spotify-tracker
```

### 5. 内存占用过高

**症状**：浏览器进程占用大量内存

**解决**：
```bash
# 定时重启服务（每天凌晨4点）
crontab -e

# 添加以下行
0 4 * * * pm2 restart spotify-tracker
```

---

## 🔐 安全建议

1. **不要将敏感文件提交到 Git**
   - `.env` 已在 `.gitignore` 中
   - `cookies.json` 已在 `.gitignore` 中
   - `listeners.db` 已在 `.gitignore` 中

2. **使用反向代理（推荐）**

   安装 Nginx：
   ```bash
   sudo apt install nginx
   ```

   配置示例（`/etc/nginx/sites-available/spotify-tracker`）：
   ```nginx
   server {
       listen 80;
       server_name your-domain.com;

       location / {
           proxy_pass http://localhost:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```

3. **添加 HTTP 认证**（可选）

   在 Nginx 配置中添加：
   ```nginx
   auth_basic "Restricted Access";
   auth_basic_user_file /etc/nginx/.htpasswd;
   ```

4. **定期备份数据库**
   ```bash
   # 添加定时任务
   crontab -e

   # 每天凌晨3点备份
   0 3 * * * cp ~/spotify-listeners/listeners.db ~/backups/listeners-$(date +\%Y\%m\%d).db
   ```

---

## 📊 性能优化

### 调整抓取间隔

编辑 `.env`：
```bash
# 默认 5秒，可根据需要调整
SCRAPE_INTERVAL=5000
```

**注意**：
- 间隔太短可能触发 Spotify 反爬虫
- 建议范围：5000-30000 毫秒（5-30秒）

### 数据清理

如果数据库过大（几个月后），可以清理旧数据：

```bash
# 进入项目目录
cd ~/spotify-listeners

# 使用 Node.js 清理（保留最近30天）
node -e "
const Database = require('better-sqlite3');
const db = new Database('listeners.db');
db.exec(\"DELETE FROM listeners WHERE timestamp < datetime('now', '-30 days')\");
db.close();
"
```

---

## 🌐 域名配置

如果你有域名，可以配置反向代理：

1. **DNS 解析**：将域名指向服务器IP

2. **Nginx 配置**：
   ```bash
   sudo nano /etc/nginx/sites-available/spotify-tracker
   ```

3. **启用配置**：
   ```bash
   sudo ln -s /etc/nginx/sites-available/spotify-tracker /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl restart nginx
   ```

4. **SSL 证书（可选）**：
   ```bash
   sudo apt install certbot python3-certbot-nginx
   sudo certbot --nginx -d your-domain.com
   ```

---

## 📞 技术支持

- **GitHub Issues**: https://github.com/jonchao666/spotify-listeners/issues
- **项目文档**: 查看项目根目录的 `README.md` 和 `CLAUDE.md`

---

**最后更新**: 2024-12-20
