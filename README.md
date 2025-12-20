# Spotify Listeners Server

24/7 自动监控 Spotify for Artists 实时收听人数

## 部署步骤

### 1. 上传文件到服务器

在本地 PowerShell 中执行：
```powershell
scp -r "C:\path\to\spotify-listeners-server" root@YOUR_SERVER_IP:/root/
```

### 2. SSH 连接服务器

```bash
ssh root@YOUR_SERVER_IP
# 使用你的服务器密码登录
```

### 3. 安装 Node.js

```bash
# 安装 Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs

# 验证安装
node -v
npm -v
```

### 4. 安装 Puppeteer 依赖

```bash
# 安装 Chromium 依赖
apt-get update
apt-get install -y \
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

### 5. 安装项目依赖

```bash
cd /root/spotify-listeners-server
npm install
```

### 6. 获取 Cookies（重要！）

由于服务器是无界面的，你需要在**本地电脑**获取 cookies：

#### 方法 A：使用本地脚本
```powershell
# 在本地电脑执行
cd C:\Users\97046\Documents\Code\spotify-listeners-server
npm install
node login.js
```
登录后会生成 `cookies.json`，然后上传到服务器：
```powershell
scp cookies.json root@YOUR_SERVER_IP:/root/spotify-listeners-server/
```

#### 方法 B：从浏览器导出
1. 在 Chrome 中登录 https://artists.spotify.com/
2. 按 F12 打开开发者工具
3. 切换到 Application -> Cookies
4. 手动复制 cookies 到 JSON 文件

### 7. 启动服务

```bash
cd /root/spotify-listeners-server

# 前台运行（测试用）
node index.js

# 后台运行（推荐）
nohup node index.js > output.log 2>&1 &

# 查看日志
tail -f output.log
```

### 8. 开放防火墙端口

```bash
# 如果使用 ufw
ufw allow 3000

# 或者使用 iptables
iptables -A INPUT -p tcp --dport 3000 -j ACCEPT
```

### 9. 访问服务

浏览器打开: http://YOUR_SERVER_IP:3000

## API 接口

| 接口 | 说明 |
|-----|------|
| GET / | 状态页面 |
| GET /api/stats | 获取统计数据 |
| GET /api/data?limit=100 | 获取最近的数据 |
| GET /api/download/csv | 下载 CSV 文件 |

## 使用 PM2 守护进程（推荐）

```bash
# 安装 PM2
npm install -g pm2

# 启动服务
pm2 start index.js --name spotify-tracker

# 设置开机自启
pm2 startup
pm2 save

# 查看状态
pm2 status

# 查看日志
pm2 logs spotify-tracker
```

## 常见问题

### Q: 显示需要登录？
Cookies 可能过期了，重新获取 cookies 并上传。

### Q: 抓取不到数据？
检查 debug_screenshot.png 截图，看页面是否正常加载。

### Q: 服务器重启后怎么办？
使用 PM2 设置开机自启，或者添加到 systemd 服务。
