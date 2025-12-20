require('dotenv').config();
const fs = require('fs');
const initSqlJs = require('sql.js');

const OLD_JSON_FILE = 'listeners_data.json';
const DB_FILE = process.env.DATABASE_FILE || 'listeners.db';

async function migrate() {
  console.log('=== Spotify Listeners 数据迁移工具 ===\n');

  // 检查旧数据文件是否存在
  if (!fs.existsSync(OLD_JSON_FILE)) {
    console.log(`❌ 未找到 ${OLD_JSON_FILE} 文件`);
    console.log('如果这是全新安装，无需迁移。');
    process.exit(0);
  }

  // 读取旧数据
  console.log(`📖 正在读取 ${OLD_JSON_FILE}...`);
  let oldData;
  try {
    const rawData = fs.readFileSync(OLD_JSON_FILE, 'utf8');
    oldData = JSON.parse(rawData);
    console.log(`✓ 成功读取 ${oldData.length} 条记录\n`);
  } catch (e) {
    console.error('❌ 读取 JSON 文件失败:', e.message);
    process.exit(1);
  }

  if (oldData.length === 0) {
    console.log('JSON 文件为空，无需迁移。');
    process.exit(0);
  }

  // 初始化数据库
  console.log(`📊 正在初始化数据库 ${DB_FILE}...`);
  let db;
  try {
    const SQL = await initSqlJs();

    // 如果数据库文件存在，加载它
    if (fs.existsSync(DB_FILE)) {
      const buffer = fs.readFileSync(DB_FILE);
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

    console.log('✓ 数据库初始化成功\n');
  } catch (e) {
    console.error('❌ 数据库初始化失败:', e.message);
    process.exit(1);
  }

  // 检查数据库中已有的数据
  const existingResult = db.exec('SELECT COUNT(*) as count FROM listeners');
  const existingCount = existingResult.length > 0 ? existingResult[0].values[0][0] : 0;

  if (existingCount > 0) {
    console.log(`⚠️  数据库中已有 ${existingCount} 条记录`);
    console.log('迁移将追加新数据（跳过重复的时间戳）\n');
  }

  // 批量插入
  console.log('📥 开始迁移数据...');
  try {
    for (const record of oldData) {
      db.run('INSERT OR IGNORE INTO listeners (timestamp, listener_count) VALUES (?, ?)',
        [record.timestamp, record.listenerCount]);
    }
    console.log('✓ 数据迁移成功！\n');
  } catch (e) {
    console.error('❌ 数据迁移失败:', e.message);
    db.close();
    process.exit(1);
  }

  // 验证
  const finalResult = db.exec('SELECT COUNT(*) as count FROM listeners');
  const finalCount = finalResult.length > 0 ? finalResult[0].values[0][0] : 0;
  const newRecords = finalCount - existingCount;

  console.log('=== 迁移完成 ===');
  console.log(`原始 JSON 记录数: ${oldData.length}`);
  console.log(`数据库原有记录: ${existingCount}`);
  console.log(`新增记录数: ${newRecords}`);
  console.log(`数据库总记录数: ${finalCount}\n`);

  // 保存数据库到文件
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_FILE, buffer);
  console.log('✓ 数据库已保存到文件\n');

  // 备份旧文件
  const backupFile = `${OLD_JSON_FILE}.backup-${Date.now()}`;
  console.log(`💾 备份旧文件到 ${backupFile}`);
  fs.copyFileSync(OLD_JSON_FILE, backupFile);
  console.log('✓ 备份完成');

  console.log('\n提示: 可以安全删除 listeners_data.json 文件，已备份为 .backup 文件');
  console.log('现在可以运行 npm start 启动服务\n');

  db.close();
}

migrate().catch(console.error);
