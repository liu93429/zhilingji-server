const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const dbDir = fs.existsSync('/app/data') ? '/app/data' : __dirname;
const dbPath = process.env.VERCEL
  ? path.join('/tmp', 'data.db')
  : path.join(dbDir, 'data.db');
let db = null;
let tcbApp = null;
let backupTimer = null;
let cloudDbFileId = null;
const BACKUP_CLOUD_PATH = 'backup/data.db';
const FILEID_PATH = '/tmp/cloud_db_fileid.txt';

// 初始化腾讯云SDK
function initTcb() {
  try {
    const tcb = require('@cloudbase/node-sdk');
    const envId = process.env.TCB_ENV || 'cloud1-d6gjzpj2l68ef2bce';
    if (!envId) return null;
    tcbApp = tcb.init({ env: envId });
    console.log('腾讯云SDK初始化成功，环境: ' + envId);
    // 尝试从本地文件恢复 fileID
    try {
      if (fs.existsSync(FILEID_PATH)) {
        cloudDbFileId = fs.readFileSync(FILEID_PATH, 'utf8').trim();
        console.log('从缓存恢复 fileID: ' + cloudDbFileId);
      }
    } catch(e) {}
    return tcbApp;
  } catch (e) {
    console.log('腾讯云SDK未安装，跳过云存储备份');
    return null;
  }
}

// 从云存储下载数据库备份
async function downloadBackup() {
  if (!tcbApp || !cloudDbFileId) return false;
  try {
    const tempPath = dbPath + '.tmp';
    await tcbApp.downloadFile({
      fileID: cloudDbFileId,
      tempFilePath: tempPath
    });
    if (fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0) {
      fs.renameSync(tempPath, dbPath);
      console.log('从云存储恢复数据库成功');
      return true;
    }
    return false;
  } catch (e) {
    console.log('云存储下载备份失败（可能首次运行）: ' + e.message);
    return false;
  }
}

// 上传数据库备份到云存储
async function uploadBackup() {
  if (!tcbApp) return;
  try {
    if (!fs.existsSync(dbPath)) return;
    const buffer = fs.readFileSync(dbPath);
    const result = await tcbApp.uploadFile({ cloudPath: BACKUP_CLOUD_PATH, fileContent: buffer });
    if (result && result.fileID) {
      cloudDbFileId = result.fileID;
      // 缓存 fileID 到本地
      try { fs.writeFileSync(FILEID_PATH, cloudDbFileId); } catch(e) {}
      console.log('数据库已备份到云存储，大小: ' + buffer.length);
    }
  } catch (e) {
    console.log('云存储上传备份失败:', e.message);
  }
}

async function initDatabase() {
  // 初始化腾讯云SDK
  initTcb();

  // 尝试从云存储恢复数据库
  const restored = await downloadBackup();

  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // 创建所有表
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      openid TEXT UNIQUE NOT NULL,
      nickname TEXT DEFAULT '指令集用户',
      avatar TEXT DEFAULT '',
      credits INTEGER DEFAULT 0,
      total_earned INTEGER DEFAULT 10,
      total_spent INTEGER DEFAULT 0,
      inviter_openid TEXT DEFAULT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      content TEXT NOT NULL,
      category TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      cover TEXT DEFAULT '',
      images TEXT DEFAULT '[]',
      copy_count INTEGER DEFAULT 0,
      ad_unlock_count INTEGER DEFAULT 0,
      view_count INTEGER DEFAULT 0,
      is_top INTEGER DEFAULT 0,
      weight REAL DEFAULT 1.0,
      is_recommended INTEGER DEFAULT 0,
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS purchased (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_openid TEXT NOT NULL,
      prompt_id INTEGER NOT NULL,
      purchase_method TEXT DEFAULT 'credits',
      purchased_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_openid, prompt_id)
    );

    CREATE TABLE IF NOT EXISTS favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_openid TEXT NOT NULL,
      prompt_id INTEGER NOT NULL,
      folder_id TEXT DEFAULT 'default',
      favorited_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_openid, prompt_id)
    );

    CREATE TABLE IF NOT EXISTS favorite_folders (
      id TEXT PRIMARY KEY,
      user_openid TEXT NOT NULL,
      name TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_openid TEXT NOT NULL,
      checkin_date TEXT NOT NULL,
      streak INTEGER DEFAULT 0,
      reward INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_openid, checkin_date)
    );

    CREATE TABLE IF NOT EXISTS credits_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_openid TEXT NOT NULL,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      reason TEXT DEFAULT '',
      detail TEXT DEFAULT '',
      balance INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ad_watches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_openid TEXT NOT NULL,
      watch_date TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_openid, watch_date)
    );

    CREATE TABLE IF NOT EXISTS share_rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_openid TEXT NOT NULL,
      reward_date TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_openid, reward_date)
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_openid TEXT NOT NULL,
      content TEXT NOT NULL,
      status INTEGER DEFAULT 0,
      reply TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS banners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      subtitle TEXT DEFAULT '',
      image TEXT DEFAULT '',
      link_type TEXT DEFAULT 'none',
      link_param TEXT DEFAULT '',
      gradient_start TEXT DEFAULT '#FF6B9D',
      gradient_end TEXT DEFAULT '#C4B5FD',
      sort INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const promptCount = prepare('SELECT COUNT(*) as count FROM prompts').get().count;
  if (promptCount === 0) {
    const samplePrompts = [
      {
        title: '仙气古风写真',
        description: '柔光古风妆容，汉服造型，水墨背景虚化',
        content: '生成一张仙气飘飘的古风写真，人物身穿白色汉服，手持折扇，背景为云雾缭绕的山水画卷，柔和光影，高清质感，8K分辨率',
        category: '人像写真',
        tags: JSON.stringify(['古风', '仙女', '汉服']),
        cover: 'https://picsum.photos/seed/gufeng/800/600',
        images: JSON.stringify([
          'https://picsum.photos/seed/gufeng/800/600',
          'https://picsum.photos/seed/gufeng2/800/600'
        ]),
        copyCount: 1280,
        adUnlockCount: 356,
        viewCount: 5600,
        isTop: 0,
        weight: 1,
        isRecommended: 1,
        createdAt: '2026-06-25'
      },
      {
        title: '职场精英证件照',
        description: '专业商务妆容，柔和正面光线，灰蓝色背景',
        content: '专业职业证件照，职场精英形象，精致商务妆容，正面柔和打光，纯净灰蓝色背景，西装革履，自信微笑',
        category: '人像写真',
        tags: JSON.stringify(['证件照', '商务', '职场']),
        cover: 'https://picsum.photos/seed/zhengjian/800/600',
        images: JSON.stringify([
          'https://picsum.photos/seed/zhengjian/800/600'
        ]),
        copyCount: 892,
        adUnlockCount: 234,
        viewCount: 3200,
        isTop: 1,
        weight: 1.5,
        isRecommended: 1,
        createdAt: '2026-06-26'
      },
      {
        title: '梦幻二次元少女',
        description: '日系动漫风格，梦幻光影，精致二次元美少女',
        content: '梦幻二次元美少女，日系动漫风格，精致大眼睛，樱花粉色长发，可爱表情，梦幻光影效果',
        category: '创意艺术',
        tags: JSON.stringify(['二次元', '动漫', '梦幻']),
        cover: 'https://picsum.photos/seed/erciyuan/800/600',
        images: JSON.stringify([
          'https://picsum.photos/seed/erciyuan/800/600',
          'https://picsum.photos/seed/erciyuan2/800/600'
        ]),
        copyCount: 2560,
        adUnlockCount: 678,
        viewCount: 8900,
        isTop: 0,
        weight: 1.2,
        isRecommended: 1,
        createdAt: '2026-06-24'
      },
      {
        title: '赛博朋克霓虹',
        description: '未来科幻风格，霓虹灯光映射，机械义体元素',
        content: '赛博朋克风格人像，未来科幻都市背景，霓虹灯光映射，机械义体元素，暗色调科幻城市',
        category: '创意艺术',
        tags: JSON.stringify(['赛博朋克', '夜景', '科幻']),
        cover: 'https://picsum.photos/seed/saibo/800/600',
        images: JSON.stringify([
          'https://picsum.photos/seed/saibo/800/600',
          'https://picsum.photos/seed/saibo2/800/600'
        ]),
        copyCount: 3120,
        adUnlockCount: 890,
        viewCount: 12000,
        isTop: 0,
        weight: 1.3,
        isRecommended: 1,
        createdAt: '2026-06-22'
      },
      {
        title: '山川湖海风景',
        description: '壮丽自然风光，山川湖海，大气磅礴',
        content: '壮丽自然风光摄影，山川湖海交相辉映，日出时分的金色光芒，云海翻涌，镜面般的湖水倒影',
        category: '风景',
        tags: JSON.stringify(['风景', '自然', '山川']),
        cover: 'https://picsum.photos/seed/fengjing/800/600',
        images: JSON.stringify([
          'https://picsum.photos/seed/fengjing/800/600'
        ]),
        copyCount: 2100,
        adUnlockCount: 612,
        viewCount: 7800,
        isTop: 0,
        weight: 1,
        isRecommended: 0,
        createdAt: '2026-06-19'
      },
      {
        title: '复古胶片港风',
        description: '经典港式复古滤镜，温暖颗粒质感，怀旧色调',
        content: '复古港风写真，经典港式复古滤镜，温暖颗粒质感，怀旧色调，街头随性拍摄，90年代港星风格',
        category: '复古胶片',
        tags: JSON.stringify(['复古', '港风', '胶片']),
        cover: 'https://picsum.photos/seed/gangfeng/800/600',
        images: JSON.stringify([
          'https://picsum.photos/seed/gangfeng/800/600'
        ]),
        copyCount: 1450,
        adUnlockCount: 423,
        viewCount: 4500,
        isTop: 0,
        weight: 1.1,
        isRecommended: 1,
        createdAt: '2026-06-20'
      }
    ];

    for (const p of samplePrompts) {
      prepare(`
        INSERT INTO prompts (title, description, content, category, tags, cover, images, copy_count, ad_unlock_count, view_count, is_top, weight, is_recommended, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        p.title, p.description, p.content, p.category, p.tags,
        p.cover, p.images, p.copyCount, p.adUnlockCount, p.viewCount,
        p.isTop, p.weight, p.isRecommended, p.createdAt
      );
    }
  }

  const adminCount = prepare('SELECT COUNT(*) as count FROM admin_users').get().count;
  if (adminCount === 0) {
    prepare('INSERT INTO admin_users (username, password) VALUES (?, ?)').run('admin', 'admin123');
  }

  const bannerCount = prepare('SELECT COUNT(*) as count FROM banners').get().count;
  if (bannerCount === 0) {
    const seedBanners = [
      { title: '会员专属权益', subtitle: '解锁更多精品指令与专属特权', image: '', linkType: 'vip', linkParam: '', gradientStart: '#FF6B9D', gradientEnd: '#C4B5FD', sort: 0 },
      { title: '邀请好友赚积分', subtitle: '每成功邀请一位好友即可获得 +1 积分', image: '', linkType: 'invite', linkParam: '', gradientStart: '#FDA4AF', gradientEnd: '#86E3CE', sort: 1 },
      { title: '积分获取与使用规则', subtitle: '签到、分享都能赚积分', image: '', linkType: 'credits', linkParam: '', gradientStart: '#C4B5FD', gradientEnd: '#93C5FD', sort: 2 }
    ];
    for (const b of seedBanners) {
      prepare(`INSERT INTO banners (title, subtitle, image, link_type, link_param, gradient_start, gradient_end, sort, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`).run(
        b.title, b.subtitle, b.image, b.linkType, b.linkParam, b.gradientStart, b.gradientEnd, b.sort
      );
    }
  }

  saveDatabase();
  console.log('数据库初始化完成');

  // 每60秒自动备份到云存储
  if (tcbApp) {
    backupTimer = setInterval(() => uploadBackup(), 60000);
    console.log('云存储自动备份已启动（每60秒）');
  }
}

function saveDatabase() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
  // 防抖备份：清除旧定时器，30秒后备份
  if (tcbApp) {
    if (backupTimer) clearTimeout(backupTimer);
    backupTimer = setTimeout(() => uploadBackup(), 30000);
  }
}

function prepare(sql) {
  return {
    get(...params) {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row;
      }
      stmt.free();
      return undefined;
    },
    all(...params) {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      const results = [];
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      stmt.free();
      return results;
    },
    run(...params) {
      db.run(sql, params);
      saveDatabase();
      try {
        const lastId = db.exec('SELECT last_insert_rowid()');
        return {
          lastInsertRowid: (lastId && lastId[0] && lastId[0].values && lastId[0].values[0]) ? lastId[0].values[0][0] : 0,
          changes: 1
        };
      } catch (e) {
        return { lastInsertRowid: 0, changes: 1 };
      }
    }
  };
}

const originalDb = {
  exec(sql) {
    db.exec(sql);
    saveDatabase();
  },
  prepare
};

function initDb() {
  return initDatabase();
}

module.exports = {
  db: originalDb,
  initDb
};
