const puppeteer = require('puppeteer');
const fs = require('fs');
const readline = require('readline');

const CONFIG = {
  artistUrl: 'https://artists.spotify.com/',
  cookiesFile: 'cookies.json'
};

async function login() {
  console.log('=== Spotify 登录脚本 ===');
  console.log('这个脚本会打开浏览器让你手动登录，然后保存 cookies\n');

  const browser = await puppeteer.launch({
    headless: false,  // 显示浏览器窗口
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  console.log('正在打开 Spotify for Artists...');
  await page.goto(CONFIG.artistUrl, { waitUntil: 'networkidle2' });

  console.log('\n========================================');
  console.log('请在浏览器窗口中登录你的 Spotify 账号');
  console.log('登录成功后，请回到这里按 Enter 键继续');
  console.log('========================================\n');

  // 等待用户按 Enter
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  await new Promise(resolve => {
    rl.question('登录完成后按 Enter 继续...', resolve);
  });
  rl.close();

  // 保存 cookies
  const cookies = await page.cookies();
  fs.writeFileSync(CONFIG.cookiesFile, JSON.stringify(cookies, null, 2));
  console.log(`\nCookies 已保存到 ${CONFIG.cookiesFile}`);
  console.log(`共 ${cookies.length} 个 cookies`);

  await browser.close();
  console.log('\n登录脚本完成！现在可以运行 node index.js 启动监控服务了');
}

login().catch(console.error);
