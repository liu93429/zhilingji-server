const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { db, initDb } = require('./db.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use('/admin', express.static(__dirname + '/admin'));

function getToday() {
  return new Date().toISOString().split('T')[0];
}

function getUserByOpenid(openid) {
  return db.prepare('SELECT * FROM users WHERE openid = ?').get(openid);
}

function createUser(openid) {
  const stmt = db.prepare(`
    INSERT INTO users (openid, nickname, credits, total_earned, total_spent)
    VALUES (?, '指令集用户', 0, 0, 0)
  `);
  stmt.run(openid);
  return getUserByOpenid(openid);
}

function getOrCreateUser(openid) {
  let user = getUserByOpenid(openid);
  if (!user) {
    user = createUser(openid);
    const defaultFolder = db.prepare(`
      INSERT OR IGNORE INTO favorite_folders (id, user_openid, name, count)
      VALUES ('default', ?, '默认收藏夹', 0)
    `);
    defaultFolder.run(openid);
  }
  return user;
}

function addCreditsLog(openid, type, amount, reason, detail, balance) {
  db.prepare(`
    INSERT INTO credits_log (user_openid, type, amount, reason, detail, balance)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(openid, type, amount, reason, detail, balance);
}

function updateUserCredits(openid, amount, type, reason, detail) {
  const user = getOrCreateUser(openid);
  const newCredits = user.credits + amount;
  
  let totalEarned = user.total_earned;
  let totalSpent = user.total_spent;
  
  if (amount > 0) {
    totalEarned += amount;
  } else {
    totalSpent += Math.abs(amount);
  }
  
  db.prepare(`
    UPDATE users 
    SET credits = ?, total_earned = ?, total_spent = ?, updated_at = CURRENT_TIMESTAMP
    WHERE openid = ?
  `).run(newCredits, totalEarned, totalSpent, openid);
  
  addCreditsLog(openid, type, Math.abs(amount), reason, detail, newCredits);
  
  return newCredits;
}

app.post('/api/user/login', (req, res) => {
  const { code } = req.body;
  
  const mockOpenid = 'openid_' + (code || Math.random().toString(36).substr(2, 10));
  const user = getOrCreateUser(mockOpenid);
  
  res.json({
    code: 0,
    data: {
      openid: mockOpenid,
      userInfo: {
        nickname: user.nickname,
        avatar: user.avatar,
        credits: user.credits
      }
    }
  });
});

app.get('/api/user/info', (req, res) => {
  const openid = req.headers.authorization;
  if (!openid) {
    return res.json({ code: 1, message: '未登录' });
  }
  
  const user = getOrCreateUser(openid);
  res.json({
    code: 0,
    data: user
  });
});

app.put('/api/user/info', (req, res) => {
  const openid = req.headers.authorization;
  if (!openid) {
    return res.json({ code: 1, message: '未登录' });
  }
  
  const { nickname, avatar } = req.body;
  const fields = [];
  const values = [];
  
  if (nickname !== undefined) {
    fields.push('nickname = ?');
    values.push(nickname);
  }
  if (avatar !== undefined) {
    fields.push('avatar = ?');
    values.push(avatar);
  }
  
  if (fields.length > 0) {
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(openid);
    db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE openid = ?`).run(...values);
  }
  
  const user = getUserByOpenid(openid);
  res.json({
    code: 0,
    data: user
  });
});

app.get('/api/prompts', (req, res) => {
  const { category = 'all', keyword = '', sortBy = 'time', limit, page = 1, pageSize = 20 } = req.query;
  
  let sql = 'SELECT * FROM prompts WHERE status = 1';
  let params = [];
  
  if (category !== 'all') {
    sql += ' AND category = ?';
    params.push(category);
  }
  
  if (keyword) {
    sql += ' AND (title LIKE ? OR description LIKE ? OR tags LIKE ?)';
    const kw = '%' + keyword + '%';
    params.push(kw, kw, kw);
  }
  
  if (sortBy === 'hot') {
    sql += ' ORDER BY is_top DESC, (copy_count * weight) DESC';
  } else {
    sql += ' ORDER BY is_top DESC, created_at DESC';
  }
  
  const offset = (page - 1) * pageSize;
  sql += ' LIMIT ? OFFSET ?';
  params.push(parseInt(pageSize), parseInt(offset));
  
  const prompts = db.prepare(sql).all(...params).map(p => ({
    ...p,
    tags: JSON.parse(p.tags || '[]'),
    images: JSON.parse(p.images || '[]')
  }));
  
  const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total').split(' ORDER BY')[0].split(' LIMIT')[0];
  const total = db.prepare(countSql).get(...params.slice(0, params.length - 2)).total;
  
  res.json({
    code: 0,
    data: {
      list: prompts,
      total,
      page: parseInt(page),
      pageSize: parseInt(pageSize)
    }
  });
});

app.get('/api/prompts/hot', (req, res) => {
  const { timeRange = 'all' } = req.query;
  
  let sql = 'SELECT * FROM prompts WHERE status = 1';
  let params = [];
  
  if (timeRange === 'week') {
    sql += ' AND created_at >= date("now", "-7 days")';
  } else if (timeRange === 'month') {
    sql += ' AND created_at >= date("now", "-30 days")';
  }
  
  sql += ' ORDER BY is_top DESC, (copy_count * weight) DESC LIMIT 50';
  
  const prompts = db.prepare(sql).all(...params).map(p => ({
    ...p,
    tags: JSON.parse(p.tags || '[]'),
    images: JSON.parse(p.images || '[]')
  }));
  
  res.json({
    code: 0,
    data: prompts
  });
});

app.get('/api/prompts/recommended', (req, res) => {
  const prompts = db.prepare(`
    SELECT * FROM prompts 
    WHERE status = 1 AND is_recommended = 1 
    ORDER BY is_top DESC, created_at DESC 
    LIMIT 10
  `).all().map(p => ({
    ...p,
    tags: JSON.parse(p.tags || '[]'),
    images: JSON.parse(p.images || '[]')
  }));
  
  res.json({
    code: 0,
    data: prompts
  });
});

app.get('/api/prompts/:id', (req, res) => {
  const { id } = req.params;
  const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(id);
  
  if (!prompt) {
    return res.json({ code: 1, message: '指令不存在' });
  }
  
  db.prepare('UPDATE prompts SET view_count = view_count + 1 WHERE id = ?').run(id);
  
  prompt.tags = JSON.parse(prompt.tags || '[]');
  prompt.images = JSON.parse(prompt.images || '[]');
  
  res.json({
    code: 0,
    data: prompt
  });
});

app.post('/api/prompts/:id/copy', (req, res) => {
  const openid = req.headers.authorization;
  const { id } = req.params;
  
  if (!openid) {
    return res.json({ code: 1, message: '未登录' });
  }
  
  const user = getOrCreateUser(openid);
  const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(id);
  
  if (!prompt) {
    return res.json({ code: 1, message: '指令不存在' });
  }
  
  const existing = db.prepare('SELECT * FROM purchased WHERE user_openid = ? AND prompt_id = ?').get(openid, id);
  if (existing) {
    return res.json({
      code: 0,
      data: {
        ...prompt,
        tags: JSON.parse(prompt.tags || '[]'),
        images: JSON.parse(prompt.images || '[]'),
        alreadyOwned: true
      }
    });
  }
  
  if (user.credits < 1) {
    return res.json({ code: 2, message: '积分不足' });
  }
  
  updateUserCredits(openid, -1, 'spend', '复制指令', prompt.title);
  
  db.prepare('INSERT INTO purchased (user_openid, prompt_id, purchase_method) VALUES (?, ?, ?)').run(openid, id, 'credits');
  db.prepare('UPDATE prompts SET copy_count = copy_count + 1 WHERE id = ?').run(id);
  
  const updatedPrompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(id);
  updatedPrompt.tags = JSON.parse(updatedPrompt.tags || '[]');
  updatedPrompt.images = JSON.parse(updatedPrompt.images || '[]');
  
  res.json({
    code: 0,
    data: updatedPrompt
  });
});

app.post('/api/prompts/:id/ad-unlock', (req, res) => {
  const openid = req.headers.authorization;
  const { id } = req.params;
  
  if (!openid) {
    return res.json({ code: 1, message: '未登录' });
  }
  
  getOrCreateUser(openid);
  const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(id);
  
  if (!prompt) {
    return res.json({ code: 1, message: '指令不存在' });
  }
  
  const existing = db.prepare('SELECT * FROM purchased WHERE user_openid = ? AND prompt_id = ?').get(openid, id);
  if (existing) {
    return res.json({
      code: 0,
      data: {
        ...prompt,
        tags: JSON.parse(prompt.tags || '[]'),
        images: JSON.parse(prompt.images || '[]'),
        alreadyOwned: true
      }
    });
  }
  
  db.prepare('INSERT INTO purchased (user_openid, prompt_id, purchase_method) VALUES (?, ?, ?)').run(openid, id, 'ad');
  db.prepare('UPDATE prompts SET ad_unlock_count = ad_unlock_count + 1, copy_count = copy_count + 1 WHERE id = ?').run(id);
  
  const updatedPrompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(id);
  updatedPrompt.tags = JSON.parse(updatedPrompt.tags || '[]');
  updatedPrompt.images = JSON.parse(updatedPrompt.images || '[]');
  
  res.json({
    code: 0,
    data: updatedPrompt
  });
});

app.get('/api/purchased', (req, res) => {
  const openid = req.headers.authorization;
  if (!openid) {
    return res.json({ code: 1, message: '未登录' });
  }
  
  getOrCreateUser(openid);
  
  const purchased = db.prepare(`
    SELECT p.*, pur.purchased_at, pur.purchase_method 
    FROM purchased pur 
    JOIN prompts p ON pur.prompt_id = p.id 
    WHERE pur.user_openid = ? 
    ORDER BY pur.purchased_at DESC
  `).all(openid).map(p => ({
    ...p,
    tags: JSON.parse(p.tags || '[]'),
    images: JSON.parse(p.images || '[]')
  }));
  
  res.json({
    code: 0,
    data: purchased
  });
});

app.get('/api/favorites', (req, res) => {
  const openid = req.headers.authorization;
  const { folderId = 'default' } = req.query;
  
  if (!openid) {
    return res.json({ code: 1, message: '未登录' });
  }
  
  getOrCreateUser(openid);
  
  const favorites = db.prepare(`
    SELECT p.*, f.favorited_at 
    FROM favorites f 
    JOIN prompts p ON f.prompt_id = p.id 
    WHERE f.user_openid = ? AND f.folder_id = ?
    ORDER BY f.favorited_at DESC
  `).all(openid, folderId).map(p => ({
    ...p,
    tags: JSON.parse(p.tags || '[]'),
    images: JSON.parse(p.images || '[]')
  }));
  
  res.json({
    code: 0,
    data: favorites
  });
});

app.get('/api/favorites/folders', (req, res) => {
  const openid = req.headers.authorization;
  if (!openid) {
    return res.json({ code: 1, message: '未登录' });
  }
  
  getOrCreateUser(openid);
  
  const folders = db.prepare('SELECT * FROM favorite_folders WHERE user_openid = ? ORDER BY created_at').all(openid);
  
  res.json({
    code: 0,
    data: folders
  });
});

app.post('/api/favorites/toggle', (req, res) => {
  const openid = req.headers.authorization;
  const { promptId, folderId = 'default' } = req.body;
  
  if (!openid) {
    return res.json({ code: 1, message: '未登录' });
  }
  
  getOrCreateUser(openid);
  
  const existing = db.prepare('SELECT * FROM favorites WHERE user_openid = ? AND prompt_id = ?').get(openid, promptId);
  
  if (existing) {
    db.prepare('DELETE FROM favorites WHERE user_openid = ? AND prompt_id = ?').run(openid, promptId);
    db.prepare('UPDATE favorite_folders SET count = count - 1 WHERE user_openid = ? AND id = ?').run(openid, existing.folder_id);
    res.json({ code: 0, data: { isFavorited: false } });
  } else {
    db.prepare('INSERT INTO favorites (user_openid, prompt_id, folder_id) VALUES (?, ?, ?)').run(openid, promptId, folderId);
    db.prepare('UPDATE favorite_folders SET count = count + 1 WHERE user_openid = ? AND id = ?').run(openid, folderId);
    res.json({ code: 0, data: { isFavorited: true } });
  }
});

app.post('/api/favorites/folder', (req, res) => {
  const openid = req.headers.authorization;
  const { name } = req.body;
  
  if (!openid) {
    return res.json({ code: 1, message: '未登录' });
  }
  
  getOrCreateUser(openid);
  
  const folderId = 'folder_' + Date.now();
  db.prepare('INSERT INTO favorite_folders (id, user_openid, name, count) VALUES (?, ?, ?, 0)').run(folderId, openid, name);
  
  const folder = db.prepare('SELECT * FROM favorite_folders WHERE id = ?').get(folderId);
  res.json({ code: 0, data: folder });
});

app.put('/api/favorites/folder/:id', (req, res) => {
  const openid = req.headers.authorization;
  const { id } = req.params;
  const { name } = req.body;
  
  if (!openid) {
    return res.json({ code: 1, message: '未登录' });
  }
  
  db.prepare('UPDATE favorite_folders SET name = ? WHERE id = ? AND user_openid = ?').run(name, id, openid);
  const folder = db.prepare('SELECT * FROM favorite_folders WHERE id = ?').get(id);
  
  res.json({ code: 0, data: folder });
});

app.delete('/api/favorites/folder/:id', (req, res) => {
  const openid = req.headers.authorization;
  const { id } = req.params;
  
  if (!openid) {
    return res.json({ code: 1, message: '未登录' });
  }
  
  if (id === 'default') {
    return res.json({ code: 1, message: '默认收藏夹不能删除' });
  }
  
  const folder = db.prepare('SELECT * FROM favorite_folders WHERE id = ? AND user_openid = ?').get(id, openid);
  if (!folder) {
    return res.json({ code: 1, message: '收藏夹不存在' });
  }
  
  db.prepare('UPDATE favorites SET folder_id = ? WHERE user_openid = ? AND folder_id = ?').run('default', openid, id);
  db.prepare('UPDATE favorite_folders SET count = count + ? WHERE id = ? AND user_openid = ?').run(folder.count, 'default', openid);
  db.prepare('DELETE FROM favorite_folders WHERE id = ? AND user_openid = ?').run(id, openid);
  
  res.json({ code: 0, data: { success: true } });
});

app.get('/api/checkin/status', (req, res) => {
  const openid = req.headers.authorization;
  if (!openid) {
    return res.json({ code: 1, message: '未登录' });
  }
  
  getOrCreateUser(openid);
  
  const today = getToday();
  const todayCheckin = db.prepare('SELECT * FROM checkins WHERE user_openid = ? AND checkin_date = ?').get(openid, today);
  
  const weekCheckins = db.prepare(`
    SELECT checkin_date FROM checkins 
    WHERE user_openid = ? AND checkin_date >= date("now", "weekday 0", "-6 days")
    ORDER BY checkin_date
  `).all(openid).map(c => c.checkin_date);
  
  let streak = 0;
  let checkDate = new Date();
  while (true) {
    const dateStr = checkDate.toISOString().split('T')[0];
    const checked = db.prepare('SELECT 1 FROM checkins WHERE user_openid = ? AND checkin_date = ?').get(openid, dateStr);
    if (checked) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }
  
  res.json({
    code: 0,
    data: {
      canCheckin: !todayCheckin,
      streak,
      weekCheckins,
      todayChecked: !!todayCheckin
    }
  });
});

app.post('/api/checkin', (req, res) => {
  const openid = req.headers.authorization;
  if (!openid) {
    return res.json({ code: 1, message: '未登录' });
  }
  
  getOrCreateUser(openid);
  
  const today = getToday();
  const existing = db.prepare('SELECT * FROM checkins WHERE user_openid = ? AND checkin_date = ?').get(openid, today);
  
  if (existing) {
    return res.json({ code: 1, message: '今日已签到' });
  }
  
  let streak = 1;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];
  const yCheckin = db.prepare('SELECT * FROM checkins WHERE user_openid = ? AND checkin_date = ?').get(openid, yesterdayStr);
  if (yCheckin) {
    streak = yCheckin.streak + 1;
  }
  
  const weekCheckins = db.prepare(`
    SELECT checkin_date FROM checkins 
    WHERE user_openid = ? AND checkin_date >= date("now", "weekday 0", "-6 days")
  `).all(openid);
  
  let reward = 1;
  if (weekCheckins.length >= 6) {
    reward = 3;
  }
  
  db.prepare('INSERT INTO checkins (user_openid, checkin_date, streak, reward) VALUES (?, ?, ?, ?)').run(openid, today, streak, reward);
  
  const newCredits = updateUserCredits(openid, reward, 'earn', '签到', `连续签到${streak}天`);
  
  res.json({
    code: 0,
    data: {
      success: true,
      reward,
      streak,
      newCredits
    }
  });
});

app.get('/api/ad/status', (req, res) => {
  const openid = req.headers.authorization;
  if (!openid) {
    return res.json({ code: 1, message: '未登录' });
  }
  
  getOrCreateUser(openid);
  
  const today = getToday();
  const watchData = db.prepare('SELECT * FROM ad_watches WHERE user_openid = ? AND watch_date = ?').get(openid, today);
  
  res.json({
    code: 0,
    data: {
      count: watchData ? watchData.count : 0,
      maxCount: 10,
      canWatch: !watchData || watchData.count < 10
    }
  });
});

app.post('/api/ad/watch', (req, res) => {
  const openid = req.headers.authorization;
  if (!openid) {
    return res.json({ code: 1, message: '未登录' });
  }
  
  getOrCreateUser(openid);
  
  const today = getToday();
  const watchData = db.prepare('SELECT * FROM ad_watches WHERE user_openid = ? AND watch_date = ?').get(openid, today);
  
  if (watchData && watchData.count >= 10) {
    return res.json({ code: 1, message: '今日广告次数已用完' });
  }
  
  if (watchData) {
    db.prepare('UPDATE ad_watches SET count = count + 1 WHERE id = ?').run(watchData.id);
  } else {
    db.prepare('INSERT INTO ad_watches (user_openid, watch_date, count) VALUES (?, ?, 1)').run(openid, today);
  }
  
  const newCredits = updateUserCredits(openid, 1, 'earn', '观看广告', `第${(watchData ? watchData.count : 0) + 1}次`);
  const remaining = 10 - ((watchData ? watchData.count : 0) + 1);
  
  res.json({
    code: 0,
    data: {
      success: true,
      newCredits,
      remaining
    }
  });
});

app.get('/api/credits/log', (req, res) => {
  const openid = req.headers.authorization;
  const { page = 1, pageSize = 20 } = req.query;
  
  if (!openid) {
    return res.json({ code: 1, message: '未登录' });
  }
  
  getOrCreateUser(openid);
  
  const offset = (page - 1) * pageSize;
  const logs = db.prepare(`
    SELECT * FROM credits_log 
    WHERE user_openid = ? 
    ORDER BY created_at DESC 
    LIMIT ? OFFSET ?
  `).all(openid, parseInt(pageSize), parseInt(offset));
  
  const total = db.prepare('SELECT COUNT(*) as total FROM credits_log WHERE user_openid = ?').get(openid).total;
  
  res.json({
    code: 0,
    data: {
      list: logs,
      total,
      page: parseInt(page),
      pageSize: parseInt(pageSize)
    }
  });
});

app.post('/api/share/reward', (req, res) => {
  const openid = req.headers.authorization;
  const { friendOpenid } = req.body;
  
  if (!openid || !friendOpenid) {
    return res.json({ code: 1, message: '参数错误' });
  }
  
  const friend = getUserByOpenid(friendOpenid);
  if (!friend) {
    return res.json({ code: 1, message: '好友不存在' });
  }
  
  if (friend.inviter_openid) {
    return res.json({ code: 1, message: '该好友已被邀请过' });
  }
  
  const today = getToday();
  const shareData = db.prepare('SELECT * FROM share_rewards WHERE user_openid = ? AND reward_date = ?').get(openid, today);
  
  if (shareData && shareData.count >= 10) {
    return res.json({ code: 1, message: '今日分享奖励已达上限' });
  }
  
  db.prepare('UPDATE users SET inviter_openid = ? WHERE openid = ?').run(openid, friendOpenid);
  
  if (shareData) {
    db.prepare('UPDATE share_rewards SET count = count + 1 WHERE id = ?').run(shareData.id);
  } else {
    db.prepare('INSERT INTO share_rewards (user_openid, reward_date, count) VALUES (?, ?, 1)').run(openid, today);
  }
  
  const newCredits = updateUserCredits(openid, 1, 'earn', '邀请好友', `好友ID: ${friendOpenid}`);
  
  res.json({
    code: 0,
    data: {
      success: true,
      newCredits
    }
  });
});

app.post('/api/feedback', (req, res) => {
  const openid = req.headers.authorization;
  const { content } = req.body;
  
  if (!openid || !content) {
    return res.json({ code: 1, message: '参数错误' });
  }
  
  getOrCreateUser(openid);
  
  db.prepare('INSERT INTO feedback (user_openid, content) VALUES (?, ?)').run(openid, content);
  
  res.json({
    code: 0,
    data: { success: true }
  });
});

app.get('/api/admin/stats', (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const todayUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE created_at >= date("now")').get().count;
  const totalPrompts = db.prepare('SELECT COUNT(*) as count FROM prompts WHERE status = 1').get().count;
  const todayCopies = db.prepare('SELECT COUNT(*) as count FROM purchased WHERE DATE(purchased_at) = date("now")').get().count;
  const totalCopies = db.prepare('SELECT SUM(copy_count) as total FROM prompts').get().total || 0;
  const totalAdUnlocks = db.prepare('SELECT SUM(ad_unlock_count) as total FROM prompts').get().total || 0;
  
  res.json({
    code: 0,
    data: {
      totalUsers,
      todayUsers,
      totalPrompts,
      todayCopies,
      totalCopies,
      totalAdUnlocks
    }
  });
});

app.get('/api/admin/users', (req, res) => {
  const { page = 1, pageSize = 20, keyword = '' } = req.query;
  const offset = (page - 1) * pageSize;
  
  let sql = 'SELECT * FROM users';
  let countSql = 'SELECT COUNT(*) as total FROM users';
  let params = [];
  
  if (keyword) {
    sql += ' WHERE nickname LIKE ? OR openid LIKE ?';
    countSql += ' WHERE nickname LIKE ? OR openid LIKE ?';
    const kw = '%' + keyword + '%';
    params.push(kw, kw);
  }
  
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  const countParams = [...params];
  params.push(parseInt(pageSize), parseInt(offset));
  
  const users = db.prepare(sql).all(...params);
  const total = db.prepare(countSql).get(...countParams).total;
  
  res.json({
    code: 0,
    data: {
      list: users,
      total,
      page: parseInt(page),
      pageSize: parseInt(pageSize)
    }
  });
});

app.get('/api/admin/prompts', (req, res) => {
  const { page = 1, pageSize = 20, keyword = '', category = '' } = req.query;
  const offset = (page - 1) * pageSize;
  
  let sql = 'SELECT * FROM prompts WHERE 1=1';
  let countSql = 'SELECT COUNT(*) as total FROM prompts WHERE 1=1';
  let params = [];
  
  if (keyword) {
    sql += ' AND title LIKE ?';
    countSql += ' AND title LIKE ?';
    params.push('%' + keyword + '%');
  }
  
  if (category) {
    sql += ' AND category = ?';
    countSql += ' AND category = ?';
    params.push(category);
  }
  
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  const countParams = [...params];
  params.push(parseInt(pageSize), parseInt(offset));
  
  const prompts = db.prepare(sql).all(...params).map(p => ({
    ...p,
    tags: JSON.parse(p.tags || '[]'),
    images: JSON.parse(p.images || '[]')
  }));
  const total = db.prepare(countSql).get(...countParams).total;
  
  res.json({
    code: 0,
    data: {
      list: prompts,
      total,
      page: parseInt(page),
      pageSize: parseInt(pageSize)
    }
  });
});

app.post('/api/admin/prompts', (req, res) => {
  const { title, description, content, category, tags = [], cover, images = [], is_top = 0, weight = 1, is_recommended = 0 } = req.body;
  
  if (!title || !content) {
    return res.json({ code: 1, message: '标题和内容不能为空' });
  }
  
  const stmt = db.prepare(`
    INSERT INTO prompts (title, description, content, category, tags, cover, images, is_top, weight, is_recommended)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  const result = stmt.run(
    title,
    description || '',
    content,
    category || '',
    JSON.stringify(tags),
    cover || '',
    JSON.stringify(images),
    is_top ? 1 : 0,
    weight,
    is_recommended ? 1 : 0
  );
  
  res.json({
    code: 0,
    data: { id: result.lastInsertRowid }
  });
});

app.put('/api/admin/prompts/:id', (req, res) => {
  const { id } = req.params;
  const { title, description, content, category, tags, cover, images, is_top, weight, is_recommended, status } = req.body;
  
  const existing = db.prepare('SELECT * FROM prompts WHERE id = ?').get(id);
  if (!existing) {
    return res.json({ code: 1, message: '指令不存在' });
  }
  
  const fields = [];
  const values = [];
  
  if (title !== undefined) { fields.push('title = ?'); values.push(title); }
  if (description !== undefined) { fields.push('description = ?'); values.push(description); }
  if (content !== undefined) { fields.push('content = ?'); values.push(content); }
  if (category !== undefined) { fields.push('category = ?'); values.push(category); }
  if (tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(tags)); }
  if (cover !== undefined) { fields.push('cover = ?'); values.push(cover); }
  if (images !== undefined) { fields.push('images = ?'); values.push(JSON.stringify(images)); }
  if (is_top !== undefined) { fields.push('is_top = ?'); values.push(is_top ? 1 : 0); }
  if (weight !== undefined) { fields.push('weight = ?'); values.push(weight); }
  if (is_recommended !== undefined) { fields.push('is_recommended = ?'); values.push(is_recommended ? 1 : 0); }
  if (status !== undefined) { fields.push('status = ?'); values.push(status); }
  
  fields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);
  
  db.prepare(`UPDATE prompts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  
  res.json({
    code: 0,
    data: { success: true }
  });
});

app.delete('/api/admin/prompts/:id', (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM prompts WHERE id = ?').run(id);
  res.json({ code: 0, data: { success: true } });
});

app.get('/api/admin/feedback', (req, res) => {
  const { page = 1, pageSize = 20 } = req.query;
  const offset = (page - 1) * pageSize;
  
  const feedback = db.prepare(`
    SELECT f.*, u.nickname 
    FROM feedback f 
    LEFT JOIN users u ON f.user_openid = u.openid
    ORDER BY f.created_at DESC 
    LIMIT ? OFFSET ?
  `).all(parseInt(pageSize), parseInt(offset));
  
  const total = db.prepare('SELECT COUNT(*) as total FROM feedback').get().total;
  
  res.json({
    code: 0,
    data: {
      list: feedback,
      total,
      page: parseInt(page),
      pageSize: parseInt(pageSize)
    }
  });
});

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  
  const admin = db.prepare('SELECT * FROM admin_users WHERE username = ? AND password = ?').get(username, password);
  
  if (!admin) {
    return res.json({ code: 1, message: '用户名或密码错误' });
  }
  
  res.json({
    code: 0,
    data: {
      token: 'admin_token_' + Date.now(),
      user: {
        id: admin.id,
        username: admin.username
      }
    }
  });
});

(async () => {
  try {
    await initDb();
    if (process.env.VERCEL) {
      // Vercel serverless 模式
      module.exports = app;
    } else {
      app.listen(PORT, () => {
        console.log(`服务器运行在 http://localhost:${PORT}`);
        console.log(`管理后台: http://localhost:${PORT}/admin`);
      });
    }
  } catch (err) {
    console.error('数据库初始化失败:', err);
    process.exit(1);
  }
})();
