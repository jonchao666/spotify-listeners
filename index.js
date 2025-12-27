require('dotenv').config();
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const express = require('express');
const initSqlJs = require('sql.js');

// 配置
const CONFIG = {
  artistUrl: process.env.ARTIST_URL || 'https://artists.spotify.com/c/artist/41pwUFNGuwEl50hAQPV8ok/home',
  scrapeInterval: parseInt(process.env.SCRAPE_INTERVAL) || 5000,
  cookiesFile: process.env.COOKIES_FILE || 'cookies.json',
  databaseFile: process.env.DATABASE_FILE || 'listeners.db',
  port: parseInt(process.env.PORT) || 3000,
  // 邮件通知配置
  email: {
    enabled: process.env.EMAIL_ENABLED === 'true',
    provider: process.env.EMAIL_PROVIDER || 'resend', // 'resend' 或 'smtp'
    // Resend 配置
    resendApiKey: process.env.RESEND_API_KEY || '',
    // SMTP 配置 (备用)
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT) || 587,
    secure: process.env.EMAIL_SECURE === 'true',
    user: process.env.EMAIL_USER || '',
    pass: process.env.EMAIL_PASS || '',
    // 通用配置
    to: process.env.EMAIL_TO || '',
    from: process.env.EMAIL_FROM || 'Spotify Tracker <onboarding@resend.dev>',
    // 定时报告配置
    reports: {
      daily: process.env.EMAIL_REPORT_DAILY === 'true',   // 每日报告
      weekly: process.env.EMAIL_REPORT_WEEKLY === 'true', // 每周报告 (周一)
      monthly: process.env.EMAIL_REPORT_MONTHLY === 'true' // 每月报告 (1号)
    }
  }
};

// 数据存储
let db = null;
let browser = null;
let page = null;

// 数据库保存计数器（用于批量保存）
let insertCount = 0;
let scrapeCount = 0;

// 抓取状态（用于前端显示）
let scrapeStatus = {
  lastSuccess: null,
  lastError: null,
  errorMessage: null,
  needsLogin: false,
  consecutiveErrors: 0
};

// 邮件通知状态（避免频繁发送）
let lastEmailSent = null;
const EMAIL_COOLDOWN = 30 * 60 * 1000; // 30分钟冷却

// 生成邮件 HTML 内容
function generateEmailHtml(subject, message) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1DB954;">🎵 Spotify Listener Tracker</h2>
      <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <h3 style="margin-top: 0; color: #e74c3c;">⚠️ ${subject}</h3>
        <p style="color: #333;">${message}</p>
      </div>
      <div style="color: #888; font-size: 12px;">
        <p>时间: ${new Date().toISOString()}</p>
        <p>最后成功抓取: ${scrapeStatus.lastSuccess || '从未'}</p>
        <p>连续错误次数: ${scrapeStatus.consecutiveErrors}</p>
      </div>
      <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
      <p style="color: #888; font-size: 11px;">此邮件由 Spotify Listener Tracker 自动发送</p>
    </div>
  `;
}

// 使用 Resend 发送邮件
async function sendWithResend(subject, htmlContent) {
  let Resend;
  try {
    Resend = require('resend').Resend;
  } catch (e) {
    console.log('resend 未安装，运行 npm install resend 启用此功能');
    throw new Error('resend 包未安装');
  }

  console.log('Resend 配置:', {
    from: CONFIG.email.from,
    to: CONFIG.email.to,
    apiKeyPrefix: CONFIG.email.resendApiKey ? CONFIG.email.resendApiKey.substring(0, 10) + '...' : 'none'
  });

  const resend = new Resend(CONFIG.email.resendApiKey);
  const { data, error } = await resend.emails.send({
    from: CONFIG.email.from,
    to: [CONFIG.email.to], // Resend 需要数组格式
    subject: `[Spotify Tracker] ${subject}`,
    html: htmlContent
  });

  if (error) {
    console.error('Resend 错误:', error);
    throw new Error(error.message || JSON.stringify(error));
  }

  console.log('Resend 发送成功:', data);
  return true;
}

// 使用 SMTP 发送邮件
async function sendWithSmtp(subject, htmlContent) {
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (e) {
    console.log('nodemailer 未安装，运行 npm install nodemailer 启用此功能');
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: CONFIG.email.host,
    port: CONFIG.email.port,
    secure: CONFIG.email.secure,
    auth: {
      user: CONFIG.email.user,
      pass: CONFIG.email.pass
    }
  });

  await transporter.sendMail({
    from: CONFIG.email.from,
    to: CONFIG.email.to,
    subject: `[Spotify Tracker] ${subject}`,
    html: htmlContent
  });
  return true;
}

// 发送邮件通知 (返回 { success, error } 对象)
async function sendEmailNotification(subject, message, skipCooldown = false) {
  if (!CONFIG.email.enabled) {
    return { success: false, error: '邮件通知未启用' };
  }
  if (!CONFIG.email.to) {
    return { success: false, error: '未配置接收邮箱' };
  }

  // 验证必要配置
  const isResend = CONFIG.email.provider === 'resend';
  if (isResend && !CONFIG.email.resendApiKey) {
    return { success: false, error: 'Resend API Key 未配置' };
  }
  if (!isResend && !CONFIG.email.user) {
    return { success: false, error: 'SMTP 发件邮箱未配置' };
  }

  // 检查冷却时间 (测试邮件可跳过)
  if (!skipCooldown && lastEmailSent && (Date.now() - lastEmailSent) < EMAIL_COOLDOWN) {
    const remainingMin = Math.ceil((EMAIL_COOLDOWN - (Date.now() - lastEmailSent)) / 60000);
    return { success: false, error: `冷却中，${remainingMin}分钟后可再次发送` };
  }

  try {
    const htmlContent = generateEmailHtml(subject, message);

    if (isResend) {
      await sendWithResend(subject, htmlContent);
    } else {
      await sendWithSmtp(subject, htmlContent);
    }

    lastEmailSent = Date.now();
    console.log(`邮件通知已发送 (${CONFIG.email.provider}):`, subject);
    return { success: true };
  } catch (e) {
    console.error('发送邮件失败:', e.message);
    return { success: false, error: e.message };
  }
}

// ========== 定时统计报告 ==========

// 获取指定时间段的统计数据
function getStatsForPeriod(startDate, endDate) {
  if (!db) return null;

  try {
    const result = db.exec(`
      SELECT
        AVG(listener_count) as avgCount,
        MAX(listener_count) as maxCount,
        MIN(listener_count) as minCount,
        COUNT(*) as samples
      FROM listeners
      WHERE timestamp >= ? AND timestamp < ?
    `, [startDate, endDate]);

    if (result.length === 0 || result[0].values.length === 0) {
      return null;
    }

    const row = result[0].values[0];
    const calibrationFactor = getCalibrationFactor();
    return {
      avgCount: Math.round(row[0] * 10) / 10,
      maxCount: row[1],
      minCount: row[2],
      samples: row[3],
      predictedStreams: Math.round(row[0] * calibrationFactor)
    };
  } catch (e) {
    console.error('获取统计数据失败:', e.message);
    return null;
  }
}

// 获取校准系数 (从真实播放量数据计算)
function getCalibrationFactor() {
  if (!db) return 480; // 默认值: 24*60/3

  try {
    // 获取有真实播放量的日期
    const actualResult = db.exec('SELECT date, streams FROM actual_streams');
    if (actualResult.length === 0 || actualResult[0].values.length === 0) {
      return 480; // 无数据时使用默认值
    }

    const actualData = {};
    actualResult[0].values.forEach(row => {
      actualData[row[0]] = row[1];
    });

    // 获取对应日期的平均听众数
    const dates = Object.keys(actualData);
    let totalFactor = 0;
    let validSamples = 0;

    dates.forEach(date => {
      const listenerResult = db.exec(`
        SELECT AVG(listener_count) as avgCount
        FROM listeners
        WHERE DATE(timestamp) = ?
      `, [date]);

      if (listenerResult.length > 0 && listenerResult[0].values.length > 0 && listenerResult[0].values[0][0]) {
        const avgListeners = listenerResult[0].values[0][0];
        const actualStreams = actualData[date];
        // 计算系数: 真实播放量 / 平均听众
        const factor = actualStreams / avgListeners;
        totalFactor += factor;
        validSamples++;
      }
    });

    if (validSamples === 0) {
      return 480; // 无有效样本时使用默认值
    }

    return totalFactor / validSamples;
  } catch (e) {
    console.error('获取校准系数失败:', e.message);
    return 480;
  }
}

// 生成统计报告 HTML
function generateReportHtml(title, periodLabel, stats, comparison = null) {
  const formatNum = n => n ? n.toLocaleString() : '0';

  let comparisonHtml = '';
  if (comparison) {
    const avgDiff = stats.avgCount - comparison.avgCount;
    const avgPercent = comparison.avgCount ? ((avgDiff / comparison.avgCount) * 100).toFixed(1) : 0;
    const trend = avgDiff >= 0 ? '📈' : '📉';
    const color = avgDiff >= 0 ? '#1DB954' : '#e74c3c';

    comparisonHtml = `
      <div style="background: #f0f0f0; padding: 15px; border-radius: 8px; margin-top: 15px;">
        <h4 style="margin: 0 0 10px 0; color: #666;">对比上期</h4>
        <p style="margin: 5px 0; color: ${color}; font-size: 16px;">
          ${trend} 平均听众 ${avgDiff >= 0 ? '+' : ''}${formatNum(Math.round(avgDiff * 10) / 10)} (${avgDiff >= 0 ? '+' : ''}${avgPercent}%)
        </p>
      </div>
    `;
  }

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1DB954; margin-bottom: 5px;">🎵 ${title}</h2>
      <p style="color: #888; margin-top: 0; font-size: 14px;">${periodLabel}</p>

      <div style="background: #1DB954; color: white; padding: 25px; border-radius: 12px; text-align: center; margin: 20px 0;">
        <div style="font-size: 14px; opacity: 0.9;">平均听众</div>
        <div style="font-size: 42px; font-weight: bold;">${formatNum(stats.avgCount)}</div>
      </div>

      <div style="display: flex; gap: 15px; margin: 20px 0;">
        <div style="flex: 1; background: #f5f5f5; padding: 15px; border-radius: 8px; text-align: center;">
          <div style="color: #888; font-size: 12px;">峰值</div>
          <div style="color: #1DB954; font-size: 24px; font-weight: bold;">${formatNum(stats.maxCount)}</div>
        </div>
        <div style="flex: 1; background: #f5f5f5; padding: 15px; border-radius: 8px; text-align: center;">
          <div style="color: #888; font-size: 12px;">最低</div>
          <div style="color: #333; font-size: 24px; font-weight: bold;">${formatNum(stats.minCount)}</div>
        </div>
        <div style="flex: 1; background: #f5f5f5; padding: 15px; border-radius: 8px; text-align: center;">
          <div style="color: #888; font-size: 12px;">预测播放</div>
          <div style="color: #333; font-size: 24px; font-weight: bold;">${formatNum(stats.predictedStreams)}</div>
        </div>
      </div>

      ${comparisonHtml}

      <hr style="border: none; border-top: 1px solid #ddd; margin: 25px 0;">
      <p style="color: #888; font-size: 11px; text-align: center;">
        此报告由 Spotify Listener Tracker 自动发送<br>
        数据采样点: ${formatNum(stats.samples)} | 生成时间: ${new Date().toISOString()}
      </p>
    </div>
  `;
}

// 发送定时报告
async function sendScheduledReport(type) {
  if (!CONFIG.email.enabled || !CONFIG.email.to) {
    return;
  }

  const now = new Date();
  let title, periodLabel, startDate, endDate, prevStartDate, prevEndDate;

  if (type === 'daily') {
    // 昨天的数据
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    startDate = yesterday.toISOString().split('T')[0] + 'T00:00:00Z';
    endDate = now.toISOString().split('T')[0] + 'T00:00:00Z';

    const dayBefore = new Date(yesterday);
    dayBefore.setDate(dayBefore.getDate() - 1);
    prevStartDate = dayBefore.toISOString().split('T')[0] + 'T00:00:00Z';
    prevEndDate = startDate;

    title = '每日数据报告';
    periodLabel = `${yesterday.toISOString().split('T')[0]} (UTC)`;

  } else if (type === 'weekly') {
    // 上周的数据 (周一到周日)
    const lastMonday = new Date(now);
    lastMonday.setDate(lastMonday.getDate() - lastMonday.getDay() - 6);
    const lastSunday = new Date(lastMonday);
    lastSunday.setDate(lastSunday.getDate() + 7);

    startDate = lastMonday.toISOString().split('T')[0] + 'T00:00:00Z';
    endDate = lastSunday.toISOString().split('T')[0] + 'T00:00:00Z';

    const prevMonday = new Date(lastMonday);
    prevMonday.setDate(prevMonday.getDate() - 7);
    prevStartDate = prevMonday.toISOString().split('T')[0] + 'T00:00:00Z';
    prevEndDate = startDate;

    title = '每周数据报告';
    periodLabel = `${lastMonday.toISOString().split('T')[0]} ~ ${new Date(lastSunday.getTime() - 86400000).toISOString().split('T')[0]}`;

  } else if (type === 'monthly') {
    // 上个月的数据
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    startDate = lastMonth.toISOString().split('T')[0] + 'T00:00:00Z';
    endDate = thisMonth.toISOString().split('T')[0] + 'T00:00:00Z';

    const prevMonth = new Date(lastMonth);
    prevMonth.setMonth(prevMonth.getMonth() - 1);
    prevStartDate = prevMonth.toISOString().split('T')[0] + 'T00:00:00Z';
    prevEndDate = startDate;

    title = '每月数据报告';
    const monthNames = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
    periodLabel = `${lastMonth.getFullYear()}年${monthNames[lastMonth.getMonth()]}`;
  }

  const stats = getStatsForPeriod(startDate, endDate);
  if (!stats || stats.samples === 0) {
    console.log(`${type} 报告: 没有数据，跳过发送`);
    return;
  }

  const comparison = getStatsForPeriod(prevStartDate, prevEndDate);
  const htmlContent = generateReportHtml(title, periodLabel, stats, comparison);

  try {
    if (CONFIG.email.provider === 'resend') {
      await sendWithResend(title, htmlContent);
    } else {
      await sendWithSmtp(title, htmlContent);
    }
    console.log(`${type} 报告已发送`);
  } catch (e) {
    console.error(`${type} 报告发送失败:`, e.message);
  }
}

// 报告调度器状态
let lastReportCheck = null;

// 检查并发送定时报告
function checkAndSendReports() {
  if (!CONFIG.email.enabled || !CONFIG.email.reports) {
    return;
  }

  const now = new Date();
  const hour = now.getUTCHours();
  const dayOfWeek = now.getUTCDay(); // 0=周日, 1=周一
  const dayOfMonth = now.getUTCDate();
  const today = now.toISOString().split('T')[0];

  // 防止同一天重复发送
  if (lastReportCheck === today) {
    return;
  }

  // 只在 UTC 0:00-0:59 之间检查
  if (hour !== 0) {
    return;
  }

  console.log('检查定时报告...');
  lastReportCheck = today;

  // 每日报告
  if (CONFIG.email.reports.daily) {
    sendScheduledReport('daily');
  }

  // 每周报告 (周一)
  if (CONFIG.email.reports.weekly && dayOfWeek === 1) {
    sendScheduledReport('weekly');
  }

  // 每月报告 (1号)
  if (CONFIG.email.reports.monthly && dayOfMonth === 1) {
    sendScheduledReport('monthly');
  }
}

// 初始化数据库
async function initDatabase() {
  try {
    const SQL = await initSqlJs();

    // 如果数据库文件存在，加载它
    if (fs.existsSync(CONFIG.databaseFile)) {
      const buffer = fs.readFileSync(CONFIG.databaseFile);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }

    // 创建表
    db.run(`
      CREATE TABLE IF NOT EXISTS listeners (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        listener_count INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run('CREATE INDEX IF NOT EXISTS idx_timestamp ON listeners(timestamp)');

    // 创建真实播放量表
    db.run(`
      CREATE TABLE IF NOT EXISTS actual_streams (
        date TEXT PRIMARY KEY,
        streams INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const result = db.exec('SELECT COUNT(*) as count FROM listeners');
    const count = result.length > 0 ? result[0].values[0][0] : 0;
    console.log(`数据库已初始化，当前有 ${count} 条历史记录`);

    return db;
  } catch (e) {
    console.error('初始化数据库失败:', e.message);
    process.exit(1);
  }
}

// 保存数据库到文件
function saveDatabaseToFile() {
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(CONFIG.databaseFile, buffer);
  } catch (e) {
    console.error('保存数据库失败:', e.message);
  }
}

// 保存数据到数据库（优化版：批量保存）
function saveData(timestamp, listenerCount) {
  try {
    db.run('INSERT INTO listeners (timestamp, listener_count) VALUES (?, ?)', [timestamp, listenerCount]);

    insertCount++;

    // ✅ 每 12 次插入（约1分钟）保存一次到文件，大幅减少磁盘IO
    if (insertCount >= 12) {
      saveDatabaseToFile();
      console.log(`数据库已保存到文件 (批次: ${insertCount} 条记录)`);
      insertCount = 0;
    }
  } catch (e) {
    console.error('保存数据失败:', e.message);
  }
}

// 获取统计数据
function getStats() {
  try {
    const statsResult = db.exec(`
      SELECT
        COUNT(*) as totalRecords,
        MAX(listener_count) as maxCount,
        MIN(listener_count) as minCount,
        AVG(listener_count) as avgCount
      FROM listeners
    `);

    const latestResult = db.exec('SELECT timestamp, listener_count FROM listeners ORDER BY id DESC LIMIT 1');

    if (statsResult.length === 0) {
      return { totalRecords: 0 };
    }

    const stats = statsResult[0].values[0];
    const latest = latestResult.length > 0 ? latestResult[0].values[0] : null;

    return {
      totalRecords: stats[0],
      maxCount: stats[1],
      minCount: stats[2],
      avgCount: Math.round(stats[3]),
      latestCount: latest ? latest[1] : 0,
      latestTime: latest ? latest[0] : null
    };
  } catch (e) {
    console.error('获取统计数据失败:', e.message);
    return { totalRecords: 0 };
  }
}

// 获取数据列表
function getData(limit = 1000) {
  try {
    const result = db.exec('SELECT timestamp, listener_count FROM listeners ORDER BY id DESC LIMIT ?', [limit]);

    if (result.length === 0) return [];

    const rows = result[0].values.map(row => ({
      timestamp: row[0],
      listenerCount: row[1]
    }));

    return rows.reverse(); // 按时间正序返回
  } catch (e) {
    console.error('获取数据列表失败:', e.message);
    return [];
  }
}

// 获取所有数据用于导出
function getAllData() {
  try {
    const result = db.exec('SELECT timestamp, listener_count FROM listeners ORDER BY id ASC');

    if (result.length === 0) return [];

    return result[0].values.map(row => ({
      timestamp: row[0],
      listenerCount: row[1]
    }));
  } catch (e) {
    console.error('获取所有数据失败:', e.message);
    return [];
  }
}

// 加载 Cookies
async function loadCookies(page) {
  try {
    if (fs.existsSync(CONFIG.cookiesFile)) {
      const cookies = JSON.parse(fs.readFileSync(CONFIG.cookiesFile, 'utf8'));
      await page.setCookie(...cookies);
      console.log('Cookies 已加载');
      return true;
    }
  } catch (e) {
    console.error('加载 Cookies 失败:', e.message);
  }
  return false;
}

// 保存 Cookies
async function saveCookies(page) {
  try {
    const cookies = await page.cookies();
    fs.writeFileSync(CONFIG.cookiesFile, JSON.stringify(cookies, null, 2));
    console.log('Cookies 已保存');
  } catch (e) {
    console.error('保存 Cookies 失败:', e.message);
  }
}

// 初始化浏览器
async function initBrowser() {
  console.log('启动浏览器...');
  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // 尝试加载 cookies
  await loadCookies(page);

  return { browser, page };
}

// 页面是否已加载标志
let pageLoaded = false;

// 加载或重新加载页面
async function loadPage() {
  try {
    console.log('正在加载艺术中心首页...');
    await page.goto(CONFIG.artistUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // 检查是否需要登录
    const currentUrl = page.url();
    if (currentUrl.includes('accounts.spotify.com') || currentUrl.includes('login')) {
      console.log('检测到登录页面，需要登录');
      scrapeStatus.needsLogin = true;
      scrapeStatus.errorMessage = '登录已过期，需要重新登录';
      scrapeStatus.lastError = new Date().toISOString();
      scrapeStatus.consecutiveErrors++;
      pageLoaded = false;

      // 发送邮件通知
      sendEmailNotification(
        '登录已过期',
        '您的 Spotify for Artists 登录已过期，需要重新上传 Cookies 或重新登录。请访问仪表盘进行处理。'
      );

      return false;
    }

    // 等待页面加载（增加等待时间，确保动态内容加载完成）
    await new Promise(resolve => setTimeout(resolve, 8000));

    // 等待收听数据出现
    try {
      await page.waitForFunction(() => {
        const text = document.body.innerText;
        return /\d+\s*people\s*listening/i.test(text) || /listening/i.test(text);
      }, { timeout: 15000 });
    } catch (e) {
      console.log('等待数据超时，继续尝试...');
    }

    pageLoaded = true;
    console.log('页面加载成功');

    // 页面加载成功后保存一次 cookies(确保登录后的 session 被保存)
    await saveCookies(page);

    return true;
  } catch (error) {
    console.error('页面加载失败:', error.message);
    pageLoaded = false;
    return false;
  }
}

// 抓取收听人数（优化版：不重复刷新页面）
async function scrapeListeners() {
  if (!page) {
    console.error('页面未初始化');
    scrapeStatus.errorMessage = '浏览器未初始化';
    scrapeStatus.lastError = new Date().toISOString();
    return null;
  }

  try {
    // 如果页面未加载或连续失败超过10次，重新加载页面(提高容错,避免频繁重新加载丢失 session)
    if (!pageLoaded || scrapeStatus.consecutiveErrors >= 10) {
      const loaded = await loadPage();
      if (!loaded) {
        return null;
      }
      // 重置错误计数
      scrapeStatus.consecutiveErrors = 0;
    }

    scrapeStatus.needsLogin = false;

    // 直接抓取收听人数（不刷新页面）
    const result = await page.evaluate(() => {
      const allElements = document.querySelectorAll('span, div, p, h1, h2, h3, strong, b');

      // 严格匹配固定格式："X person/people listening now"
      const patterns = [
        /([\d,]+)\s*people\s*listening\s*now/i,      // "5 people listening now"
        /([\d,]+)\s*person\s*listening\s*now/i,      // "1 person listening now"
      ];

      for (const el of allElements) {
        const text = el.textContent.trim();

        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (match) {
            return {
              count: parseInt(match[1].replace(/,/g, ''), 10),
              text: text,
              element: el.tagName
            };
          }
        }
      }

      // 如果找不到，返回页面文本片段用于调试
      return {
        count: null,
        debugText: document.body.innerText.substring(0, 500)
      };
    });

    if (result && result.count !== null) {
      const timestamp = new Date().toISOString();
      saveData(timestamp, result.count);
      console.log(`抓取成功: ${result.count} (元素: ${result.element || 'unknown'})`);

      // 更新状态
      scrapeStatus.lastSuccess = timestamp;
      scrapeStatus.errorMessage = null;
      scrapeStatus.consecutiveErrors = 0;

      // ⚠️ 不再频繁保存 cookies,避免覆盖长期 session
      // 只在登录时保存一次即可,后续抓取不再保存
      // scrapeCount++;
      // if (scrapeCount >= 10) {
      //   await saveCookies(page);
      //   scrapeCount = 0;
      // }

      return result.count;
    } else {
      // 抓取失败 - 输出调试信息
      console.log('未找到收听人数数据');

      // 每3次失败输出一次页面内容用于调试
      if (scrapeStatus.consecutiveErrors % 3 === 0 && result?.debugText) {
        console.log('=== 页面内容片段（调试）===');
        console.log(result.debugText);
        console.log('=== 调试信息结束 ===');
      }

      scrapeStatus.errorMessage = '页面已加载但未找到收听人数数据';
      scrapeStatus.lastError = new Date().toISOString();
      scrapeStatus.consecutiveErrors++;
      return null;
    }

  } catch (error) {
    console.error('抓取失败:', error.message);
    scrapeStatus.errorMessage = error.message;
    scrapeStatus.lastError = new Date().toISOString();
    scrapeStatus.consecutiveErrors++;
    // 抓取失败时标记页面需要重新加载
    pageLoaded = false;
    return null;
  }
}

// 启动 API 服务
function startServer() {
  const app = express();

  // 全局中间件
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // 获取统计数据
  app.get('/api/stats', (req, res) => {
    res.json(getStats());
  });

  // 获取所有数据
  app.get('/api/data', (req, res) => {
    const limit = parseInt(req.query.limit) || 1000;
    const data = getData(limit);
    res.json(data);
  });

  // 获取抓取状态
  app.get('/api/status', (req, res) => {
    const stats = getStats();
    res.json({
      ...scrapeStatus,
      isRunning: !!page,
      dataCount: stats.totalRecords,
      lastDataTime: stats.latestTime
    });
  });

  // 触发重新登录（打开浏览器窗口）
  app.post('/api/login', async (req, res) => {
    try {
      // 关闭现有浏览器
      if (browser) {
        await browser.close();
      }
      
      // 重新启动可见浏览器进行登录
      console.log('启动可见浏览器进行登录...');
      browser = await puppeteer.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      
      page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto('https://accounts.spotify.com/login');
      
      res.json({ 
        success: true, 
        message: '浏览器已打开，请在浏览器中登录 Spotify。登录成功后会自动保存 cookies。'
      });
      
      // 等待用户登录（最多5分钟）
      let loggedIn = false;
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const url = page.url();
        if (url.includes('artists.spotify.com') || url.includes('/home')) {
          loggedIn = true;
          break;
        }
      }
      
      if (loggedIn) {
        await saveCookies(page);
        console.log('登录成功，cookies 已保存');
        scrapeStatus.needsLogin = false;
        scrapeStatus.errorMessage = null;
        
        // 切换回无头模式
        await browser.close();
        await initBrowser();
      }
      
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // 保存上传的 cookies
  app.post('/api/cookies', express.json(), (req, res) => {
    try {
      const cookies = req.body;
      if (Array.isArray(cookies) && cookies.length > 0) {
        fs.writeFileSync(CONFIG.cookiesFile, JSON.stringify(cookies, null, 2));
        scrapeStatus.needsLogin = false;
        scrapeStatus.errorMessage = null;
        res.json({ success: true, message: 'Cookies 已保存，将在下次抓取时使用' });
        
        // 重新加载 cookies
        loadCookies(page).then(() => {
          console.log('新 cookies 已加载');
        });
      } else {
        res.status(400).json({ success: false, message: '无效的 cookies 格式' });
      }
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // 下载 CSV
  app.get('/api/download/csv', (req, res) => {
    const data = getAllData();
    const headers = 'timestamp,listenerCount\n';
    const rows = data.map(d => `${d.timestamp},${d.listenerCount}`).join('\n');
    const csv = headers + rows;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=spotify-listeners-${new Date().toISOString().split('T')[0]}.csv`);
    res.send(csv);
  });

  // 清空数据库
  app.post('/api/clear-data', (req, res) => {
    try {
      const countResult = db.exec('SELECT COUNT(*) as count FROM listeners');
      const recordCount = countResult.length > 0 ? countResult[0].values[0][0] : 0;

      // 删除所有数据
      db.run('DELETE FROM listeners');

      // 重置自增ID
      db.run('DELETE FROM sqlite_sequence WHERE name="listeners"');

      // 保存到文件
      saveDatabaseToFile();

      console.log(`数据库已清空，删除了 ${recordCount} 条记录`);

      res.json({
        success: true,
        message: `成功清空 ${recordCount} 条记录`,
        deletedCount: recordCount
      });
    } catch (error) {
      console.error('清空数据库失败:', error.message);
      res.status(500).json({
        success: false,
        message: '清空数据库失败: ' + error.message
      });
    }
  });

  // ===== 高级分析 API =====

  // 时段分析（按小时统计平均值）
  app.get('/api/analytics/hourly', (req, res) => {
    try {
      const result = db.exec(`
        SELECT
          CAST(strftime('%H', timestamp) AS INTEGER) as hour,
          AVG(listener_count) as avgCount,
          MAX(listener_count) as maxCount,
          MIN(listener_count) as minCount,
          COUNT(*) as samples
        FROM listeners
        GROUP BY hour
        ORDER BY hour
      `);

      if (result.length === 0) {
        return res.json([]);
      }

      const hourlyData = result[0].values.map(row => ({
        hour: row[0],
        avgCount: Math.round(row[1]),
        maxCount: row[2],
        minCount: row[3],
        samples: row[4]
      }));

      res.json(hourlyData);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 曲线对比数据 - 获取指定日期的24小时数据
  app.get('/api/analytics/curve', (req, res) => {
    try {
      const { type } = req.query; // 'today', 'yesterday', 'last7days'

      const now = new Date();
      const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

      let startDate, endDate, label;

      if (type === 'today') {
        startDate = todayStart.toISOString();
        endDate = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000).toISOString();
        label = '今天';
      } else if (type === 'yesterday') {
        startDate = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000).toISOString();
        endDate = todayStart.toISOString();
        label = '昨天';
      } else if (type === 'last7days') {
        startDate = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        endDate = todayStart.toISOString();
        label = '近7天';
      } else if (type === 'thisWeek') {
        // 本周（周一到今天）
        const dayOfWeek = now.getUTCDay();
        const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        startDate = new Date(todayStart.getTime() - daysFromMonday * 24 * 60 * 60 * 1000).toISOString();
        endDate = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000).toISOString();
        label = '本周';
      } else if (type === 'lastWeek') {
        // 上周（周一到周日）
        const dayOfWeek = now.getUTCDay();
        const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        const thisWeekMonday = new Date(todayStart.getTime() - daysFromMonday * 24 * 60 * 60 * 1000);
        startDate = new Date(thisWeekMonday.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        endDate = thisWeekMonday.toISOString();
        label = '上周';
      } else if (type === 'last28days') {
        startDate = new Date(todayStart.getTime() - 28 * 24 * 60 * 60 * 1000).toISOString();
        endDate = todayStart.toISOString();
        label = '近28天';
      } else if (type === 'thisMonth') {
        // 本月（1号到今天）
        startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
        endDate = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000).toISOString();
        label = '本月';
      } else if (type === 'lastMonth') {
        // 上月
        startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString();
        endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
        label = '上月';
      } else if (type === 'lastYear') {
        startDate = new Date(todayStart.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
        endDate = todayStart.toISOString();
        label = '近一年';
      } else if (type === 'thisYear') {
        // 今年（1月1日到今天）
        startDate = new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString();
        endDate = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000).toISOString();
        label = '今年';
      } else if (type === 'all') {
        startDate = '1970-01-01T00:00:00Z';
        endDate = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000).toISOString();
        label = '全部';
      } else {
        return res.status(400).json({ error: '无效的类型参数' });
      }

      // 查询小时级数据
      const result = db.exec(`
        SELECT
          CAST(strftime('%H', timestamp) AS INTEGER) as hour,
          AVG(listener_count) as avgCount
        FROM listeners
        WHERE timestamp >= ? AND timestamp < ?
        GROUP BY hour
        ORDER BY hour
      `, [startDate, endDate]);

      // 查询整体平均值
      const avgResult = db.exec(`
        SELECT AVG(listener_count) as overallAvg
        FROM listeners
        WHERE timestamp >= ? AND timestamp < ?
      `, [startDate, endDate]);

      const overallAvg = avgResult.length > 0 && avgResult[0].values.length > 0 && avgResult[0].values[0][0] !== null
        ? Math.round(avgResult[0].values[0][0] * 10) / 10
        : null;

      // 生成完整的24小时数据（填充缺失小时为null）
      const hourlyMap = {};
      if (result.length > 0) {
        result[0].values.forEach(row => {
          hourlyMap[row[0]] = Math.round(row[1] * 10) / 10;
        });
      }

      // 获取当前小时（用于判断是否排除未完成的小时）
      const currentHour = now.getUTCHours();

      const data = [];
      for (let h = 0; h < 24; h++) {
        // 如果是今天/本周/本月/今年等包含当天的类型，排除当前未完成的小时
        const isIncludingToday = ['today', 'thisWeek', 'thisMonth', 'thisYear', 'all'].includes(type);
        const isCurrentHour = isIncludingToday && h === currentHour;

        data.push({
          hour: h,
          value: isCurrentHour ? null : (hourlyMap[h] !== undefined ? hourlyMap[h] : null)
        });
      }

      res.json({ type, label, data, average: overallAvg });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 趋势分析（最近 N 小时的增长率）
  app.get('/api/analytics/trend', (req, res) => {
    try {
      const hours = parseInt(req.query.hours) || 1;
      const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

      const result = db.exec(`
        SELECT AVG(listener_count) as avgCount
        FROM listeners
        WHERE timestamp >= ?
      `, [cutoff]);

      const recentAvg = result.length > 0 && result[0].values.length > 0
        ? result[0].values[0][0]
        : 0;

      const previousCutoff = new Date(Date.now() - hours * 2 * 60 * 60 * 1000).toISOString();
      const previousResult = db.exec(`
        SELECT AVG(listener_count) as avgCount
        FROM listeners
        WHERE timestamp >= ? AND timestamp < ?
      `, [previousCutoff, cutoff]);

      const previousAvg = previousResult.length > 0 && previousResult[0].values.length > 0
        ? previousResult[0].values[0][0]
        : 0;

      const trendPercent = previousAvg > 0
        ? ((recentAvg - previousAvg) / previousAvg * 100).toFixed(2)
        : 0;

      res.json({
        recentAvg: Math.round(recentAvg),
        previousAvg: Math.round(previousAvg),
        trendPercent: parseFloat(trendPercent),
        direction: trendPercent > 5 ? 'up' : trendPercent < -5 ? 'down' : 'stable',
        hours: hours
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 峰值分析（找出历史峰值时刻）
  app.get('/api/analytics/peaks', (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;

      const result = db.exec(`
        SELECT timestamp, listener_count,
               strftime('%w', timestamp) as dayOfWeek,
               strftime('%H', timestamp) as hour
        FROM listeners
        ORDER BY listener_count DESC
        LIMIT ?
      `, [limit]);

      if (result.length === 0) {
        return res.json([]);
      }

      const peaks = result[0].values.map(row => ({
        timestamp: row[0],
        listenerCount: row[1],
        dayOfWeek: parseInt(row[2]),
        hour: parseInt(row[3]),
        date: new Date(row[0]).toLocaleString('zh-CN')
      }));

      res.json(peaks);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 日对比分析
  app.get('/api/analytics/daily-comparison', (req, res) => {
    try {
      const result = db.exec(`
        SELECT
          DATE(timestamp) as date,
          AVG(listener_count) as avgCount,
          MAX(listener_count) as maxCount,
          MIN(listener_count) as minCount,
          COUNT(*) as samples
        FROM listeners
        WHERE timestamp >= datetime('now', '-7 days')
        GROUP BY date
        ORDER BY date DESC
      `);

      if (result.length === 0) {
        return res.json([]);
      }

      const dailyData = result[0].values.map(row => ({
        date: row[0],
        avgCount: Math.round(row[1] * 10) / 10, // 保留一位小数
        maxCount: row[2],
        minCount: row[3],
        samples: row[4]
      }));

      res.json(dailyData);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 每日汇总数据 (用于历史日报表格)
  app.get('/api/analytics/daily', (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 30;
      const offset = parseInt(req.query.offset) || 0;

      // 获取校准系数
      const calibrationFactor = getCalibrationFactor();

      const result = db.exec(`
        SELECT
          DATE(timestamp) as date,
          AVG(listener_count) as avgCount,
          MAX(listener_count) as maxCount,
          MIN(listener_count) as minCount,
          COUNT(*) as samples
        FROM listeners
        GROUP BY date
        ORDER BY date DESC
        LIMIT ? OFFSET ?
      `, [limit, offset]);

      if (result.length === 0) {
        return res.json({ data: [], hasMore: false });
      }

      const dailyData = result[0].values.map(row => ({
        date: row[0],
        avgCount: Math.round(row[1] * 10) / 10, // 保留一位小数
        maxCount: row[2],
        minCount: row[3],
        samples: row[4],
        // 预测播放量: 使用校准系数
        predictedStreams: Math.round(row[1] * calibrationFactor)
      }));

      // 检查是否还有更多数据
      const countResult = db.exec('SELECT COUNT(DISTINCT DATE(timestamp)) as total FROM listeners');
      const totalDays = countResult.length > 0 ? countResult[0].values[0][0] : 0;
      const hasMore = (offset + limit) < totalDays;

      res.json({ data: dailyData, hasMore, total: totalDays });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========== 真实播放量管理 ==========

  // 获取所有真实播放量记录
  app.get('/api/actual-streams', (req, res) => {
    try {
      const result = db.exec('SELECT date, streams FROM actual_streams ORDER BY date DESC');
      if (result.length === 0) {
        return res.json([]);
      }
      const data = result[0].values.map(row => ({
        date: row[0],
        streams: row[1]
      }));
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 添加/更新真实播放量
  app.post('/api/actual-streams', express.json(), (req, res) => {
    try {
      const { date, streams } = req.body;
      if (!date || streams === undefined) {
        return res.status(400).json({ error: '日期和播放量必填' });
      }

      // 使用 REPLACE 来实现 upsert
      db.run('REPLACE INTO actual_streams (date, streams, created_at) VALUES (?, ?, datetime("now"))', [date, parseInt(streams)]);
      saveDatabaseToFile();

      res.json({ success: true, date, streams: parseInt(streams) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 删除真实播放量记录
  app.delete('/api/actual-streams/:date', (req, res) => {
    try {
      const { date } = req.params;
      db.run('DELETE FROM actual_streams WHERE date = ?', [date]);
      saveDatabaseToFile();
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 获取预测校准系数
  app.get('/api/prediction-factor', (req, res) => {
    try {
      // 获取有真实播放量的日期
      const actualResult = db.exec('SELECT date, streams FROM actual_streams');
      if (actualResult.length === 0 || actualResult[0].values.length === 0) {
        return res.json({ factor: null, samples: 0, message: '暂无真实播放量数据' });
      }

      const factor = getCalibrationFactor();
      const samples = actualResult[0].values.length;

      res.json({
        factor: Math.round(factor * 100) / 100, // 保留2位小数
        samples: samples,
        message: `基于 ${samples} 天数据计算`
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 今日预测 API（基于历史同时段对比）
  app.get('/api/prediction', (req, res) => {
    try {
      const now = new Date();
      const currentHour = now.getUTCHours();
      const todayDateStr = now.toISOString().split('T')[0];

      // 如果是凌晨0点，数据太少无法预测
      if (currentHour === 0) {
        return res.json({
          available: false,
          message: '当前时段数据不足，无法预测'
        });
      }

      // 1. 获取今天 0:00 到当前小时的平均听众数
      const todayResult = db.exec(`
        SELECT AVG(listener_count) as avg, COUNT(*) as samples
        FROM listeners
        WHERE DATE(timestamp) = ?
          AND CAST(strftime('%H', timestamp) AS INTEGER) < ?
      `, [todayDateStr, currentHour]);

      if (todayResult.length === 0 || !todayResult[0].values[0][0]) {
        return res.json({
          available: false,
          message: '今日数据不足'
        });
      }

      const todayAvg = todayResult[0].values[0][0];
      const todaySamples = todayResult[0].values[0][1];

      // 2. 计算有多少天的历史数据
      const daysResult = db.exec(`
        SELECT COUNT(DISTINCT DATE(timestamp)) as days
        FROM listeners
        WHERE DATE(timestamp) < ?
      `, [todayDateStr]);

      const totalHistoricalDays = daysResult.length > 0 ? daysResult[0].values[0][0] : 0;

      if (totalHistoricalDays < 1) {
        return res.json({
          available: false,
          message: '历史数据不足'
        });
      }

      // 3. 确定使用多少天的历史数据（7天或全部）
      const daysToUse = Math.min(7, totalHistoricalDays);

      // 4. 获取历史同时段（0:00 到当前小时）的平均听众数
      const historicalSameHoursResult = db.exec(`
        SELECT AVG(listener_count) as avg
        FROM listeners
        WHERE DATE(timestamp) >= DATE(?, '-' || ? || ' days')
          AND DATE(timestamp) < ?
          AND CAST(strftime('%H', timestamp) AS INTEGER) < ?
      `, [todayDateStr, daysToUse, todayDateStr, currentHour]);

      if (historicalSameHoursResult.length === 0 || !historicalSameHoursResult[0].values[0][0]) {
        return res.json({
          available: false,
          message: '历史同时段数据不足'
        });
      }

      const historicalSameHoursAvg = historicalSameHoursResult[0].values[0][0];

      // 5. 计算系数：今天同时段表现 / 历史同时段表现
      const coefficient = todayAvg / historicalSameHoursAvg;

      // 6. 获取历史日均播放量（用校准系数估算，保持一致性）
      let historicalDailyStreams = null;

      // 计算历史日均听众数
      const historicalFullDayResult = db.exec(`
        SELECT AVG(daily_avg) as avg
        FROM (
          SELECT DATE(timestamp) as date, AVG(listener_count) as daily_avg
          FROM listeners
          WHERE DATE(timestamp) >= DATE(?, '-' || ? || ' days')
            AND DATE(timestamp) < ?
          GROUP BY DATE(timestamp)
        )
      `, [todayDateStr, daysToUse, todayDateStr]);

      if (historicalFullDayResult.length > 0 && historicalFullDayResult[0].values[0][0]) {
        const calibrationFactor = getCalibrationFactor();
        const historicalDailyAvg = historicalFullDayResult[0].values[0][0];
        historicalDailyStreams = historicalDailyAvg * calibrationFactor;
      }

      if (!historicalDailyStreams) {
        return res.json({
          available: false,
          message: '无法计算历史播放量'
        });
      }

      // 7. 预测今日播放量
      const predictedStreams = Math.round(historicalDailyStreams * coefficient);

      // 8. 计算趋势（对比最近1小时和之前的变化）
      const recentResult = db.exec(`
        SELECT AVG(listener_count) as avg
        FROM listeners
        WHERE timestamp >= datetime('now', '-1 hour')
      `);
      const olderResult = db.exec(`
        SELECT AVG(listener_count) as avg
        FROM listeners
        WHERE timestamp >= datetime('now', '-2 hours')
          AND timestamp < datetime('now', '-1 hour')
      `);

      let trendPercent = 0;
      if (recentResult.length > 0 && olderResult.length > 0 &&
          recentResult[0].values[0][0] && olderResult[0].values[0][0]) {
        const recentAvg = recentResult[0].values[0][0];
        const olderAvg = olderResult[0].values[0][0];
        trendPercent = ((recentAvg - olderAvg) / olderAvg * 100);
      }

      res.json({
        available: true,
        currentHour,
        todayAvg: Math.round(todayAvg * 10) / 10,
        todaySamples,
        historicalSameHoursAvg: Math.round(historicalSameHoursAvg * 10) / 10,
        historicalDays: daysToUse,
        coefficient: Math.round(coefficient * 1000) / 1000,
        historicalDailyStreams: Math.round(historicalDailyStreams),
        predictedStreams,
        trendPercent: Math.round(trendPercent * 10) / 10
      });
    } catch (e) {
      console.error('预测计算失败:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // 获取邮件配置状态 (不返回密钥/密码)
  app.get('/api/email/config', (req, res) => {
    res.json({
      enabled: CONFIG.email.enabled,
      provider: CONFIG.email.provider,
      // Resend
      hasResendApiKey: !!CONFIG.email.resendApiKey,
      // SMTP
      host: CONFIG.email.host,
      port: CONFIG.email.port,
      secure: CONFIG.email.secure,
      user: CONFIG.email.user ? CONFIG.email.user.replace(/(.{2}).*(@.*)/, '$1***$2') : '',
      hasPassword: !!CONFIG.email.pass,
      // 通用
      to: CONFIG.email.to ? CONFIG.email.to.replace(/(.{2}).*(@.*)/, '$1***$2') : '',
      from: CONFIG.email.from,
      lastEmailSent: lastEmailSent ? new Date(lastEmailSent).toISOString() : null,
      cooldownMinutes: EMAIL_COOLDOWN / 60000,
      // 定时报告
      reports: CONFIG.email.reports || { daily: false, weekly: false, monthly: false }
    });
  });

  // 更新邮件配置
  app.post('/api/email/config', (req, res) => {
    try {
      const { enabled, provider, resendApiKey, host, port, secure, user, pass, to, from, reports } = req.body;

      // 更新内存中的配置
      if (typeof enabled === 'boolean') CONFIG.email.enabled = enabled;
      if (provider) CONFIG.email.provider = provider;
      if (resendApiKey) CONFIG.email.resendApiKey = resendApiKey;
      if (host) CONFIG.email.host = host;
      if (port) CONFIG.email.port = parseInt(port);
      if (typeof secure === 'boolean') CONFIG.email.secure = secure;
      if (user) CONFIG.email.user = user;
      if (pass) CONFIG.email.pass = pass;
      if (to) CONFIG.email.to = to;
      if (from) CONFIG.email.from = from;

      // 更新报告配置
      if (reports) {
        if (!CONFIG.email.reports) CONFIG.email.reports = {};
        if (typeof reports.daily === 'boolean') CONFIG.email.reports.daily = reports.daily;
        if (typeof reports.weekly === 'boolean') CONFIG.email.reports.weekly = reports.weekly;
        if (typeof reports.monthly === 'boolean') CONFIG.email.reports.monthly = reports.monthly;
      }

      res.json({
        success: true,
        message: '邮件配置已更新 (仅当前会话有效，重启后需要修改 .env 文件)',
        config: {
          enabled: CONFIG.email.enabled,
          provider: CONFIG.email.provider,
          reports: CONFIG.email.reports
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 预览/测试定时报告
  app.post('/api/email/report/test', async (req, res) => {
    try {
      const { type } = req.body; // 'daily', 'weekly', 'monthly'
      if (!['daily', 'weekly', 'monthly'].includes(type)) {
        return res.status(400).json({ success: false, message: '无效的报告类型' });
      }

      await sendScheduledReport(type);
      res.json({ success: true, message: `${type} 报告已发送` });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 测试邮件发送
  app.post('/api/email/test', async (req, res) => {
    try {
      const result = await sendEmailNotification(
        '测试邮件',
        '这是一封测试邮件，如果您收到此邮件，说明邮件通知功能配置正确！',
        true // 跳过冷却时间
      );

      if (result.success) {
        res.json({ success: true, message: '测试邮件已发送，请检查收件箱' });
      } else {
        res.json({ success: false, message: result.error || '发送失败' });
      }
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 实时监控数据（最近5分钟）
  app.get('/api/realtime', (req, res) => {
    try {
      const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();

      const result = db.exec(`
        SELECT timestamp, listener_count
        FROM listeners
        WHERE timestamp >= ?
        ORDER BY id DESC
      `, [cutoff]);

      if (result.length === 0) {
        return res.json([]);
      }

      const realtimeData = result[0].values.map(row => ({
        timestamp: row[0],
        listenerCount: row[1]
      }));

      res.json(realtimeData.reverse());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 商用级前端 Dashboard (旧版，保留兼容)
  app.get('/pro', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
  });

  // Dashboard V2 - 世界级数据可视化设计 (新版主页)
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard-v2.html'));
  });

  // Dashboard Classic - 经典版本
  app.get('/classic', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>Spotify Listeners Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="description" content="Real-time Spotify listener tracking dashboard" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      background: linear-gradient(135deg, #0d0d0d 0%, #1a1a2e 50%, #16213e 100%);
      color: #ffffff;
      padding: 24px;
      background-attachment: fixed;
    }

    /* 动态背景 */
    body::before {
      content: '';
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: 
        radial-gradient(circle at 20% 80%, rgba(29, 185, 84, 0.15) 0%, transparent 50%),
        radial-gradient(circle at 80% 20%, rgba(29, 185, 84, 0.1) 0%, transparent 50%),
        radial-gradient(circle at 40% 40%, rgba(30, 215, 96, 0.05) 0%, transparent 40%);
      pointer-events: none;
      z-index: 0;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      position: relative;
      z-index: 1;
    }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 32px;
      padding-bottom: 24px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }

    /* Sidebar Components */
    .sidebar-section {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .sidebar-label {
      font-size: 11px;
      font-weight: 700;
      color: rgba(255, 255, 255, 0.3);
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .system-info-card {
      background: rgba(255, 255, 255, 0.03);
      border-radius: 12px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .info-item {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
    }

    .info-label { color: rgba(255, 255, 255, 0.5); }
    .info-value { color: #fff; font-weight: 500; font-family: monospace; }

    /* Live Event Log */
    .event-log {
      background: #000;
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 12px;
      height: 300px;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
    }

    .event-item {
      border-left: 2px solid #333;
      padding-left: 8px;
      padding-bottom: 4px;
    }

    .event-item.info { border-color: #3b82f6; }
    .event-item.success { border-color: #1DB954; }
    .event-item.warning { border-color: #f59e0b; }
    .event-item.error { border-color: #ef4444; }

    .event-time { color: rgba(255, 255, 255, 0.3); margin-right: 6px; }
    .event-msg { color: rgba(255, 255, 255, 0.8); word-break: break-all; }

    /* Growth Trends */
    .growth-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
    }

    .growth-card {
      background: rgba(255, 255, 255, 0.03);
      border-radius: 10px;
      padding: 12px;
      text-align: center;
    }

    .growth-label { font-size: 10px; color: rgba(255, 255, 255, 0.4); margin-bottom: 4px; }
    .growth-value { font-size: 14px; font-weight: 700; }
    .growth-value.up { color: #1DB954; }
    .growth-value.down { color: #ef4444; }
    .growth-pct { font-size: 10px; margin-top: 2px; opacity: 0.8; }

    /* Header Styling */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 32px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .logo {
      width: 48px;
      height: 48px;
      background: linear-gradient(135deg, #1DB954, #1ed760);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 20px rgba(29, 185, 84, 0.4);
    }

    .logo svg {
      width: 28px;
      height: 28px;
      fill: white;
    }

    h1 {
      font-size: 28px;
      font-weight: 700;
      background: linear-gradient(135deg, #1DB954, #1ed760, #4ade80);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .live-badge {
      display: flex;
      align-items: center;
      gap: 6px;
      background: rgba(29, 185, 84, 0.2);
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 500;
      color: #1DB954;
      margin-left: auto;
    }

    .live-dot {
      width: 8px;
      height: 8px;
      background: #1DB954;
      border-radius: 50%;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(1.2); }
    }

    /* Cards */
    .card {
      background: rgba(255, 255, 255, 0.03);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 20px;
      padding: 24px;
      margin-bottom: 20px;
      transition: all 0.3s ease;
    }

    .card:hover {
      background: rgba(255, 255, 255, 0.05);
      border-color: rgba(29, 185, 84, 0.3);
      transform: translateY(-2px);
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
    }

    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
    }

    .stat-card {
      background: linear-gradient(135deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02));
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 20px;
      display: flex;
      align-items: flex-start;
      gap: 16px;
      transition: all 0.3s ease;
    }

    .stat-card:hover {
      border-color: rgba(29, 185, 84, 0.4);
      background: linear-gradient(135deg, rgba(29, 185, 84, 0.1), rgba(29, 185, 84, 0.02));
    }

    .stat-card.highlight {
      background: linear-gradient(135deg, rgba(29, 185, 84, 0.2), rgba(29, 185, 84, 0.05));
      border-color: rgba(29, 185, 84, 0.4);
    }

    .stat-icon {
      width: 48px;
      height: 48px;
      background: linear-gradient(135deg, rgba(29, 185, 84, 0.3), rgba(29, 185, 84, 0.1));
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .stat-icon svg {
      width: 24px;
      height: 24px;
      fill: #1DB954;
    }

    .stat-content {
      flex: 1;
    }

    .stat-label {
      font-size: 13px;
      font-weight: 500;
      color: rgba(255, 255, 255, 0.6);
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .stat-value {
      font-size: 32px;
      font-weight: 700;
      color: #ffffff;
      line-height: 1.2;
    }

    .stat-card.highlight .stat-value {
      background: linear-gradient(135deg, #1DB954, #4ade80);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .percentile-badge {
      display: inline-block;
      padding: 2px 8px;
      background: rgba(29, 185, 84, 0.2);
      color: #1DB954;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      margin-top: 8px;
    }

    /* Data Table */
    .table-container {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 16px;
      margin-top: 24px;
      overflow: hidden;
    }

    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    .data-table th, .data-table td {
      padding: 12px 20px;
      text-align: left;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }

    .data-table th {
      background: rgba(255, 255, 255, 0.03);
      color: rgba(255, 255, 255, 0.4);
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .data-table tr:hover {
      background: rgba(255, 255, 255, 0.02);
    }

    .trend-indicator {
      display: inline-flex;
      align-items: center;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
    }

    .trend-up { background: rgba(29, 185, 84, 0.1); color: #1DB954; }
    .trend-down { background: rgba(239, 68, 68, 0.1); color: #ef4444; }

    /* Chart Section */
    .chart-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
    }

    .chart-title {
      font-size: 18px;
      font-weight: 600;
      color: #ffffff;
    }

    .chart-subtitle {
      font-size: 13px;
      color: rgba(255, 255, 255, 0.5);
      margin-top: 4px;
    }

    .chart-container {
      position: relative;
      height: 300px;
    }

    /* Range Selector */
    .range-selector {
      display: flex;
      gap: 8px;
    }

    .range-btn {
      padding: 6px 14px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      color: rgba(255, 255, 255, 0.6);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .range-btn:hover {
      background: rgba(29, 185, 84, 0.1);
      border-color: rgba(29, 185, 84, 0.3);
      color: #1DB954;
    }

    .range-btn.active {
      background: rgba(29, 185, 84, 0.2);
      border-color: #1DB954;
      color: #1DB954;
    }

    /* Analytics Grid */
    .analytics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
    }

    .analytics-item {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 16px;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.06);
    }

    .analytics-icon {
      font-size: 32px;
    }

    .analytics-info {
      flex: 1;
    }

    .analytics-label {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.5);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .analytics-value {
      font-size: 18px;
      font-weight: 600;
      color: #ffffff;
      margin-top: 2px;
    }

    .analytics-sub {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.4);
      margin-top: 2px;
    }

    .analytics-section {
      margin-bottom: 24px;
    }

    .analytics-section:last-child {
      margin-bottom: 0;
    }

    .analytics-section-title {
      font-size: 14px;
      font-weight: 600;
      color: rgba(255, 255, 255, 0.8);
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }

    .time-slots {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
    }

    .time-slot {
      text-align: center;
      padding: 16px 8px;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.06);
    }

    .slot-icon {
      font-size: 24px;
      margin-bottom: 8px;
    }

    .slot-name {
      font-size: 13px;
      font-weight: 600;
      color: #fff;
    }

    .slot-time {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.4);
      margin-top: 2px;
    }

    .slot-value {
      font-size: 16px;
      font-weight: 700;
      color: #1DB954;
      margin-top: 8px;
    }

    @media (max-width: 600px) {
      .time-slots {
        grid-template-columns: repeat(2, 1fr);
      }
    }

    /* Links Section */
    .links-grid {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }

    .link-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 12px 20px;
      background: rgba(29, 185, 84, 0.1);
      border: 1px solid rgba(29, 185, 84, 0.3);
      border-radius: 12px;
      color: #1DB954;
      text-decoration: none;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.3s ease;
    }

    .link-btn:hover {
      background: rgba(29, 185, 84, 0.2);
      border-color: #1DB954;
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(29, 185, 84, 0.2);
    }

    .link-btn svg {
      width: 18px;
      height: 18px;
      fill: currentColor;
    }

    /* Update Time */
    .update-time {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: rgba(255, 255, 255, 0.5);
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }

    .update-time svg {
      width: 16px;
      height: 16px;
      fill: currentColor;
    }

    /* Error Banner */
    .error-banner {
      background: linear-gradient(135deg, rgba(239, 68, 68, 0.2), rgba(239, 68, 68, 0.1));
      border: 1px solid rgba(239, 68, 68, 0.4);
      border-radius: 12px;
      padding: 16px 20px;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .error-banner.warning {
      background: linear-gradient(135deg, rgba(245, 158, 11, 0.2), rgba(245, 158, 11, 0.1));
      border-color: rgba(245, 158, 11, 0.4);
    }

    .error-icon {
      font-size: 24px;
    }

    .error-content {
      flex: 1;
    }

    .error-title {
      font-weight: 600;
      color: #ef4444;
      margin-bottom: 4px;
    }

    .error-banner.warning .error-title {
      color: #f59e0b;
    }

    .error-message {
      font-size: 13px;
      color: rgba(255, 255, 255, 0.7);
    }

    .error-action {
      padding: 8px 16px;
      background: #ef4444;
      border: none;
      border-radius: 8px;
      color: white;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }

    .error-action:hover {
      background: #dc2626;
    }

    .error-banner.warning .error-action:hover {
      background: #d97706;
    }

    /* Modal Styling */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.8);
      backdrop-filter: blur(8px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 20px;
    }

    .modal {
      background: #1a1a2e;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 20px;
      width: 100%;
      max-width: 600px;
      padding: 32px;
      position: relative;
      box-shadow: 0 30px 60px rgba(0, 0, 0, 0.5);
    }

    .modal-title {
      font-size: 20px;
      font-weight: 700;
      margin-bottom: 24px;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .modal-close {
      position: absolute;
      top: 20px;
      right: 20px;
      background: none;
      border: none;
      color: rgba(255, 255, 255, 0.5);
      cursor: pointer;
      font-size: 24px;
    }

    .modal-close:hover {
      color: white;
    }

    .cookie-guide {
      background: rgba(255, 255, 255, 0.05);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 24px;
      font-size: 13px;
      line-height: 1.6;
    }

    .cookie-guide ol {
      margin-left: 20px;
      margin-top: 8px;
    }

    .cookie-guide code {
      background: rgba(29, 185, 84, 0.2);
      color: #1DB954;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: monospace;
    }

    #cookie-input {
      width: 100%;
      height: 160px;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 16px;
      color: #fff;
      font-family: monospace;
      font-size: 13px;
      resize: none;
      margin-bottom: 20px;
    }

    #cookie-input:focus {
      outline: none;
      border-color: #1DB954;
      box-shadow: 0 0 0 2px rgba(29, 185, 84, 0.2);
    }

    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
    }

    .btn {
      padding: 10px 24px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: white;
    }

    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.15);
    }

    .btn-primary {
      background: #1DB954;
      border: none;
      color: white;
    }

    .btn-primary:hover {
      background: #1ed760;
      transform: translateY(-1px);
    }

    .login-options {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }

    .login-opt-card {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 20px;
      cursor: pointer;
      text-align: center;
      transition: all 0.2s;
    }

    .login-opt-card:hover {
      background: rgba(29, 185, 84, 0.1);
      border-color: #1DB954;
    }

    .login-opt-icon {
      font-size: 32px;
      margin-bottom: 12px;
    }

    .login-opt-title {
      font-weight: 600;
      margin-bottom: 4px;
    }

    .login-opt-desc {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.5);
    }

    /* Loading State */
    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 60px 20px;
      color: rgba(255, 255, 255, 0.5);
    }

    .spinner {
      width: 24px;
      height: 24px;
      border: 3px solid rgba(29, 185, 84, 0.2);
      border-top-color: #1DB954;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-right: 12px;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* Footer */
    .footer {
      text-align: center;
      padding: 24px;
      color: rgba(255, 255, 255, 0.3);
      font-size: 13px;
    }

    /* Responsive */
    @media (max-width: 768px) {
      body { padding: 16px; }
      h1 { font-size: 22px; }
      .stat-value { font-size: 26px; }
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
      .chart-container { height: 250px; }
    }

    @media (max-width: 480px) {
      .stats-grid { grid-template-columns: 1fr; }
      .header { flex-wrap: wrap; }
      .live-badge { margin-left: 0; margin-top: 8px; }
    }
  </style>
</head>
<body>

<div class="container">
  <!-- Header -->
  <header class="header">
    <div class="logo">
      <svg viewBox="0 0 24 24"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
    </div>
    <div>
      <h1>Spotify Listeners</h1>
    </div>
    <div class="live-badge" id="backend-status">
      <span class="live-dot"></span>
      实时监控中
    </div>
  </header>

  <!-- Error Banner -->
  <div id="error-display" style="display: none;"></div>

  <!-- Stats Cards -->
  <div id="stats" class="card">
    <div class="loading">
      <div class="spinner"></div>
      加载数据中...
    </div>
  </div>

  <!-- Prediction Card -->
  <div id="prediction" class="card" style="display:none;">
    <div class="chart-header">
      <div>
        <div class="chart-title">🔮 今日预测</div>
        <div class="chart-subtitle">基于当前趋势估算</div>
      </div>
    </div>
    <div id="prediction-content"></div>
  </div>

  <!-- Chart -->
  <div class="card">
    <div class="chart-header">
      <div>
        <div class="chart-title">📈 收听趋势</div>
        <div class="chart-subtitle" id="chart-subtitle">数据加载中...</div>
      </div>
      <div class="range-selector">
        <button class="range-btn active" data-range="120">1小时</button>
        <button class="range-btn" data-range="720">6小时</button>
        <button class="range-btn" data-range="1440">12小时</button>
        <button class="range-btn" data-range="2880">24小时</button>
        <button class="range-btn" data-range="0">全部</button>
      </div>
    </div>
    <div class="chart-container" style="height: 350px;">
      <canvas id="chart"></canvas>
    </div>
  </div>

  <!-- Analytics -->
  <div id="analytics" class="card" style="display:none;">
    <div class="chart-header">
      <div>
        <div class="chart-title">📊 数据分析</div>
        <div class="chart-subtitle">深度洞察</div>
      </div>
    </div>
    <div id="analytics-content"></div>
  </div>

  <!-- Links -->
  <div class="card">
    <div class="links-grid">
      <a href="/api/stats" target="_blank" class="link-btn">
        <svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/></svg>
        统计 JSON
      </a>
      <a href="/api/data?limit=100" target="_blank" class="link-btn">
        <svg viewBox="0 0 24 24"><path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9h-4v4h-2v-4H9V9h4V5h2v4h4v2z"/></svg>
        最近 100 条
      </a>
      <a href="/api/download/csv" class="link-btn">
        <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        下载 CSV
      </a>
      <button onclick="handleLogin()" class="link-btn" style="border:none; cursor:pointer;">
        <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"/></svg>
        重新登录
      </button>
      <button onclick="handleClearData()" class="link-btn" style="border:none; cursor:pointer; background:rgba(239,68,68,0.1); border-color:rgba(239,68,68,0.3); color:#ef4444;">
        <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        清空数据
      </button>
    </div>
  </div>

  <!-- Footer -->
  <footer class="footer">
    Spotify Listeners Tracker · Commercial Grade Dashboard
  </footer>
</div>

<!-- Cookie Modal -->
<div id="cookie-modal" class="modal-overlay">
  <div class="modal">
    <button class="modal-close" onclick="closeModal('cookie-modal')">&times;</button>
    <div class="modal-title">🍪 远程 Cookie 上传</div>
    <div class="cookie-guide">
      为了在 Linux 等无界面环境下登录，请执行以下步骤：
      <ol>
        <li>在您的电脑浏览器登录 Spotify for Artists。</li>
        <li>使用 <code>EditThisCookie</code> 或类似插件导出 JSON 格式的 Cookies。</li>
        <li>将导出的 JSON 文本粘贴到下方。</li>
      </ol>
    </div>
    <textarea id="cookie-input" placeholder="将 JSON 格式的 Cookies 粘贴到这里..."></textarea>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="closeModal('cookie-modal')">取消</button>
      <button class="btn btn-primary" onclick="uploadCookies()">完成并应用</button>
    </div>
  </div>
</div>

<!-- Login Options Modal -->
<div id="login-modal" class="modal-overlay">
  <div class="modal">
    <button class="modal-close" onclick="closeModal('login-modal')">&times;</button>
    <div class="modal-title">🔐 选择登录方式</div>
    <div class="login-options">
      <div class="login-opt-card" onclick="startLocalLogin()">
        <div class="login-opt-icon">🖥️</div>
        <div class="login-opt-title">本地模式</div>
        <div class="login-opt-desc">在服务器上打开浏览器 (适用于 Windows/Mac)</div>
      </div>
      <div class="login-opt-card" onclick="openCookieModal()">
        <div class="login-opt-icon">☁️</div>
        <div class="login-opt-title">远程模式</div>
        <div class="login-opt-desc">上传 Cookies (适用于 Linux/Headless 用户)</div>
      </div>
    </div>
  </div>
</div>

<script>
let chart;
let currentRange = 120;
let allData = [];

// 范围选择器
document.querySelectorAll('.range-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentRange = parseInt(btn.dataset.range);
    loadChart();
  });
});

async function checkStatus() {
  try {
    const res = await fetch('/api/status');
    const s = await res.json();
    const display = document.getElementById('error-display');
    const badge = document.getElementById('backend-status');
    

    if (s.errorMessage) {
      display.style.display = 'block';
      const isWarning = s.consecutiveErrors < 3;
      display.className = 'error-banner ' + (isWarning ? 'warning' : '');
      display.innerHTML =
        '<div class="error-icon">' + (isWarning ? '⚠️' : '🚨') + '</div>' +
        '<div class="error-content">' +
          '<div class="error-title">' + s.errorMessage + '</div>' +
          '<div class="error-message">最后成功抓取: ' + (s.lastSuccess ? new Date(s.lastSuccess).toLocaleString() : '从无') + '</div>' +
        '</div>' +
        '<button class="error-action" onclick="handleLogin()">重新登录 / 上传 Cookie</button>';
      badge.style.color = isWarning ? '#f59e0b' : '#ef4444';
      badge.innerHTML = '<span class="live-dot" style="background:' + (isWarning ? '#f59e0b' : '#ef4444') + '"></span>状态异常';
    } else {
      display.style.display = 'none';
      badge.style.color = '#1DB954';
      badge.innerHTML = '<span class="live-dot"></span>实时监控中';
    }
  } catch (e) {
    console.error('获取状态失败:', e);
  }
}



async function handleLogin() {
  document.getElementById('login-modal').style.display = 'flex';
}

function closeModal(id) {
  document.getElementById(id).style.display = 'none';
}

function openCookieModal() {
  closeModal('login-modal');
  document.getElementById('cookie-modal').style.display = 'flex';
}

async function startLocalLogin() {
  if (!confirm('这将在服务器上打开一个浏览器窗口。确定继续吗？')) return;
  closeModal('login-modal');
  
  try {
    const res = await fetch('/api/login', { method: 'POST' });
    const data = await res.json();
    alert(data.message);
  } catch (e) {
    alert('请求登录失败: ' + e.message);
  }
}

async function uploadCookies() {
  const input = document.getElementById('cookie-input').value.trim();
  if (!input) return alert('请输入 Cookie 数据');

  let cookies;
  try {
    cookies = JSON.parse(input);
  } catch (e) {
    return alert('JSON 格式错误，请确保复制的是有效的 JSON 数组');
  }

  try {
    const res = await fetch('/api/cookies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cookies)
    });
    const data = await res.json();
    if (data.success) {
      alert(data.message);
      closeModal('cookie-modal');
    } else {
      alert('上传失败: ' + data.message);
    }
  } catch (e) {
    alert('上传请求失败: ' + e.message);
  }
}

async function handleClearData() {
  const confirmed = confirm('⚠️ 警告：此操作将永久删除所有历史数据！\n\n确定要清空数据库吗？\n\n建议先下载CSV备份。');
  if (!confirmed) return;

  const doubleConfirm = confirm('再次确认：你真的要删除所有数据吗？\n\n此操作不可恢复！');
  if (!doubleConfirm) return;

  try {
    const res = await fetch('/api/clear-data', { method: 'POST' });
    const data = await res.json();

    if (data.success) {
      alert('✅ ' + data.message);
      // 刷新页面数据
      await refresh();
    } else {
      alert('❌ 清空失败: ' + data.message);
    }
  } catch (e) {
    alert('❌ 请求失败: ' + e.message);
  }
}

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const s = await res.json();

    if (!s || s.totalRecords === 0) {
      document.getElementById('stats').innerHTML = '<div class="loading">暂无数据，等待首次抓取...</div>';
      return;
    }

    document.getElementById('stats').innerHTML = \`
      <div class="stats-grid">
        <div class="stat-card highlight">
          <div class="stat-icon">
            <svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
          </div>
          <div class="stat-content">
            <div class="stat-label">当前收听</div>
            <div class="stat-value">\${s.latestCount.toLocaleString()}</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">
            <svg viewBox="0 0 24 24"><path d="M7 14l5-5 5 5z"/></svg>
          </div>
          <div class="stat-content">
            <div class="stat-label">历史最高</div>
            <div class="stat-value">\${s.maxCount.toLocaleString()}</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">
            <svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>
          </div>
          <div class="stat-content">
            <div class="stat-label">最低记录</div>
            <div class="stat-value">\${s.minCount.toLocaleString()}</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">
            <svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/></svg>
          </div>
          <div class="stat-content">
            <div class="stat-label">总记录数</div>
            <div class="stat-value">\${s.totalRecords.toLocaleString()}</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">
            <svg viewBox="0 0 24 24"><path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9h-4v4h-2v-4H9V9h4V5h2v4h4v2z"/></svg>
          </div>
          <div class="stat-content">
            <div class="stat-label">平均值</div>
            <div class="stat-value">\${s.avgCount.toLocaleString()}</div>
          </div>
        </div>
      </div>
      <div class="update-time">
        <svg viewBox="0 0 24 24"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
        数据更新于：\${new Date(s.latestTime).toLocaleString()}
      </div>
    \`;
  } catch (e) {
    console.error('加载统计失败:', e);
  }
}



async function loadChart() {
  try {
    const limit = currentRange === 0 ? 10000 : currentRange;
    const res = await fetch('/api/data?limit=' + limit);
    allData = await res.json();

    if (allData.length === 0) return;

    // 更新副标题
    const rangeText = currentRange === 0 ? '全量数据历史' : '最近 ' + allData.length + ' 个采集点';
    document.getElementById('chart-subtitle').textContent = rangeText;

    const labels = allData.map(d => {
      const date = new Date(d.timestamp);
      return currentRange > 720 || currentRange === 0 
        ? date.toLocaleString('zh-CN', {month:'numeric', day:'numeric', hour:'numeric', minute:'numeric'})
        : date.toLocaleTimeString();
    });
    const values = allData.map(d => d.listenerCount);

    const ctx = document.getElementById('chart').getContext('2d');
    const gradientFill = ctx.createLinearGradient(0, 0, 0, 350);
    gradientFill.addColorStop(0, 'rgba(29, 185, 84, 0.3)');
    gradientFill.addColorStop(1, 'rgba(29, 185, 84, 0)');

    if (!chart) {
      chart = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            data: values,
            borderColor: '#1DB954',
            borderWidth: 2,
            backgroundColor: gradientFill,
            fill: true,
            tension: 0.4,
            pointRadius: 0,
            pointHoverRadius: 6,
            pointHoverBackgroundColor: '#1DB954',
            pointHoverBorderColor: '#fff',
            pointHoverBorderWidth: 2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 500 },
          interaction: { intersect: false, mode: 'index' },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: 'rgba(0, 0, 0, 0.8)',
              titleColor: '#fff',
              bodyColor: '#1DB954',
              borderColor: 'rgba(29, 185, 84, 0.3)',
              borderWidth: 1,
              padding: 12,
              displayColors: false,
              callbacks: {
                label: ctx => ctx.parsed.y.toLocaleString() + ' 人正在收听'
              }
            }
          },
          scales: {
            y: {
              beginAtZero: false,
              grid: { color: 'rgba(255, 255, 255, 0.05)', drawBorder: false },
              ticks: { color: 'rgba(255, 255, 255, 0.5)', font: { size: 11 } }
            },
            x: {
              grid: { display: false },
              ticks: { color: 'rgba(255, 255, 255, 0.5)', maxTicksLimit: 8, font: { size: 11 } }
            }
          }
        }
      });
    } else {
      chart.data.labels = labels;
      chart.data.datasets[0].data = values;
      chart.update('none');
    }

    // 加载预测和分析
    loadPrediction(allData);
    loadAnalytics(allData);
  } catch (e) {
    console.error('加载图表失败:', e);
  }
}



async function loadPrediction(data) {
  const predictionEl = document.getElementById('prediction');
  const contentEl = document.getElementById('prediction-content');

  try {
    const response = await fetch('/api/prediction');
    const pred = await response.json();

    if (!pred.available) {
      predictionEl.style.display = 'none';
      return;
    }

    predictionEl.style.display = 'block';

    // 趋势判断
    const trendPercent = pred.trendPercent;
    const trend = trendPercent > 5 ? '📈 爆发增长' : trendPercent < -5 ? '📉 快速回落' : '➡️ 趋于平稳';

    // 系数描述
    const coeffDesc = pred.coefficient > 1
      ? \`高于历史 \${Math.round((pred.coefficient - 1) * 100)}%\`
      : pred.coefficient < 1
        ? \`低于历史 \${Math.round((1 - pred.coefficient) * 100)}%\`
        : '与历史持平';

    contentEl.innerHTML = \`
      <div class="stats-grid">
        <div class="stat-card highlight">
          <div class="stat-icon">🌟</div>
          <div class="stat-content">
            <div class="stat-label">今日预计播放次数</div>
            <div class="stat-value">\${pred.predictedStreams.toLocaleString()}</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.6)">基于近\${pred.historicalDays}天历史数据</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">📊</div>
          <div class="stat-content">
            <div class="stat-label">今日表现系数</div>
            <div class="stat-value" style="font-size:28px">\${pred.coefficient.toFixed(2)}x</div>
            <div style="font-size:12px;color:\${pred.coefficient >= 1 ? '#1DB954' : '#ef4444'}">\${coeffDesc}</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">⏰</div>
          <div class="stat-content">
            <div class="stat-label">当前势能</div>
            <div class="stat-value" style="font-size:20px">\${trend}</div>
            <div style="font-size:12px;color:\${trendPercent > 0 ? '#1DB954' : '#ef4444'}">\${trendPercent > 0 ? '+' : ''}\${trendPercent}% (较上小时)</div>
          </div>
        </div>
      </div>
      <div style="margin-top:12px;padding:10px 14px;background:rgba(255,255,255,0.05);border-radius:8px;font-size:12px;color:rgba(255,255,255,0.5)">
        📐 算法：今日前\${pred.currentHour}小时平均 <b>\${pred.todayAvg}</b> ÷ 历史同时段平均 <b>\${pred.historicalSameHoursAvg}</b> = <b>\${pred.coefficient.toFixed(3)}</b> → 历史日均 <b>\${pred.historicalDailyStreams.toLocaleString()}</b> × 系数 = <b>\${pred.predictedStreams.toLocaleString()}</b>
      </div>
    \`;
  } catch (e) {
    console.error('加载预测失败:', e);
    predictionEl.style.display = 'none';
  }
}

function loadAnalytics(data) {
  if (data.length < 20) {
    document.getElementById('analytics').style.display = 'none';
    return;
  }

  document.getElementById('analytics').style.display = 'block';

  const values = data.map(d => d.listenerCount);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);
  const volatility = (stdDev / mean * 100).toFixed(1);

  // 稳定性评估
  const stabilityIndex = (100 - volatility).toFixed(1);
  const stabilityLabel = stabilityIndex > 90 ? '卓越' : stabilityIndex > 70 ? '良好' : '波动剧烈';

  // 增长率 (对比数据首尾)
  const startChunk = values.slice(0, 10);
  const endChunk = values.slice(-10);
  const startAvg = startChunk.reduce((a, b) => a + b, 0) / startChunk.length;
  const endAvg = endChunk.reduce((a, b) => a + b, 0) / endChunk.length;
  const growthRate = startAvg > 0 ? ((endAvg - startAvg) / startAvg * 100).toFixed(1) : 0;

  document.getElementById('analytics-content').innerHTML = \`
    <div class="analytics-section">
      <div class="analytics-section-title">⚖️ 全球收听表现核心指标</div>
      <div class="analytics-grid">
        <div class="analytics-item">
          <div class="analytics-icon">📈</div>
          <div class="analytics-info">
            <div class="analytics-label">阶段性增长率</div>
            <div class="analytics-value" style="color:\${growthRate > 0 ? '#1DB954' : '#ef4444'}">\${growthRate > 0 ? '+' : ''}\${growthRate}%</div>
            <div class="analytics-sub">基于当前展示范围</div>
          </div>
        </div>
        <div class="analytics-item">
          <div class="analytics-icon">🛡️</div>
          <div class="analytics-info">
            <div class="analytics-label">收听稳定性</div>
            <div class="analytics-value">\${stabilityIndex}%</div>
            <div class="analytics-sub">状态: \${stabilityLabel}</div>
          </div>
        </div>
        <div class="analytics-item">
          <div class="analytics-icon">💎</div>
          <div class="analytics-info">
            <div class="analytics-label">峰值占有率</div>
            <div class="analytics-value">\${((mean/max)*100).toFixed(1)}%</div>
            <div class="analytics-sub">均值对比历史最高</div>
          </div>
        </div>
        <div class="analytics-item">
          <div class="analytics-icon">🧬</div>
          <div class="analytics-info">
            <div class="analytics-label">变异系数</div>
            <div class="analytics-value">\${volatility}%</div>
            <div class="analytics-sub">数值越低代表表现越稳</div>
          </div>
        </div>
      </div>
    </div>
  \`;
}

async function refresh() {
  await Promise.all([loadStats(), loadChart(), checkStatus()]);
}

// 自动刷新（每5秒）
refresh();
setInterval(refresh, 5000);
</script>

</body>
</html>
    `);
  });

  // 启动服务器
  app.listen(CONFIG.port, () => {
    console.log(`服务器已启动: http://localhost:${CONFIG.port}`);
  });
}

// 浏览器崩溃恢复
async function ensureBrowser() {
  try {
    if (!browser || !browser.isConnected()) {
      console.log('检测到浏览器未运行，正在重启...');
      if (browser) {
        try {
          await browser.close();
        } catch (e) {
          // 忽略关闭错误
        }
      }
      await initBrowser();
    }
  } catch (e) {
    console.error('浏览器恢复失败:', e.message);
  }
}

// 带恢复机制的抓取循环
async function scrapeWithRecovery() {
  try {
    await ensureBrowser();
    await scrapeListeners();
  } catch (e) {
    console.error('抓取过程出错:', e.message);
    scrapeStatus.errorMessage = e.message;
    scrapeStatus.lastError = new Date().toISOString();
    scrapeStatus.consecutiveErrors++;

    // 连续错误超过5次发送邮件通知
    if (scrapeStatus.consecutiveErrors >= 5) {
      sendEmailNotification(
        '抓取连续失败',
        `抓取已连续失败 ${scrapeStatus.consecutiveErrors} 次。<br><br>错误信息: ${e.message}<br><br>请检查服务器状态或重新登录。`
      );
    }
  }
}

// 启动定时抓取（使用恢复机制）
function startScraping() {
  console.log(`开始定时抓取，间隔: ${CONFIG.scrapeInterval / 1000} 秒`);

  // 立即执行一次
  scrapeWithRecovery();

  // 定时执行抓取
  setInterval(scrapeWithRecovery, CONFIG.scrapeInterval);

  // 定时检查报告 (每5分钟检查一次)
  setInterval(checkAndSendReports, 5 * 60 * 1000);
  console.log('定时报告检查已启动 (每5分钟检查一次)');
}

// 初始化并启动
async function main() {
  console.log('=== Spotify Listeners Tracker ===');
  console.log('正在启动服务...\n');

  // 初始化数据库
  await initDatabase();

  // 启动 Web 服务器
  startServer();

  // 初始化浏览器
  await initBrowser();

  // 首次加载页面
  await loadPage();

  // 启动定时抓取
  startScraping();

  console.log('\n服务已启动成功！');
}

// 优雅退出
process.on('SIGINT', async () => {
  console.log('\n正在关闭...');
  if (db) {
    saveDatabaseToFile();
    db.close();
  }
  if (browser) await browser.close();
  process.exit(0);
});

// 启动
main().catch(console.error);
