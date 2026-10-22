const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 数据目录：本地默认 ../resources（与 Backend 同级）；Render 上用 DATA_DIR 环境变量指向挂载盘
const RESOURCES_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'resources');

const USERS_FILE = path.join(RESOURCES_DIR, 'users.json');
const MESSAGES_FILE = path.join(RESOURCES_DIR, 'messages.json');
const LOGS_FILE = path.join(RESOURCES_DIR, 'logs.json');
const REPORTS_FILE = path.join(RESOURCES_DIR, 'reports.json');       // 被举报的留言
const RELATIONS_FILE = path.join(RESOURCES_DIR, 'relations.json');   // 关注 / 拉黑
const NOTIF_FILE = path.join(RESOURCES_DIR, 'notifications.json');   // 信箱（被点赞 / 被回复 / 举报结果）
const LIKES_FILE = path.join(RESOURCES_DIR, 'likes.json');           // 留言的赞
const AVATAR_DIR = path.join(RESOURCES_DIR, 'avatars');   // 头像文件都放这个文件夹

// 读写用户
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return []; }
}
function saveUsers(list) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(list, null, 2));
}

// 读写留言
function loadMessages() {
  try { return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8')); }
  catch { return []; }
}
function saveMessages(list) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(list, null, 2));
}

// 读写更新日志（文件里就是「从新到旧」的顺序）
function loadLogs() {
  try { return JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8')); }
  catch { return []; }
}
function saveLogs(list) {
  fs.writeFileSync(LOGS_FILE, JSON.stringify(list, null, 2));
}

// 读写举报（从旧到新，UI 自己倒过来）
function loadReports() {
  try { return JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf8')); }
  catch { return []; }
}
function saveReports(list) {
  fs.writeFileSync(REPORTS_FILE, JSON.stringify(list, null, 2));
}

// 读写关注 / 拉黑。两条记录都是 { from: uid, to: uid, time }
function loadRelations() {
  try {
    const d = JSON.parse(fs.readFileSync(RELATIONS_FILE, 'utf8'));
    return { follows: d.follows || [], blocks: d.blocks || [] };
  } catch {
    return { follows: [], blocks: [] };
  }
}
function saveRelations(r) {
  fs.writeFileSync(RELATIONS_FILE, JSON.stringify({ follows: r.follows, blocks: r.blocks }, null, 2));
}

// 读写点赞。一条记录 = { msgId, uid, time }
function loadLikes() {
  try { return JSON.parse(fs.readFileSync(LIKES_FILE, 'utf8')); }
  catch { return []; }
}
function saveLikes(list) {
  fs.writeFileSync(LIKES_FILE, JSON.stringify(list, null, 2));
}

// 读写信箱。一条消息 = { id, uid(收件人), type, fromUid, fromName, msgId, text, time, read }
// 信箱里的消息分五类（前端也按这五类分栏）：
//   like    = 有人赞了你的留言      -> 我的点赞
//   reply   = 有人回复了你的留言    -> 我的回复
//   mention = 有人在留言里 @ 了你   -> 我的@
//   report  = 你举报的留言出结果了  -> 我的举报
//   system  = 别人举报了你 / 你被删评禁言封号 -> 系统消息
function loadNotifs() {
  try { return JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8')); }
  catch { return []; }
}
function saveNotifs(list) {
  fs.writeFileSync(NOTIF_FILE, JSON.stringify(list, null, 2));
}

// 往信箱塞一条。toUid 拿不到（比如老留言对不上作者）就什么都不做。
function addNotif(toUid, data) {
  if (!toUid) return null;
  const list = loadNotifs();
  const rec = Object.assign({ id: nextId(list), uid: toUid, time: nowTime(), read: false }, data);
  list.push(rec);
  saveNotifs(list.slice(-500));    // 只留最近 500 条，别让文件无限长大
  return rec;
}

// 一条留言的作者 uid（老留言没 uid 就按用户名兜底）
function authorUidOf(msg) {
  const a = authorOf(msg);
  return a ? (a.uid || null) : null;
}

// 从留言正文里找出被 @ 到的人。要按真实用户名单去比对，
// 并且 @cheng 不能把 @chengfa 也算上（后面必须跟空格 / 标点 / 结尾）。
function mentionedUids(text, users, selfUid) {
  const out = [];
  const s = String(text || '');
  users.forEach(u => {
    if (!u.username || u.uid === selfUid) return;
    const needle = '@' + u.username;
    let i = s.indexOf(needle);
    while (i !== -1) {
      const after = s[i + needle.length];
      if (after === undefined || !/[A-Za-z0-9_\u4e00-\u9fa5]/.test(after)) {
        out.push(u.uid);
        break;
      }
      i = s.indexOf(needle, i + 1);
    }
  });
  return out;
}

// 今天的日期，2026-10-02 这种格式
function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// 现在的时间，2026/10/2 12:58:46 这种格式（和留言时间一致）
function nowTime() {
  return new Date().toLocaleString('zh-CN');
}

// 是不是站长 / 管理员
function isAdmin(user) {
  return !!user && (user.role === 'owner' || user.role === 'admin');
}

// ===== 处罚状态 =====
// 封号：什么都不能干（连登录都不行）。返回错误文字，没被封就返回 null。
function banReason(user) {
  return (user && user.banned) ? '账号已被封禁，请联系站长' : null;
}
// 禁言：能登录能看，但不能发言。举报/关注也一起禁掉。
function muteReason(user) {
  if (!user) return '请先登录';
  if (user.banned) return '账号已被封禁，请联系站长';
  if (user.muted) return '你已被禁言，暂时不能发言';
  return null;
}

// 找一条留言的作者：优先按 uid，老留言没 uid 就按用户名对。
// 有这个，早期那几条没 uid 的留言也能被禁言 / 封号。
function authorOf(msg) {
  if (!msg) return null;
  const users = loadUsers();
  if (msg.uid != null) {
    const u = users.find(x => x.uid === msg.uid);
    if (u) return u;
  }
  return users.find(x => x.username === msg.name) || null;
}

// 支持的图片格式
const IMG_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

// users.json 里只存头像文件名（比如 uid1.jpg），这里拼成完整网址给前端用。
// 域名从请求头取，所以本地是 localhost、线上是 api.chengfa.dpdns.org，不用写死。
function avatarUrl(req, file) {
  if (!file) return null;
  if (/^data:image\//.test(file)) return file;      // 万一是没搬完的老格式，直接原样返回
  const host = req.headers.host || 'localhost:3000';
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() || 'http';
  let v = '';
  try { v = '?v=' + Math.floor(fs.statSync(path.join(AVATAR_DIR, file)).mtimeMs); } catch {}
  return proto + '://' + host + '/avatar/' + encodeURIComponent(file) + v;
}

// 密码哈希
function hash(pwd) {
  return crypto.createHash('sha256').update(pwd).digest('hex');
}

// 生成 token
function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

// 从请求里读 body。带硬上限，免得有人一口气丢几百 MB 上来把内存吃光
const BODY_LIMIT = 120 * 1024 * 1024;   // 120MB，够传一个 80MB 视频的 base64
function readBody(req) {
  return new Promise(resolve => {
    const len = parseInt(req.headers['content-length'] || '0', 10);
    if (len > BODY_LIMIT) {
      req.destroy();
      return resolve('');
    }
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > BODY_LIMIT) { req.destroy(); resolve(''); }
    });
    req.on('end', () => resolve(body));
  });
}

// 读 body 并解析成对象，解析失败给个空对象（别让服务器崩）
async function readJSON(req) {
  try { return JSON.parse(await readBody(req)) || {}; }
  catch { return {}; }
}

// 从 Authorization 头读 token
function getToken(req) {
  const h = req.headers['authorization'] || '';
  return h.replace('Bearer ', '').trim();
}

// 找 token 对应的用户
function findUserByToken(token) {
  return loadUsers().find(u => u.token === token);
}

// 老留言是 { name, text, time } 没有 id，启动时补上编号。
// 有了稳定编号，举报和删评才能准确指到某一条。
// 顺便给老留言补上 parent（null = 直接发的一楼）和 floor（楼层号，只有一楼才有）。
function migrateMessages() {
  const list = loadMessages();
  let max = list.reduce((m, x) => Math.max(m, x.id || 0), 0);
  let changed = false;

  list.forEach(m => { if (!m.id) { m.id = ++max; changed = true; } });

  // 回复是挂在别人留言底下的：parent 指向那条留言的 id。
  // 只有 parent 为空（也就是自己发的一楼）才有楼层号。
  let floor = 0;
  list.forEach(m => {
    if (m.parent === undefined) { m.parent = null; changed = true; }
    if (m.parent === null || m.parent === 0) {
      if (!m.floor) { m.floor = ++floor; changed = true; }
      else floor = Math.max(floor, m.floor);
    }
  });

  if (changed) saveMessages(list);
}

// 老版本的「有人@你」写的是 type:'reply'，那时候还没有真正的回复功能，
// 所以这些其实全是 @ 提醒，改成 mention，跟新的「回复」区分开。
function migrateNotifs() {
  const list = loadNotifs();
  let changed = false;
  list.forEach(n => {
    if (n.type === 'reply' && !n.parentId) { n.type = 'mention'; changed = true; }
  });
  if (changed) saveNotifs(list);
}

function nextId(list) {
  return list.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
}

// 下一个楼层号（只有直接发的一楼才占楼层）
function nextFloor(list) {
  return list.reduce((m, x) => Math.max(m, x.floor || 0), 0) + 1;
}

  /* ------------------------------------------------------------------
   文章系统的常量和工具
   目录结构（点开 Backend/articles 就能看懂）：
     articles/index.json    文章清单
     articles/content/1.html  正文
     articles/media/<文章id>/  这篇引用的图片/视频/音频
     articles/likes.json / favs.json / reports.json
   ------------------------------------------------------------------ */
const ART_DIR      = path.join(RESOURCES_DIR, 'articles');
const ART_INDEX    = path.join(ART_DIR, 'index.json');
// 每篇文章一个文件夹，打开 articles/ 就能按 id 一眼找到：
//   articles/1/content.html    正文
//   articles/1/media/          这篇引用的图片/视频/音频
//   articles/1/comments.json   这篇的评论
function articleDir(id) { return path.join(ART_DIR, String(id)); }
function articleMediaDir(id) { return path.join(articleDir(id), 'media'); }
function articleCommentsFile(id) { return path.join(articleDir(id), 'comments.json'); }
const ART_LIKES    = path.join(ART_DIR, 'likes.json');
const ART_FAVS     = path.join(ART_DIR, 'favs.json');
const ART_REPORTS  = path.join(ART_DIR, 'reports.json');
const ART_TMP      = path.join(ART_DIR, 'tmp');         // 分片上传的临时区
const ART_CMT_LIKES = path.join(ART_DIR, 'comment-likes.json');  // 评论的赞（跨文章共用一个表）

const ART_MAX_CHARS = 10000;                              // 正文最多一万字
const ART_TOTAL_LIMIT = 100 * 1024 * 1024 * 1024;         // 全站素材总上限 100GB
const API_PREFIX = '';                                    // 素材用相对地址，前后端同域最好

  /* ------------------------------------------------------------------
   视频系统的常量和工具（结构同文章，但独立目录；媒体仍共享上面那 100GB 总闸）
   目录结构：
     videos/index.json       视频清单（标题、作者、简介、时长…）
     videos/content/<id>.json  每支视频的元信息（简介等，纯文本不存 HTML）
     videos/media/<id>/        这支视频的封面 + 引用素材
     videos/likes.json / favs.json / reports.json / comment-likes.json
   ------------------------------------------------------------------ */
const VID_DIR        = path.join(RESOURCES_DIR, 'videos');
const VID_INDEX      = path.join(VID_DIR, 'index.json');
const VID_TMP        = path.join(VID_DIR, 'tmp');
const VID_LIKES      = path.join(VID_DIR, 'likes.json');
const VID_FAVS       = path.join(VID_DIR, 'favs.json');
const VID_REPORTS    = path.join(VID_DIR, 'reports.json');
const VID_CMT_LIKES  = path.join(VID_DIR, 'comment-likes.json');
const VID_MAX_DESC   = 2000;                               // 简介最多 2000 字

function videoDir(id) { return path.join(VID_DIR, String(id)); }
function videoMediaDir(id) { return path.join(videoDir(id), 'media'); }
function videoMetaFile(id) { return path.join(videoDir(id), 'meta.json'); }
function vidCommentsFile(id) { return path.join(videoDir(id), 'comments.json'); }
function loadVideos() { return loadArr(VID_INDEX); }
function saveVideos(list) { saveArr(VID_INDEX, list); }
function loadVidComments(id) { return loadArr(vidCommentsFile(id)); }
function saveVidComments(id, list) { saveArr(vidCommentsFile(id), list); }
function writeVideoMeta(id, obj) {
  fs.mkdirSync(videoDir(id), { recursive: true });
  fs.writeFileSync(videoMetaFile(id), JSON.stringify(obj || {}, null, 2));
}
function readVideoMeta(id) {
  try { return JSON.parse(fs.readFileSync(videoMetaFile(id), 'utf8')); } catch { return {}; }
}

/* 反查：某人点赞过 / 收藏过的视频（按 uid 查，按最近操作时间倒序） */
function videosByActs(file, uid) {
  const acts = loadArr(file).filter(x => x.uid === uid);
  const seen = new Map();            // videoId -> 最近操作时间
  acts.forEach(x => {
    const t = x.time || '';
    const prev = seen.get(x.videoId);
    if (!prev || t > prev) seen.set(x.videoId, t);
  });
  const all = loadVideos();
  const likes = loadArr(VID_LIKES);
  const favs  = loadArr(VID_FAVS);
  const list = [...seen.keys()]
    .map(id => all.find(a => a.id === id))
    .filter(a => a && a.status !== 'hidden')
    .map(a => Object.assign({}, a, {
      likes: likes.filter(x => x.videoId === a.id).length,
      favs:  favs.filter(x => x.videoId === a.id).length,
      views: a.views || 0
    }));
  list.sort((a, b) =>
    String(seen.get(b.id) || '').localeCompare(String(seen.get(a.id) || '')) || (b.id - a.id));
  return list.map(a => Object.assign({}, a, { description: undefined }));
}

// 各类素材的大小 / 类型限制（大的走分片上传，不然 2GB 一次塞进内存机器会炸）
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;
const UPLOAD_RULES = {
  image: { max: 50 * MB,  ext: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] },
  audio: { max: 200 * MB, ext: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] },
  video: { max: 2 * GB,   ext: ['mp4', 'webm', 'ogv', 'mov', 'mkv'] }
};
const CHUNK_MAX = 6 * MB;      // 前端每次最多传这么大一片
const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv', 'video/quicktime': 'mov'
};
const MEDIA_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  aac: 'audio/aac', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime'
};

function loadArr(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}
function saveArr(file, arr) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(arr, null, 2));
}

function loadArticles() { return loadArr(ART_INDEX); }
function saveArticles(list) { saveArr(ART_INDEX, list); }

/* 反查：某人点赞过 / 收藏过的文章清单（公开可读，按 uid 查）。
   file 传 ART_LIKES 或 ART_FAVS；按「这个人最近一次操作的时间」倒序，最新的排最前。 */
function articlesByActs(file, uid) {
  const acts = loadArr(file).filter(x => x.uid === uid);
  const seen = new Map();            // articleId -> 最近操作时间
  acts.forEach(x => {
    const t = x.time || '';
    const prev = seen.get(x.articleId);
    if (!prev || t > prev) seen.set(x.articleId, t);
  });
  const all = loadArticles();
  const likes = loadArr(ART_LIKES);
  const favs  = loadArr(ART_FAVS);
  const list = [...seen.keys()]
    .map(id => all.find(a => a.id === id))
    .filter(a => a && a.status !== 'hidden')
    .map(a => Object.assign({}, a, {
      likes: likes.filter(x => x.articleId === a.id).length,
      favs:  favs.filter(x => x.articleId === a.id).length,
      views: a.views || 0
    }));
  list.sort((a, b) =>
    String(seen.get(b.id) || '').localeCompare(String(seen.get(a.id) || '')) || (b.id - a.id));
  return list.map(a => Object.assign({}, a, { content: undefined }));
}

function readArticleContent(id) {
  try { return fs.readFileSync(path.join(articleDir(id), 'content.html'), 'utf8'); }
  catch { return ''; }
}
function writeArticleContent(id, html) {
  fs.mkdirSync(articleDir(id), { recursive: true });
  fs.writeFileSync(path.join(articleDir(id), 'content.html'), String(html || ''));
}

// 某篇文章的评论（存在这篇文章自己的文件夹里）
function loadComments(id) { return loadArr(articleCommentsFile(id)); }
function saveComments(id, list) { saveArr(articleCommentsFile(id), list); }

/* 正文消毒：编辑器出来的 HTML 直接存会有 XSS 风险，
   这里去掉 script/iframe 之类的危险标签、事件属性和 javascript: 链接 */
function sanitizeArticleHTML(html) {
  let s = String(html || '');
  const bad = 'script|style|iframe|object|embed|link|meta|form|input|button|textarea|select|base';
  s = s.replace(new RegExp(`<\\s*(${bad})\\b[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>`, 'gi'), '');
  s = s.replace(new RegExp(`<\\s*(${bad})\\b[^>]*\\/?\\s*>`, 'gi'), '');
  s = s.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1=""');
  return s.slice(0, 500000);
}

/* 素材目录现在占多少字节。算一次要遍历整个目录，所以缓存 20 秒。
   文章和视频的媒体都算进同一个 100GB 总闸（共享额度）。 */
let artBytesCache = { at: 0, size: 0 };
function articleMediaBytes(fresh) {
  if (!fresh && Date.now() - artBytesCache.at < 20000) return artBytesCache.size;
  let total = 0;
  const walk = dir => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    items.forEach(e => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch { /* 忽略 */ } }
    });
  };
  // 只算各文章 media 目录 + 未归位的临时分片
  let dirs = [];
  try { dirs = fs.readdirSync(ART_DIR, { withFileTypes: true }); } catch { /* 还没建 */ }
  dirs.forEach(e => {
    if (e.isDirectory()) walk(path.join(ART_DIR, e.name, 'media'));
  });
  walk(ART_TMP);
  // 视频媒体也算进同一个 100GB 总闸
  try { dirs = fs.readdirSync(VID_DIR, { withFileTypes: true }); } catch { /* 还没建 */ }
  dirs.forEach(e => {
    if (e.isDirectory()) walk(path.join(VID_DIR, e.name, 'media'));
  });
  walk(VID_TMP);
  artBytesCache = { at: Date.now(), size: total };
  return total;
}

/* 防止一个人短时间内狂传：10 分钟窗口内最多 30 个文件 / 4GB。
   真要挡「一口气 200G」靠的是上面的 100GB 总闸，这里只是防连续刷。 */
const uploadLog = [];
function uploadAllowed(uid, bytes) {
  const now = Date.now();
  const win = 10 * 60 * 1000;
  const recent = uploadLog.filter(x => x.uid === uid && now - x.at < win);
  if (recent.length >= 30) return { ok: false, error: '传得太快了，歇 10 分钟再来（10 分钟内最多 30 个文件）' };
  const sum = recent.reduce((s, x) => s + x.bytes, 0);
  if (sum + bytes > 4 * GB) return { ok: false, error: '10 分钟内最多传 4GB，歇会儿再来' };
  uploadLog.push({ uid, at: now, bytes });
  // 只留一小时内的记录，别让数组无限长
  while (uploadLog.length && now - uploadLog[0].at > 60 * 60 * 1000) uploadLog.shift();
  return { ok: true };
}

const viewHits = {};      // { 文章id: { uid: 时间戳 } } 用来去重阅读数
const uploadSessions = {}; // 分片上传进行中的会话

function fmtSize(b) {
  if (b >= GB) return (b / GB).toFixed(1) + 'GB';
  if (b >= MB) return Math.round(b / MB) + 'MB';
  return Math.round(b / 1024) + 'KB';
}
function kindName(kind) {
  return kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频';
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = req.url;
  const method = req.method;

  // ===== 注册 =====
  if (url === '/register' && method === 'POST') {
    const body = await readJSON(req);
    const { username, password } = body;

    if (!username || !password) return json(res, 400, { ok: false, error: '用户名密码必填' });
    if (username.length < 2 || username.length > 20) return json(res, 400, { ok: false, error: '用户名 2~20 字' });
    if (password.length < 6) return json(res, 400, { ok: false, error: '密码至少 6 位' });

    const users = loadUsers();
    if (users.find(u => u.username === username)) {
      return json(res, 400, { ok: false, error: '用户名已存在' });
    }

       // 分配 uid（找当前最大 +1）
    const maxUid = users.reduce((m, u) => Math.max(m, u.uid || 0), 0);

    users.push({
      uid: maxUid + 1,
      username,
      passwordHash: hash(password),
      createdAt: new Date().toLocaleString('zh-CN'),
      token: null,
      role: 'user',
      avatar: null,
      bio: '',
      muted: false,
      banned: false
    });
    saveUsers(users);

    return json(res, 200, { ok: true });
  }

  // ===== 登录 =====
  if (url === '/login' && method === 'POST') {
    const body = await readJSON(req);
    const { username, password } = body;

    const users = loadUsers();
    const user = users.find(u => u.username === username);
    if (!user) return json(res, 400, { ok: false, error: '用户名或密码错误' });
    if (user.passwordHash !== hash(password)) return json(res, 400, { ok: false, error: '用户名或密码错误' });
    // 封号检查放在密码验证之后，免得别人拿它来试探"这个账号存不存在"
    if (user.banned) return json(res, 403, { ok: false, error: '账号已被封禁，请联系站长' });

    // 生成新 token
    user.token = makeToken();
    saveUsers(users);

    return json(res, 200, { ok: true, token: user.token, username: user.username, uid: user.uid || null });
  }

  // ===== 查当前用户 =====
  if (url === '/me' && method === 'GET') {
    const token = getToken(req);
    const user = findUserByToken(token);
    if (!user) return json(res, 401, { ok: false, error: '未登录' });
    return json(res, 200, {
      ok: true,
      uid: user.uid || null,
      username: user.username,
      role: user.role || 'user',
      createdAt: user.createdAt || null,
      avatar: avatarUrl(req, user.avatar),
      bio: user.bio || '',
      muted: !!user.muted,
      banned: !!user.banned
    });
  }

  // ===== 查任意用户的公开资料（按 uid，不需要登录）=====
  if ((url === '/user' || url.startsWith('/user?')) && method === 'GET') {
    const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
    const uid = parseInt(new URLSearchParams(qs).get('uid'), 10);
    if (!uid || uid < 1) return json(res, 400, { ok: false, error: '缺少或错误的 uid' });

    const user = loadUsers().find(u => u.uid === uid);
    if (!user) return json(res, 404, { ok: false, error: '用户不存在' });

    // 只返回公开信息，绝不返回 token / passwordHash
    return json(res, 200, {
      ok: true,
      uid: user.uid,
      username: user.username,
      role: user.role || 'user',
      createdAt: user.createdAt || null,
      avatar: avatarUrl(req, user.avatar),
      bio: user.bio || ''
    });
  }

  // ===== 用户名单（uid / 用户名 / 头像 / 角色 / 签名，留言板显示头像和铭牌用）=====
  if (url === '/users' && method === 'GET') {
    const list = loadUsers().map(u => ({
      uid: u.uid,
      username: u.username,
      role: u.role || 'user',
      bio: u.bio || '',
      avatar: avatarUrl(req, u.avatar)
    }));
    return json(res, 200, list);
  }

  // ===== 关注 / 拉黑 / 粉丝 名单（按 uid 查，公开可读）=====
  if ((url === '/relations' || url.startsWith('/relations?')) && method === 'GET') {
    const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
    const uid = parseInt(new URLSearchParams(qs).get('uid'), 10);
    if (!uid || uid < 1) return json(res, 400, { ok: false, error: '缺少或错误的 uid' });

    const r = loadRelations();
    const following = r.follows.filter(x => x.from === uid).map(x => x.to);
    const followers = r.follows.filter(x => x.to === uid).map(x => x.from);
    const blocked = r.blocks.filter(x => x.from === uid).map(x => x.to);

    // 带上「我」和这个人的关系，profile 页面据此决定按钮显示"关注"还是"已关注"
    const me = findUserByToken(getToken(req));
    const myUid = me ? (me.uid || null) : null;

    return json(res, 200, {
      ok: true,
      uid,
      following,
      followers,
      blocked,
      meUid: myUid,
      // "我关注了TA吗" = 我在 TA 的粉丝名单里（别写成 following，那是 TA 关注的人）
      meFollowing: myUid ? followers.indexOf(myUid) !== -1 : false,
      // "我拉黑了TA吗" = 拉黑记录里有一条 from=我 to=TA（别写成查 blocked，那是 TA 拉黑的人）
      meBlocked: myUid ? r.blocks.some(x => x.from === myUid && x.to === uid) : false,
      // "TA 拉黑了我吗" = 反过来的那一条
      blockedMe: myUid ? r.blocks.some(x => x.from === uid && x.to === myUid) : false
    });
  }

  // ===== 关注 / 取关（点一下切换）=====
  if (url === '/follow' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const no = muteReason(user);
    if (no) return json(res, 403, { ok: false, error: no });

    const body = await readJSON(req);
    const target = parseInt(body.uid, 10);
    if (!target || target === user.uid) return json(res, 400, { ok: false, error: '不能关注自己' });
    if (!loadUsers().some(u => u.uid === target)) return json(res, 404, { ok: false, error: '用户不存在' });

    const r = loadRelations();
    const i = r.follows.findIndex(x => x.from === user.uid && x.to === target);
    let following;
    if (i === -1) { r.follows.push({ from: user.uid, to: target, time: nowTime() }); following = true; }
    else { r.follows.splice(i, 1); following = false; }
    saveRelations(r);

    return json(res, 200, { ok: true, following });
  }

  // ===== 拉黑 / 取消拉黑（点一下切换）=====
  if (url === '/block' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const no = muteReason(user);
    if (no) return json(res, 403, { ok: false, error: no });

    const body = await readJSON(req);
    const target = parseInt(body.uid, 10);
    if (!target || target === user.uid) return json(res, 400, { ok: false, error: '不能拉黑自己' });
    if (!loadUsers().some(u => u.uid === target)) return json(res, 404, { ok: false, error: '用户不存在' });

    const r = loadRelations();
    const i = r.blocks.findIndex(x => x.from === user.uid && x.to === target);
    let blocked;
    if (i === -1) { r.blocks.push({ from: user.uid, to: target, time: nowTime() }); blocked = true; }
    else { r.blocks.splice(i, 1); blocked = false; }
    saveRelations(r);

    return json(res, 200, { ok: true, blocked });
  }

  // ===== 点赞 / 取消赞（点一下切换）=====
  if (url === '/like' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const no = muteReason(user);
    if (no) return json(res, 403, { ok: false, error: no });

    const body = await readJSON(req);
    const id = parseInt(body.id, 10);
    const msg = loadMessages().find(m => m.id === id);
    if (!msg) return json(res, 404, { ok: false, error: '这条留言已经不在了' });

    const likes = loadLikes();
    const i = likes.findIndex(x => x.msgId === id && x.uid === user.uid);
    let liked;
    if (i === -1) { likes.push({ msgId: id, uid: user.uid, time: nowTime() }); liked = true; }
    else { likes.splice(i, 1); liked = false; }
    saveLikes(likes);

    // 只在你赞别人时进信箱；自己赞自己不发
    const owner = authorUidOf(msg);
    if (liked && owner && owner !== user.uid) {
      addNotif(owner, {
        type: 'like', fromUid: user.uid, fromName: user.username,
        msgId: id, text: String(msg.text || '').slice(0, 200)
      });
    }

    return json(res, 200, { ok: true, liked, likes: likes.filter(x => x.msgId === id).length });
  }

  // ===== 举报一条留言 =====
  if (url === '/report' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const no = muteReason(user);
    if (no) return json(res, 403, { ok: false, error: no });

    const body = await readJSON(req);
    const id = parseInt(body.id, 10);
    const reason = String(body.reason || '').trim().slice(0, 100) || '未填写理由';

    const msg = loadMessages().find(m => m.id === id);
    if (!msg) return json(res, 404, { ok: false, error: '这条留言已经不在了' });
    // 按用户要求：自己的留言也能举报，所以这里不再拦「不能举报自己」
    const author = authorOf(msg);

    const reports = loadReports();
    if (reports.some(r => r.msgId === id && r.reporterUid === user.uid && r.status === 'pending')) {
      return json(res, 400, { ok: false, error: '你已经举报过了，等管理员处理' });
    }

    // 留言内容抄一份存进举报记录：就算留言被删了，后台还看得到举报的是啥
    const rec = {
      id: nextId(reports),
      msgId: id,
      msgName: msg.name || '匿名',
      msgUid: author ? author.uid : null,
      msgText: msg.text,
      msgTime: msg.time,
      reporter: user.username,
      reporterUid: user.uid,
      reason,
      time: nowTime(),
      status: 'pending',        // pending = 待处理，done = 已处理
      action: null,
      handler: null,            // 待处理时是 null，处理完填上是谁处理的
      handleTime: null
    };
    reports.push(rec);
    saveReports(reports);

    // 被举报的人也会在自己的「系统消息」里看到（举报自己的就不发了）
    if (author && author.uid && author.uid !== user.uid) {
      addNotif(author.uid, {
        type: 'system', fromUid: user.uid, fromName: user.username,
        msgId: id, text: String(msg.text || '').slice(0, 200),
        note: '有人举报了你的这条留言，管理员会看的'
      });
    }

    return json(res, 200, { ok: true, id: rec.id });
  }

  // ===== 我举报过、还没处理的留言编号（留言板上显示"已举报"）=====
  if (url === '/my-reports' && method === 'GET') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 200, []);
    const ids = loadReports()
      .filter(r => r.reporterUid === user.uid && r.status === 'pending')
      .map(r => r.msgId);
    return json(res, 200, ids);
  }

  // ===== 信箱：我的消息（被点赞 / 被回复 / 举报结果）=====
  if (url === '/notifications' && method === 'GET') {
    const me = findUserByToken(getToken(req));
    if (!me) return json(res, 401, { ok: false, error: '请先登录' });
    const myUid = me.uid || null;

    const msgs = loadMessages();
    const users = loadUsers();
    const list = loadNotifs()
      .filter(n => n.uid === myUid)
      .reverse()                                  // 最新的排最前面
      .map(n => {
        const alive = typeof n.msgId === 'number' && msgs.some(m => m.id === n.msgId);
        const fu = users.find(u => u.uid === n.fromUid);
        // 点一条消息该跳去哪：能回复的就直接打开那条留言的回复框并 @上对方。
        // 文章相关的通知自带 href（/article.html?id=N），以它为准。
        let href = n.href || '/test/board';
        if (!n.href) {
          if (alive && (n.type === 'reply' || n.type === 'like' || n.type === 'mention')) {
            href = '/test/board?reply=' + n.msgId +
                   (n.fromName ? '&to=' + encodeURIComponent(n.fromName) : '');
          } else if (alive) {
            href = '/test/board?msg=' + n.msgId;
          }
        }
        return Object.assign({}, n, {
          alive,
          fromAvatar: fu ? avatarUrl(req, fu.avatar) : null,
          href
        });
      });

    return json(res, 200, { ok: true, list, unread: list.filter(n => !n.read).length });
  }

  // ===== 信箱：标记已读（all:true 或 ids:[1,2]）=====
  if (url === '/notifications/read' && method === 'POST') {
    const me = findUserByToken(getToken(req));
    if (!me) return json(res, 401, { ok: false, error: '请先登录' });
    const myUid = me.uid || null;

    const body = await readJSON(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(Number) : null;

    const list = loadNotifs();
    list.forEach(n => {
      if (n.uid !== myUid) return;
      if (body.all || (ids && ids.indexOf(n.id) !== -1)) n.read = true;
    });
    saveNotifs(list);
    return json(res, 200, { ok: true });
  }

  // ===== 后台：看所有举报（只有站长 / 管理员）=====
  if (url === '/reports' && method === 'GET') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    if (!isAdmin(user)) return json(res, 403, { ok: false, error: '只有站长和管理员能看举报' });

    const msgs = loadMessages();
    // 顺带把「留言还在不在」「作者现在是不是已经被禁言/封号」告诉后台
    const list = loadReports().map(r => {
      const t = authorOf({ uid: r.msgUid, name: r.msgName });
      return Object.assign({}, r, {
        alive: msgs.some(m => m.id === r.msgId),
        targetUid: t ? t.uid : null,
        targetName: t ? t.username : (r.msgName || null),
        targetExists: !!t,
        targetMuted: !!(t && t.muted),
        targetBanned: !!(t && t.banned)
      });
    });
    return json(res, 200, list);
  }

  // ===== 后台：处理举报（放行 / 删评 / 禁言 / 封号 / 解除）=====
  if (url === '/reports' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    if (!isAdmin(user)) return json(res, 403, { ok: false, error: '只有站长和管理员能处理举报' });

    const body = await readJSON(req);
    const id = parseInt(body.id, 10);
    const action = String(body.action || '');

    const reports = loadReports();
    const rec = reports.find(r => r.id === id);
    if (!rec) return json(res, 404, { ok: false, error: '举报不存在' });

    const users = loadUsers();
    // 老留言没 uid，就按用户名找作者，不然禁言/封号点不动。
    // 注意要从上面这个 users 数组里取对象，不然改了存不进去。
    const guess = authorOf({ uid: rec.msgUid, name: rec.msgName });
    const target = guess ? users.find(u => u.uid === guess.uid) : null;
    const NAMES = {
      approve: '放行', remove: '删评', mute: '禁言', ban: '封号',
      unmute: '解除禁言', unban: '解除封号'
    };
    if (!NAMES[action]) return json(res, 400, { ok: false, error: '未知操作' });

    let note = NAMES[action];

    if (action === 'approve') {
      // 什么都不做，就是认定这条留言没问题
    } else if (action === 'remove') {
      const list = loadMessages();
      const i = list.findIndex(m => m.id === rec.msgId);
      if (i === -1) { note = '这条留言早就没了'; }
      else { list.splice(i, 1); saveMessages(list); note = '已删除这条留言'; }
      // 同一条留言的其他待处理举报一起结掉
      reports.forEach(r => {
        if (r.msgId === rec.msgId && r.id !== rec.id && r.status === 'pending') {
          r.status = 'done'; r.action = '删评'; r.handleTime = nowTime(); r.handler = user.username;
        }
      });
    } else if (action === 'mute') {
      if (!target) return json(res, 404, { ok: false, error: '作者账号不存在，禁言不了' });
      target.muted = true; saveUsers(users);
      note = '已禁言 ' + target.username;
    } else if (action === 'ban') {
      if (!target) return json(res, 404, { ok: false, error: '作者账号不存在，封不了' });
      target.banned = true;
      target.token = null;          // 顺手把 TA 踢下线
      saveUsers(users);
      note = '已封禁 ' + target.username;
    } else if (action === 'unmute') {
      if (!target) return json(res, 404, { ok: false, error: '作者账号不存在' });
      target.muted = false; saveUsers(users);
      note = '已解除 ' + target.username + ' 的禁言';
    } else if (action === 'unban') {
      if (!target) return json(res, 404, { ok: false, error: '作者账号不存在' });
      target.banned = false; saveUsers(users);
      note = '已解除 ' + target.username + ' 的封禁';
    }

    rec.status = 'done';
    rec.action = NAMES[action];
    rec.handleTime = nowTime();
    rec.handler = user.username;
    saveReports(reports);

    // 举报人会在信箱里收到处理结果
    if (rec.reporterUid) {
      addNotif(rec.reporterUid, {
        type: 'report', fromUid: user.uid, fromName: user.username,
        msgId: rec.msgId, text: rec.msgText || '',
        action: NAMES[action], note
      });
    }

    // 被处理的人也会在「系统消息」里收到通知
    const SAY = {
      remove: '你的这条留言因为被举报，已经被管理员删除',
      mute: '你因为被举报的留言，被管理员禁言了，暂时不能发留言',
      ban: '你因为被举报的留言，被管理员封号了'
    };
    if (target && SAY[action]) {
      addNotif(target.uid, {
        type: 'system', fromUid: user.uid, fromName: user.username,
        msgId: rec.msgId, text: String(rec.msgText || '').slice(0, 200),
        note: SAY[action]
      });
    }

    return json(res, 200, { ok: true, note });
  }

  // ===== 更新个人资料（头像、签名）=====
  if (url === '/profile' && method === 'POST') {
    const token = getToken(req);
    const users = loadUsers();
    const user = users.find(u => u.token === token);
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const no = muteReason(user);
    if (no) return json(res, 403, { ok: false, error: no });

    const body = await readJSON(req);
    const { bio, avatar } = body;

    if (typeof bio === 'string') {
      user.bio = bio.slice(0, 200);   // 签名最多 200 字
    }

    // 头像：前端传的是 data:image/...;base64,...，这里解码后存成 avatars/uid1.jpg
    // 注意：没换头像时前端会把渲染出来的网址原样传回来，那种要忽略，别把文件名覆盖成网址
    if (typeof avatar === 'string' && avatar.startsWith('data:image/')) {
      const m = avatar.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
      if (!m) return json(res, 400, { ok: false, error: '头像格式看不懂' });

      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 2 * 1024 * 1024) return json(res, 400, { ok: false, error: '头像太大了（上限 2MB）' });

      const ext = ({ jpeg: 'jpg', jpg: 'jpg', png: 'png', gif: 'gif', webp: 'webp' })[m[1].toLowerCase()];
      if (!ext) return json(res, 400, { ok: false, error: '只支持 jpg / png / gif / webp' });

      fs.mkdirSync(AVATAR_DIR, { recursive: true });
      const name = 'uid' + user.uid + '.' + ext;
      const old = user.avatar;
      fs.writeFileSync(path.join(AVATAR_DIR, name), buf);
      // 换了格式就把旧文件删掉，别在文件夹里留垃圾
      if (old && old !== name && !/^data:image\//.test(old)) {
        try { fs.unlinkSync(path.join(AVATAR_DIR, old)); } catch {}
      }
      user.avatar = name;
    }

    saveUsers(users);
    return json(res, 200, { ok: true });
  }

  // ===== 修改密码 =====
  if (url === '/change-password' && method === 'POST') {
    const token = getToken(req);
    const users = loadUsers();
    const user = users.find(u => u.token === token);
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });

    const body = await readJSON(req);
    const { oldPassword, newPassword } = body;

    if (!oldPassword || !newPassword) return json(res, 400, { ok: false, error: '密码必填' });
    if (user.passwordHash !== hash(oldPassword)) return json(res, 400, { ok: false, error: '原密码错误' });
    if (newPassword.length < 6) return json(res, 400, { ok: false, error: '新密码至少 6 位' });

    user.passwordHash = hash(newPassword);
    saveUsers(users);
    return json(res, 200, { ok: true });
  }

  // ===== 留言板 =====
  if (url === '/messages' && method === 'GET') {
    const me = findUserByToken(getToken(req));
    const myUid = me ? (me.uid || null) : null;
    const likes = loadLikes();
    // 赞数和「我赞过没」是当场算出来的，不写进文件，免得留言一多就不同步
    const list = loadMessages().map(m => Object.assign({}, m, {
      likes: likes.filter(x => x.msgId === m.id).length,
      likedByMe: myUid ? likes.some(x => x.msgId === m.id && x.uid === myUid) : false
    }));
    return json(res, 200, list);
  }

  if (url === '/messages' && method === 'POST') {
    const token = getToken(req);
    const user = findUserByToken(token);
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const no = muteReason(user);
    if (no) return json(res, 403, { ok: false, error: no });

    const body = await readJSON(req);
    // 先掐掉首尾空白再判空，免得只发几个空格也存进去
    const clean = String(body.text || '').trim().slice(0, 200);
    if (!clean) return json(res, 400, { ok: false, error: '内容不能为空' });

    const list = loadMessages();

    // body.parent 有值 = 这是挂在某条留言底下的回复，不占楼层。
    // 回复的回复也挂在同一个一楼底下，只做两层，免得越缩越窄。
    let parent = null;       // 挂到哪个一楼
    let toName = null;       // 回的是谁（前端显示「回复 @某某」）
    let replyToUid = null;   // 该给谁发「有人回复你」
    if (body.parent !== undefined && body.parent !== null && body.parent !== '') {
      const aim = list.find(m => m.id === parseInt(body.parent, 10));
      if (!aim) return json(res, 400, { ok: false, error: '要回复的那条留言已经不在了' });
      toName = aim.name || null;
      replyToUid = authorUidOf(aim);
      parent = (aim.parent === null || aim.parent === undefined) ? aim.id : aim.parent;
    }

    const newId = nextId(list);
    list.push({
      id: newId,
      uid: user.uid || null,
      name: user.username,
      text: clean,
      time: nowTime(),
      parent: parent,
      floor: parent === null ? nextFloor(list) : null,
      toName: toName
    });
    saveMessages(list);

    // ① 被回复的人收到「有人回复你」（回自己的留言就不发）
    if (replyToUid && replyToUid !== user.uid) {
      addNotif(replyToUid, {
        type: 'reply', fromUid: user.uid, fromName: user.username,
        msgId: newId, parentId: parent, text: clean
      });
    }

    // ② 正文里 @ 了谁，就给谁塞一条「有人@你」。
    //    已经被①通知过的人跳过，免得同一条留言让一个人收两条提醒。
    const users = loadUsers();
    mentionedUids(clean, users, user.uid).forEach(toUid => {
      if (toUid === replyToUid) return;
      addNotif(toUid, {
        type: 'mention', fromUid: user.uid, fromName: user.username,
        msgId: newId, parentId: parent, text: clean
      });
    });

    return json(res, 200, { ok: true, id: newId, parent: parent });
  }

  // ===== 删除留言：本人可删自己的，站长/管理员可删任何人的 =====
  // 删主楼时，它底下的回复跟着一起删，免得留下一堆没头没脑的孤儿
  if (url === '/messages/delete' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });

    const body = await readJSON(req);
    const id = parseInt(body.id, 10);
    const list = loadMessages();
    const msg = list.find(m => m.id === id);
    if (!msg) return json(res, 404, { ok: false, error: '这条留言已经不在了' });

    const authorUid = authorUidOf(msg);
    const mine = authorUid != null && authorUid === user.uid;
    if (!mine && !isAdmin(user)) return json(res, 403, { ok: false, error: '只能删自己的留言' });

    const gone = list.filter(m => m.id === id || m.parent === id).map(m => m.id);
    saveMessages(list.filter(m => m.id !== id && m.parent !== id));

    // 顺手把这些留言的赞也清掉，数字才不会飘
    saveLikes(loadLikes().filter(x => gone.indexOf(x.msgId) === -1));

    return json(res, 200, { ok: true, removed: gone.length });
  }

  // ===== 置顶 / 取消置顶：只有站长和管理员，最多同时置顶 2 条主楼 =====
  if (url === '/messages/pin' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    if (!isAdmin(user)) return json(res, 403, { ok: false, error: '只有站长和管理员能置顶' });

    const body = await readJSON(req);
    const id = parseInt(body.id, 10);
    const list = loadMessages();
    const msg = list.find(m => m.id === id);
    if (!msg) return json(res, 404, { ok: false, error: '这条留言已经不在了' });
    if (msg.parent !== null && msg.parent !== undefined) {
      return json(res, 400, { ok: false, error: '只能置顶主楼，回复不能置顶' });
    }

    if (!msg.pinned && list.filter(m => m.pinned).length >= 2) {
      return json(res, 400, { ok: false, error: '最多只能置顶 2 条，先取消一条再置顶' });
    }

    msg.pinned = !msg.pinned;
    if (msg.pinned) msg.pinTime = nowTime();
    else delete msg.pinTime;
    saveMessages(list);

    return json(res, 200, { ok: true, pinned: !!msg.pinned });
  }

  // ===== 头像文件（avatars 文件夹里的图）=====
  if (url.startsWith('/avatar/') && method === 'GET') {
    const name = decodeURIComponent(url.slice(8).split('?')[0]);
    // 只放行普通文件名，挡住 ../../ 这种穿越
    if (!/^[A-Za-z0-9._-]+$/.test(name)) { res.writeHead(400); return res.end('Bad Request'); }

    const full = path.join(AVATAR_DIR, name);
    if (!full.startsWith(AVATAR_DIR) || !fs.existsSync(full)) { res.writeHead(404); return res.end('Not Found'); }

    const ext = path.extname(name).slice(1).toLowerCase();
    const buf = fs.readFileSync(full);
    res.writeHead(200, {
      'Content-Type': IMG_MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      // 网址尾巴上带了 ?v=修改时间，所以这里可以放心长缓存
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
    return res.end(buf);
  }

  /* ===================== 文章系统 ===================== */
  /* 文件都放在 Backend/articles/ 下面，一眼能对上：
       articles/index.json       文章清单（标题、作者、时间、赞数…）
       articles/content/1.html   id=1 这篇文章的正文
       articles/media/1/xxx.jpg  id=1 这篇文章引用的图片/视频/音频
       articles/likes.json       谁赞了哪篇   [{ articleId, uid, time }]
       articles/favs.json        谁收藏了哪篇 [{ articleId, uid, time }]
       articles/reports.json     文章举报     [{ id, articleId, ... }]        */

  // ===== 文章清单（支持 ?limit&offset&sort=new|hot&uid=只看某人）=====
  if ((url === '/articles' || url.startsWith('/articles?')) && method === 'GET') {
    const me = findUserByToken(getToken(req));
    const myUid = me ? (me.uid || null) : null;
    const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
    const arg = new URLSearchParams(qs);

    let list = loadArticles();
    const only = parseInt(arg.get('uid'), 10);
    if (only) list = list.filter(a => a.uid === only);
    if (String(arg.get('status') || '') !== 'all') list = list.filter(a => a.status !== 'hidden');

    const likes = loadArr(ART_LIKES);
    const favs  = loadArr(ART_FAVS);
    list = list.map(a => Object.assign({}, a, {
      likes: likes.filter(x => x.articleId === a.id).length,
      favs:  favs.filter(x => x.articleId === a.id).length,
      likedByMe: myUid ? likes.some(x => x.articleId === a.id && x.uid === myUid) : false,
      favedByMe: myUid ? favs.some(x => x.articleId === a.id && x.uid === myUid) : false
    }));

    if (arg.get('sort') === 'hot') list.sort((a, b) => (b.likes * 2 + b.favs * 3 + b.views) - (a.likes * 2 + a.favs * 3 + a.views));
    else list.sort((a, b) => (b.id - a.id));            // 默认最新的在前

    const limit  = Math.min(Math.max(parseInt(arg.get('limit'), 10) || 20, 1), 100);
    const offset = Math.max(parseInt(arg.get('offset'), 10) || 0, 0);
    return json(res, 200, {
      ok: true,
      total: list.length,
      list: list.slice(offset, offset + limit).map(a => Object.assign({}, a, { content: undefined }))
    });
  }

  // ===== 某人点赞过的文章（按 uid 查，公开可读）=====
  if ((url === '/article/liked-by' || url.startsWith('/article/liked-by?')) && method === 'GET') {
    const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
    const uid = parseInt(new URLSearchParams(qs).get('uid'), 10);
    if (!uid || uid < 1) return json(res, 400, { ok: false, error: '缺少或错误的 uid' });
    return json(res, 200, { ok: true, list: articlesByActs(ART_LIKES, uid) });
  }

  // ===== 某人收藏过的文章（按 uid 查，公开可读）=====
  if ((url === '/article/faved-by' || url.startsWith('/article/faved-by?')) && method === 'GET') {
    const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
    const uid = parseInt(new URLSearchParams(qs).get('uid'), 10);
    if (!uid || uid < 1) return json(res, 400, { ok: false, error: '缺少或错误的 uid' });
    return json(res, 200, { ok: true, list: articlesByActs(ART_FAVS, uid) });
  }

  // ===== 单篇文章（正文一起给）=====
  if ((url === '/article' || url.startsWith('/article?')) && method === 'GET') {
    const me = findUserByToken(getToken(req));
    const myUid = me ? (me.uid || null) : null;
    const arg = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '');
    const id = parseInt(arg.get('id'), 10);
    const a = loadArticles().find(x => x.id === id);
    if (!a) return json(res, 404, { ok: false, error: '文章不存在' });

    const html = readArticleContent(id);
    const likes = loadArr(ART_LIKES);
    const favs  = loadArr(ART_FAVS);
    const mine = me && (a.uid === me.uid || isAdmin(me));

    // 阅读数 +1：每次点进来都算一次，不管是不是同一个人重复点（按用户要求，不做去重）。
    // 编辑模式（write.html 加载正文）带 noView=1，不计入阅读数，免得自己改文章把阅读数刷高。
    const noView = String(arg.get('noView') || '') === '1';
    if (!noView) {
      const all = loadArticles();
      const t = all.find(x => x.id === id);
      if (t) {
        t.views = (t.views || 0) + 1;
        a.views = t.views;              // 返回给前端的也要是新的
        saveArticles(all);
      }
    }

    return json(res, 200, {
      ok: true,
      article: Object.assign({}, a, {
        content: html,
        likes: likes.filter(x => x.articleId === id).length,
        favs:  favs.filter(x => x.articleId === id).length,
        likedByMe: myUid ? likes.some(x => x.articleId === id && x.uid === myUid) : false,
        favedByMe: myUid ? favs.some(x => x.articleId === id && x.uid === myUid) : false,
        canEdit: !!mine
      })
    });
  }

  // ===== 写文章 / 改文章 =====
  if (url === '/article/save' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const no = muteReason(user);
    if (no) return json(res, 403, { ok: false, error: no });

    const body = await readJSON(req);
    const title = String(body.title || '').trim().slice(0, 100);
    if (!title) return json(res, 400, { ok: false, error: '标题不能为空' });

    const html = sanitizeArticleHTML(body.html);
    const plain = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
    if (plain.length > ART_MAX_CHARS) {
      return json(res, 400, { ok: false, error: `正文最多 ${ART_MAX_CHARS} 字，现在 ${plain.length} 字` });
    }
    if (html.length > 500000) return json(res, 400, { ok: false, error: '文章太大了' });

    const all = loadArticles();
    const id = parseInt(body.id, 10);
    const t = nowTime();
    let a = id ? all.find(x => x.id === id) : null;

    if (a) {
      if (a.uid !== user.uid && !isAdmin(user)) return json(res, 403, { ok: false, error: '只能改自己的文章' });
      a.title = title;
      a.updatedAt = t;
      a.chars = plain.length;
    } else {
      a = {
        id: nextId(all),
        uid: user.uid || null,
        author: user.username,
        title,
        createdAt: t,
        updatedAt: t,
        chars: plain.length,
        views: 0,
        status: 'normal'
      };
      all.push(a);
    }
    saveArticles(all);
    writeArticleContent(a.id, html);
    return json(res, 200, { ok: true, id: a.id });
  }

  // ===== 删文章（作者本人 / 站长管理员）=====
  if (url === '/article/delete' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const body = await readJSON(req);
    const id = parseInt(body.id, 10);

    const all = loadArticles();
    const a = all.find(x => x.id === id);
    if (!a) return json(res, 404, { ok: false, error: '文章不存在' });
    if (a.uid !== user.uid && !isAdmin(user)) return json(res, 403, { ok: false, error: '只能删自己的文章' });

    saveArticles(all.filter(x => x.id !== id));
    try { fs.rmSync(articleDir(id), { recursive: true, force: true }); } catch { /* 没有就算了 */ }
    saveArr(ART_LIKES, loadArr(ART_LIKES).filter(x => x.articleId !== id));
    saveArr(ART_FAVS,  loadArr(ART_FAVS).filter(x => x.articleId !== id));
    return json(res, 200, { ok: true });
  }

  // ===== 点赞 / 收藏（点一下切换）=====
  if ((url === '/article/like' || url === '/article/fav') && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const body = await readJSON(req);
    const id = parseInt(body.id, 10);
    if (!loadArticles().some(x => x.id === id)) return json(res, 404, { ok: false, error: '文章不存在' });

    const isLike = url === '/article/like';
    const file = isLike ? ART_LIKES : ART_FAVS;
    const arr = loadArr(file);
    const i = arr.findIndex(x => x.articleId === id && x.uid === user.uid);
    let on;
    if (i === -1) { arr.push({ articleId: id, uid: user.uid, time: nowTime() }); on = true; }
    else { arr.splice(i, 1); on = false; }
    saveArr(file, arr);

    const count = arr.filter(x => x.articleId === id).length;
    const a = loadArticles().find(x => x.id === id);
    if (a && on && a.uid && a.uid !== user.uid) {
      addNotif(a.uid, {
        type: 'system',
        fromUid: user.uid, fromName: user.username,
        articleId: id,
        note: (isLike ? '有人赞了你的文章《' : '有人收藏了你的文章《') + a.title + '》',
        href: '/article.html?id=' + id
      });
    }
    return json(res, 200, { ok: true, on, count });
  }

  // ===== 举报文章 =====
  if (url === '/article/report' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const body = await readJSON(req);
    const id = parseInt(body.id, 10);
    const a = loadArticles().find(x => x.id === id);
    if (!a) return json(res, 404, { ok: false, error: '文章不存在' });

    const reports = loadArr(ART_REPORTS);
    if (reports.some(r => r.articleId === id && r.reporterUid === user.uid && r.status === 'pending')) {
      return json(res, 400, { ok: false, error: '你已经举报过了，等管理员处理' });
    }
    reports.push({
      id: nextId(reports),
      articleId: id,
      title: a.title,
      authorUid: a.uid || null,
      authorName: a.author,
      reporter: user.username,
      reporterUid: user.uid,
      reason: String(body.reason || '').trim().slice(0, 100) || '未填写理由',
      time: nowTime(),
      status: 'pending',
      action: null, handler: null, handleTime: null
    });
    saveArr(ART_REPORTS, reports);
    return json(res, 200, { ok: true });
  }

  // ===== 后台：看文章举报 / 处理（隐藏文章、删文章）=====
  if (url === '/article/reports' && method === 'GET') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    if (!isAdmin(user)) return json(res, 403, { ok: false, error: '只有站长和管理员能看' });
    return json(res, 200, loadArr(ART_REPORTS));
  }
  if (url === '/article/reports' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    if (!isAdmin(user)) return json(res, 403, { ok: false, error: '只有站长和管理员能处理' });
    const body = await readJSON(req);
    const rid = parseInt(body.id, 10);
    const action = String(body.action || '');
    const NAMES = { approve: '放行', hide: '隐藏', remove: '删除' };
    if (!NAMES[action]) return json(res, 400, { ok: false, error: '未知操作' });

    const reports = loadArr(ART_REPORTS);
    const rec = reports.find(r => r.id === rid);
    if (!rec) return json(res, 404, { ok: false, error: '举报不存在' });

    let note = NAMES[action];

    // 被举报的是评论：隐藏就打个标记，删除就从 comments.json 里去掉
    if (rec.kind === 'comment' && (action === 'hide' || action === 'remove')) {
      const cl = loadComments(rec.articleId);
      const c = cl.find(x => x.id === rec.commentId);
      if (c) {
        if (action === 'hide') { c.hidden = true; c.hideTime = nowTime(); saveComments(rec.articleId, cl); }
        else saveComments(rec.articleId, cl.filter(x => x.id !== rec.commentId && x.parent !== rec.commentId));
      }
      reports.forEach(r => {
        if (r.commentId === rec.commentId && r.articleId === rec.articleId && r.id !== rec.id && r.status === 'pending') {
          r.status = 'done'; r.action = NAMES[action]; r.handler = user.username; r.handleTime = nowTime();
        }
      });
      rec.status = 'done'; rec.action = NAMES[action]; rec.handler = user.username; rec.handleTime = nowTime();
      saveArr(ART_REPORTS, reports);
      if (rec.authorUid) {
        addNotif(rec.authorUid, {
          type: 'system', fromUid: user.uid, fromName: user.username,
          articleId: rec.articleId,
          note: action === 'remove' ? '你在《' + rec.title + '》下的评论被管理员删除了'
                                    : '你在《' + rec.title + '》下的评论被管理员隐藏了',
          href: '/article.html?id=' + rec.articleId
        });
      }
      return json(res, 200, { ok: true, note });
    }

    if (action === 'hide' || action === 'remove') {
      const all = loadArticles();
      const a = all.find(x => x.id === rec.articleId);
      if (action === 'hide') { if (a) { a.status = 'hidden'; saveArticles(all); } }
      else {
        saveArticles(all.filter(x => x.id !== rec.articleId));
        try { fs.rmSync(articleDir(rec.articleId), { recursive: true, force: true }); } catch { /* 没有就算了 */ }
      }
      // 同一篇文章的其他待处理举报一起结掉
      reports.forEach(r => {
        if (r.articleId === rec.articleId && r.id !== rec.id && r.status === 'pending') {
          r.status = 'done'; r.action = NAMES[action]; r.handler = user.username; r.handleTime = nowTime();
        }
      });
    }
    rec.status = 'done'; rec.action = NAMES[action]; rec.handler = user.username; rec.handleTime = nowTime();
    saveArr(ART_REPORTS, reports);

    if (rec.authorUid) {
      addNotif(rec.authorUid, {
        type: 'system', fromUid: user.uid, fromName: user.username,
        articleId: rec.articleId,
        note: action === 'remove' ? '你的文章《' + rec.title + '》因为被举报已删除'
            : action === 'hide'   ? '你的文章《' + rec.title + '》因为被举报已隐藏'
            : '有人举报了你的文章《' + rec.title + '》，管理员看了没问题',
        href: action === 'remove' ? null : ('/article.html?id=' + rec.articleId)
      });
    }
    return json(res, 200, { ok: true, note });
  }

  // ===== 上传图片 / 视频 / 音频（base64，带大小和配额限制）=====
  if (url === '/article/upload' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const no = muteReason(user);
    if (no) return json(res, 403, { ok: false, error: no });

    const body = await readJSON(req);
    const kind = String(body.kind || '');
    const rule = UPLOAD_RULES[kind];
    if (!rule) return json(res, 400, { ok: false, error: '只支持 image / video / audio' });

    const data = String(body.data || '');
    const m = data.match(/^data:([A-Za-z0-9.+\/-]+);base64,([\s\S]*)$/);
    if (!m) return json(res, 400, { ok: false, error: '文件格式不对' });

    const ext = (MIME_EXT[m[1].toLowerCase()] || '').toLowerCase();
    if (!ext || rule.ext.indexOf(ext) === -1) {
      return json(res, 400, { ok: false, error: '不支持的文件类型（' + m[1] + '）' });
    }

    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) return json(res, 400, { ok: false, error: '文件是空的' });
    if (buf.length > rule.max) {
      return json(res, 400, { ok: false, error: `${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}最大 ${Math.round(rule.max / 1024 / 1024)}MB，这个 ${(buf.length / 1024 / 1024).toFixed(1)}MB` });
    }

    // ① 全站总容量
    const used = articleMediaBytes(true);
    if (used + buf.length > ART_TOTAL_LIMIT) {
      return json(res, 400, { ok: false, error: '网站素材空间已满（上限 100GB），先找站长清理一下' });
    }
    // ② 单人短时间狂传
    const check = uploadAllowed(user.uid, buf.length);
    if (!check.ok) return json(res, 429, { ok: false, error: check.error });

    const articleId = parseInt(body.articleId, 10) || 0;
    const dir = articleMediaDir(articleId || ('draft-' + (user.uid || 0)));
    fs.mkdirSync(dir, { recursive: true });
    const name = Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(dir, name), buf);

    return json(res, 200, {
      ok: true,
      url: `${API_PREFIX}/article/media/${articleId || ('draft-' + (user.uid || 0))}/${name}`,
      kind, size: buf.length
    });
  }

  // ===== 文章评论：评论存在这篇文章自己的文件夹里（articles/<id>/comments.json）=====
  if ((url === '/article/comments' || url.startsWith('/article/comments?')) && method === 'GET') {
    const me = findUserByToken(getToken(req));
    const myUid = me ? (me.uid || null) : null;
    const arg = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '');
    const id = parseInt(arg.get('articleId'), 10);
    if (!loadArticles().some(x => x.id === id)) return json(res, 404, { ok: false, error: '文章不存在' });

    const likes = loadArr(ART_CMT_LIKES);
    const list = loadComments(id).filter(c => !c.hidden).map(c => Object.assign({}, c, {
      likes: likes.filter(x => x.cid === c.id).length,
      likedByMe: myUid ? likes.some(x => x.cid === c.id && x.uid === myUid) : false
    }));
    return json(res, 200, { ok: true, list });
  }

  if (url === '/article/comment' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const no = muteReason(user);
    if (no) return json(res, 403, { ok: false, error: no });

    const body = await readJSON(req);
    const id = parseInt(body.articleId, 10);
    const a = loadArticles().find(x => x.id === id);
    if (!a) return json(res, 404, { ok: false, error: '文章不存在' });

    const text = String(body.text || '').trim().slice(0, 500);
    if (!text) return json(res, 400, { ok: false, error: '评论不能为空' });

    const list = loadComments(id);
    // parent 有值 = 回复某条评论，只做两层
    let parent = null, toName = null, toUid = null;
    if (body.parent != null && body.parent !== '') {
      const aim = list.find(c => c.id === parseInt(body.parent, 10));
      if (!aim) return json(res, 400, { ok: false, error: '要回复的那条评论已经不在了' });
      toName = aim.name || null;
      toUid = aim.uid || null;
      parent = (aim.parent == null) ? aim.id : aim.parent;
    }

    const rec = {
      id: nextId(list),
      uid: user.uid || null,
      name: user.username,
      text,
      time: nowTime(),
      parent, toName, floor: parent == null ? (list.filter(c => c.floor).length + 1) : null
    };
    list.push(rec);
    saveComments(id, list);

    // 被回复的人 / 文章作者收到提醒
    if (toUid && toUid !== user.uid) {
      addNotif(toUid, {
        type: 'system', fromUid: user.uid, fromName: user.username,
        articleId: id, note: '有人回复了你在《' + a.title + '》下的评论',
        href: '/article.html?id=' + id + '#cmt' + rec.id
      });
    } else if (a.uid && a.uid !== user.uid && parent == null) {
      addNotif(a.uid, {
        type: 'system', fromUid: user.uid, fromName: user.username,
        articleId: id, note: '有人评论了你的文章《' + a.title + '》',
        href: '/article.html?id=' + id + '#cmt' + rec.id
      });
    }
    return json(res, 200, { ok: true, id: rec.id });
  }

  if (url === '/article/comment/delete' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const body = await readJSON(req);
    const id = parseInt(body.articleId, 10);
    const cid = parseInt(body.id, 10);
    const list = loadComments(id);
    const c = list.find(x => x.id === cid);
    if (!c) return json(res, 404, { ok: false, error: '评论不存在' });
    if (c.uid !== user.uid && !isAdmin(user)) return json(res, 403, { ok: false, error: '只能删自己的评论' });
    const gone = list.filter(x => x.id === cid || x.parent === cid).map(x => x.id);
    saveComments(id, list.filter(x => x.id !== cid && x.parent !== cid));
    saveArr(ART_CMT_LIKES, loadArr(ART_CMT_LIKES).filter(x => gone.indexOf(x.cid) === -1));
    return json(res, 200, { ok: true, removed: gone.length });
  }

  // ===== 举报文章评论（跟文章举报存在同一张表，用 commentId 区分）=====
  if (url === '/article/comment/report' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const body = await readJSON(req);
    const id = parseInt(body.articleId, 10);
    const cid = parseInt(body.id, 10);
    const a = loadArticles().find(x => x.id === id);
    if (!a) return json(res, 404, { ok: false, error: '文章不存在' });
    const c = loadComments(id).find(x => x.id === cid);
    if (!c) return json(res, 404, { ok: false, error: '评论不存在' });

    const reports = loadArr(ART_REPORTS);
    if (reports.some(r => r.commentId === cid && r.articleId === id && r.reporterUid === user.uid && r.status === 'pending')) {
      return json(res, 400, { ok: false, error: '你已经举报过了，等管理员处理' });
    }
    reports.push({
      id: nextId(reports),
      kind: 'comment',
      articleId: id,
      commentId: cid,
      title: '《' + a.title + '》下的评论',
      text: String(c.text || '').slice(0, 200),
      authorUid: c.uid || null,
      authorName: c.name || '匿名',
      reporter: user.username,
      reporterUid: user.uid,
      reason: String(body.reason || '').trim().slice(0, 100) || '未填写理由',
      time: nowTime(),
      status: 'pending', action: null, handler: null, handleTime: null
    });
    saveArr(ART_REPORTS, reports);
    return json(res, 200, { ok: true });
  }

  if (url === '/article/comment/like' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const body = await readJSON(req);
    const cid = parseInt(body.id, 10);
    const arr = loadArr(ART_CMT_LIKES);
    const i = arr.findIndex(x => x.cid === cid && x.uid === user.uid);
    let on;
    if (i === -1) { arr.push({ cid, uid: user.uid, time: nowTime() }); on = true; }
    else { arr.splice(i, 1); on = false; }
    saveArr(ART_CMT_LIKES, arr);
    return json(res, 200, { ok: true, on, count: arr.filter(x => x.cid === cid).length });
  }

  // ===== 大文件分片上传：start → chunk（多片）→ finish =====
  // 2GB 的视频不可能一次性塞进内存，所以切成 6MB 一片慢慢追加到临时文件，最后再改名归位
  if (url === '/article/upload/start' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const no = muteReason(user);
    if (no) return json(res, 403, { ok: false, error: no });

    const body = await readJSON(req);
    const kind = String(body.kind || '');
    const rule = UPLOAD_RULES[kind];
    if (!rule) return json(res, 400, { ok: false, error: '只支持 image / video / audio' });

    const size = parseInt(body.size, 10);
    if (!size || size <= 0) return json(res, 400, { ok: false, error: '文件大小不对' });
    if (size > rule.max) {
      return json(res, 400, { ok: false, error: `${kindName(kind)}最大 ${fmtSize(rule.max)}，这个 ${fmtSize(size)}` });
    }

    // 扩展名：优先看文件名后缀，没有就用 MIME 推
    let ext = '';
    const nm = String(body.name || '');
    const dot = nm.lastIndexOf('.');
    if (dot !== -1) ext = nm.slice(dot + 1).toLowerCase();
    if (!ext) ext = MIME_EXT[String(body.mime || '').toLowerCase()] || '';
    if (!ext || rule.ext.indexOf(ext) === -1) {
      return json(res, 400, { ok: false, error: `不支持的${kindName(kind)}格式（${ext || '未知'}）` });
    }

    const used = articleMediaBytes(true);
    if (used + size > ART_TOTAL_LIMIT) {
      return json(res, 400, { ok: false, error: '网站素材空间已满（上限 100GB），先找站长清理一下' });
    }
    const check = uploadAllowed(user.uid, size);
    if (!check.ok) return json(res, 429, { ok: false, error: check.error });

    const uploadId = 'u' + Date.now() + crypto.randomBytes(4).toString('hex');
    fs.mkdirSync(ART_TMP, { recursive: true });
    uploadSessions[uploadId] = {
      uploadId, uid: user.uid, kind, ext, size,
      articleId: parseInt(body.articleId, 10) || 0,
      path: path.join(ART_TMP, uploadId + '.part'),
      got: 0, at: Date.now()
    };
    fs.writeFileSync(uploadSessions[uploadId].path, Buffer.alloc(0));   // 先建个空文件
    return json(res, 200, { ok: true, uploadId });
  }

  if (url === '/article/upload/chunk' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const body = await readJSON(req);
    const s = uploadSessions[String(body.uploadId || '')];
    if (!s || s.uid !== user.uid) return json(res, 400, { ok: false, error: '上传已经过期了，重新来一次' });

    const m = String(body.data || '').match(/^data:[^;]+;base64,([\s\S]*)$/);
    if (!m) return json(res, 400, { ok: false, error: '分片格式不对' });
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > CHUNK_MAX) return json(res, 400, { ok: false, error: '单片太大' });
    if (s.got + buf.length > s.size + CHUNK_MAX) {
      delete uploadSessions[s.uploadId];
      try { fs.rmSync(s.path, { force: true }); } catch { /* 没有就算了 */ }
      return json(res, 400, { ok: false, error: '实际文件比声明的大，已中止' });
    }
    fs.appendFileSync(s.path, buf);
    s.got += buf.length;
    s.at = Date.now();
    return json(res, 200, { ok: true, got: s.got, size: s.size });
  }

  if (url === '/article/upload/finish' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const body = await readJSON(req);
    const s = uploadSessions[String(body.uploadId || '')];
    if (!s || s.uid !== user.uid) return json(res, 400, { ok: false, error: '上传已经过期了，重新来一次' });
    if (!s.got) {
      delete uploadSessions[s.uploadId];
      return json(res, 400, { ok: false, error: '一个字节都没收到' });
    }

    const dir = articleMediaDir(s.articleId || ('draft-' + (user.uid || 0)));
    fs.mkdirSync(dir, { recursive: true });
    const name = Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.' + s.ext;
    fs.renameSync(s.path, path.join(dir, name));
    delete uploadSessions[s.uploadId];

    return json(res, 200, {
      ok: true,
      url: `${API_PREFIX}/article/media/${s.articleId || ('draft-' + (user.uid || 0))}/${name}`,
      kind: s.kind, size: s.got
    });
  }

  if (url === '/article/upload/cancel' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const body = await readJSON(req);
    const s = uploadSessions[String(body.uploadId || '')];
    if (s && s.uid === user.uid) {
      try { fs.rmSync(s.path, { force: true }); } catch { /* 没有就算了 */ }
      delete uploadSessions[s.uploadId];
    }
    return json(res, 200, { ok: true });
  }

  // ===== 取文章里引用的素材 =====
  if (url.startsWith('/article/media/') && method === 'GET') {
    const tail = decodeURIComponent(url.slice('/article/media/'.length).split('?')[0]);
    const parts = tail.split('/');
    // 只放行「文件夹名/文件名」两级，且都不许带 .. 之类
    if (parts.length !== 2 || !parts.every(p => /^[A-Za-z0-9._-]+$/.test(p))) {
      res.writeHead(400); return res.end('Bad Request');
    }
    const full = path.join(articleMediaDir(parts[0]), parts[1]);
    if (!full.startsWith(ART_DIR) || !fs.existsSync(full)) { res.writeHead(404); return res.end('Not Found'); }
    const buf = fs.readFileSync(full);
    const ext = path.extname(parts[1]).slice(1).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MEDIA_MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
    return res.end(buf);
  }

  // ===== 素材空间用了多少（给前端显示，文章+视频共享）=====
  if (url === '/article/quota' && method === 'GET') {
    const used = articleMediaBytes(true);
    return json(res, 200, {
      ok: true,
      used, limit: ART_TOTAL_LIMIT,
      usedMB: +(used / 1024 / 1024).toFixed(1),
      limitGB: ART_TOTAL_LIMIT / 1024 / 1024 / 1024
    });
  }

  /* ===================== 视频系统 ===================== */
  /* 结构和文章系统平行：清单在 videos/index.json，每支视频一个文件夹
       videos/media/<key>/        素材（key=视频id，或草稿 draft-<uid>）
       videos/<id>/comments.json  评论
       videos/<id>/meta.json      简介 / 封面文件名 / 时长
       videos/likes.json / favs.json / reports.json / comment-likes.json          */
  function videoTargetKey(uid, vid) { return (vid > 0) ? String(vid) : ('draft-' + (uid || 0)); }

  // ===== 视频清单（?limit&offset&sort=new|hot&uid=只看某人）=====
  if ((url === '/videos' || url.startsWith('/videos?')) && method === 'GET') {
    const me = findUserByToken(getToken(req));
    const myUid = me ? (me.uid || null) : null;
    const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
    const arg = new URLSearchParams(qs);

    let list = loadVideos();
    const only = parseInt(arg.get('uid'), 10);
    if (only) list = list.filter(a => a.uid === only);
    if (String(arg.get('status') || '') !== 'all') list = list.filter(a => a.status !== 'hidden');

    const likes = loadArr(VID_LIKES);
    const favs  = loadArr(VID_FAVS);
    list = list.map(a => Object.assign({}, a, {
      likes: likes.filter(x => x.videoId === a.id).length,
      favs:  favs.filter(x => x.videoId === a.id).length,
      likedByMe: myUid ? likes.some(x => x.videoId === a.id && x.uid === myUid) : false,
      favedByMe: myUid ? favs.some(x => x.videoId === a.id && x.uid === myUid) : false,
      description: undefined
    }));

    if (arg.get('sort') === 'hot') list.sort((a, b) => (b.likes * 2 + b.favs * 3 + b.views) - (a.likes * 2 + a.favs * 3 + a.views));
    else list.sort((a, b) => (b.id - a.id));

    const limit  = Math.min(Math.max(parseInt(arg.get('limit'), 10) || 20, 1), 100);
    const offset = Math.max(parseInt(arg.get('offset'), 10) || 0, 0);
    return json(res, 200, {
      ok: true,
      total: list.length,
      list: list.slice(offset, offset + limit)
    });
  }

  // ===== 某人点赞过的视频 =====
  if ((url === '/video/liked-by' || url.startsWith('/video/liked-by?')) && method === 'GET') {
    const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
    const uid = parseInt(new URLSearchParams(qs).get('uid'), 10);
    if (!uid || uid < 1) return json(res, 400, { ok: false, error: '缺少或错误的 uid' });
    return json(res, 200, { ok: true, list: videosByActs(VID_LIKES, uid) });
  }
  // ===== 某人收藏过的视频 =====
  if ((url === '/video/faved-by' || url.startsWith('/video/faved-by?')) && method === 'GET') {
    const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
    const uid = parseInt(new URLSearchParams(qs).get('uid'), 10);
    if (!uid || uid < 1) return json(res, 400, { ok: false, error: '缺少或错误的 uid' });
    return json(res, 200, { ok: true, list: videosByActs(VID_FAVS, uid) });
  }

  // ===== 单支视频（元信息一起给）=====
  if ((url === '/video' || url.startsWith('/video?')) && method === 'GET') {
    const me = findUserByToken(getToken(req));
    const myUid = me ? (me.uid || null) : null;
    const arg = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '');
    const id = parseInt(arg.get('id'), 10);
    const a = loadVideos().find(x => x.id === id);
    if (!a) return json(res, 404, { ok: false, error: '视频不存在' });

    const meta = readVideoMeta(id);
    const likes = loadArr(VID_LIKES);
    const favs  = loadArr(VID_FAVS);
    const mine = me && (a.uid === me.uid || isAdmin(me));

    const noView = String(arg.get('noView') || '') === '1';
    if (!noView) {
      const all = loadVideos();
      const t = all.find(x => x.id === id);
      if (t) { t.views = (t.views || 0) + 1; a.views = t.views; saveVideos(all); }
    }

    return json(res, 200, {
      ok: true,
      video: Object.assign({}, a, {
        description: meta.description || '',
        videoUrl: meta.videoName ? ('/video/media/' + id + '/' + meta.videoName) : null,
        poster: meta.posterName || null,
        likes: likes.filter(x => x.videoId === id).length,
        favs:  favs.filter(x => x.videoId === id).length,
        likedByMe: myUid ? likes.some(x => x.videoId === id && x.uid === myUid) : false,
        favedByMe: myUid ? favs.some(x => x.videoId === id && x.uid === myUid) : false,
        canEdit: !!mine
      })
    });
  }

  // ===== 写视频 / 改视频（发布前先把素材传到 draft-<uid> 目录，这里再归位）=====
  if (url === '/video/save' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const no = muteReason(user);
    if (no) return json(res, 403, { ok: false, error: no });

    const body = await readJSON(req);
    const title = String(body.title || '').trim().slice(0, 100);
    if (!title) return json(res, 400, { ok: false, error: '标题不能为空' });
    const description = String(body.description || '').slice(0, VID_MAX_DESC);
    const duration = Number(body.duration) || 0;

    const all = loadVideos();
    const id = parseInt(body.id, 10);
    let a = id ? all.find(x => x.id === id) : null;

    if (a) {
      if (a.uid !== user.uid && !isAdmin(user)) return json(res, 403, { ok: false, error: '只能改自己的视频' });
      a.title = title;
      a.description = description;
      a.duration = duration;
      a.updatedAt = nowTime();
    } else {
      a = {
        id: nextId(all),
        uid: user.uid || null,
        author: user.username,
        title,
        description,
        duration,
        createdAt: nowTime(),
        updatedAt: nowTime(),
        views: 0,
        status: 'normal'
      };
      all.push(a);
      // 把草稿目录里的素材（视频本体 + 封面）归位到正式 id 目录
      const draftDir = videoMediaDir('draft-' + (user.uid || 0));
      const destDir = videoMediaDir(a.id);
      try {
        if (fs.existsSync(draftDir)) {
          fs.mkdirSync(destDir, { recursive: true });
          fs.readdirSync(draftDir).forEach(f => {
            try { fs.renameSync(path.join(draftDir, f), path.join(destDir, f)); } catch { /* 忽略 */ }
          });
          try { fs.rmdirSync(draftDir); } catch { /* 忽略 */ }
        }
      } catch { /* 忽略 */ }
    }
    saveVideos(all);
    writeVideoMeta(a.id, {
      description,
      videoName: String(body.videoName || '').trim() || null,
      posterName: String(body.poster || '').trim() || null,
      duration
    });
    return json(res, 200, { ok: true, id: a.id });
  }

  // ===== 删视频 =====
  if (url === '/video/delete' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const body = await readJSON(req);
    const id = parseInt(body.id, 10);
    const all = loadVideos();
    const a = all.find(x => x.id === id);
    if (!a) return json(res, 404, { ok: false, error: '视频不存在' });
    if (a.uid !== user.uid && !isAdmin(user)) return json(res, 403, { ok: false, error: '只能删自己的视频' });
    saveVideos(all.filter(x => x.id !== id));
    try { fs.rmSync(videoDir(id), { recursive: true, force: true }); } catch { /* 没有就算了 */ }
    saveArr(VID_LIKES, loadArr(VID_LIKES).filter(x => x.videoId !== id));
    saveArr(VID_FAVS,  loadArr(VID_FAVS).filter(x => x.videoId !== id));
    saveArr(VID_CMT_LIKES, loadArr(VID_CMT_LIKES).filter(x => true)); // 评论赞随评论目录删除
    return json(res, 200, { ok: true });
  }

  // ===== 视频点赞 / 收藏 =====
  if ((url === '/video/like' || url === '/video/fav') && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const body = await readJSON(req);
    const id = parseInt(body.id, 10);
    if (!loadVideos().some(x => x.id === id)) return json(res, 404, { ok: false, error: '视频不存在' });
    const isLike = url === '/video/like';
    const file = isLike ? VID_LIKES : VID_FAVS;
    const arr = loadArr(file);
    const i = arr.findIndex(x => x.videoId === id && x.uid === user.uid);
    let on;
    if (i === -1) { arr.push({ videoId: id, uid: user.uid, time: nowTime() }); on = true; }
    else { arr.splice(i, 1); on = false; }
    saveArr(file, arr);
    const count = arr.filter(x => x.videoId === id).length;
    const a = loadVideos().find(x => x.id === id);
    if (a && on && a.uid && a.uid !== user.uid) {
      addNotif(a.uid, {
        type: 'system', fromUid: user.uid, fromName: user.username,
        videoId: id,
        note: (isLike ? '有人赞了你的视频《' : '有人收藏了你的视频《') + a.title + '》',
        href: '/video.html?id=' + id
      });
    }
    return json(res, 200, { ok: true, on, count });
  }

  // ===== 举报视频 =====
  if (url === '/video/report' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const body = await readJSON(req);
    const id = parseInt(body.id, 10);
    const a = loadVideos().find(x => x.id === id);
    if (!a) return json(res, 404, { ok: false, error: '视频不存在' });
    const reports = loadArr(VID_REPORTS);
    if (reports.some(r => r.videoId === id && r.reporterUid === user.uid && r.status === 'pending')) {
      return json(res, 400, { ok: false, error: '你已经举报过了，等管理员处理' });
    }
    reports.push({
      id: nextId(reports), videoId: id, title: a.title, authorUid: a.uid || null, authorName: a.author,
      reporter: user.username, reporterUid: user.uid,
      reason: String(body.reason || '').trim().slice(0, 100) || '未填写理由',
      time: nowTime(), status: 'pending', action: null, handler: null, handleTime: null
    });
    saveArr(VID_REPORTS, reports);
    return json(res, 200, { ok: true });
  }

  // ===== 后台：看视频举报 / 处理（隐藏 / 删视频）=====
  if (url === '/video/reports' && method === 'GET') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    if (!isAdmin(user)) return json(res, 403, { ok: false, error: '只有站长和管理员能看' });
    return json(res, 200, loadArr(VID_REPORTS));
  }
  if (url === '/video/reports' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    if (!isAdmin(user)) return json(res, 403, { ok: false, error: '只有站长和管理员能处理' });
    const body = await readJSON(req);
    const rid = parseInt(body.id, 10);
    const action = String(body.action || '');
    const NAMES = { approve: '放行', hide: '隐藏', remove: '删除' };
    if (!NAMES[action]) return json(res, 400, { ok: false, error: '未知操作' });
    const reports = loadArr(VID_REPORTS);
    const rec = reports.find(r => r.id === rid);
    if (!rec) return json(res, 404, { ok: false, error: '举报不存在' });

    // 被举报的是评论：隐藏 / 删除
    if (rec.kind === 'vcomment' && (action === 'hide' || action === 'remove')) {
      const cl = loadVidComments(rec.videoId);
      const c = cl.find(x => x.id === rec.commentId);
      if (c) {
        if (action === 'hide') { c.hidden = true; c.hideTime = nowTime(); saveVidComments(rec.videoId, cl); }
        else saveVidComments(rec.videoId, cl.filter(x => x.id !== rec.commentId && x.parent !== rec.commentId));
      }
      reports.forEach(r => {
        if (r.commentId === rec.commentId && r.videoId === rec.videoId && r.id !== rec.id && r.status === 'pending') {
          r.status = 'done'; r.action = NAMES[action]; r.handler = user.username; r.handleTime = nowTime();
        }
      });
      rec.status = 'done'; rec.action = NAMES[action]; rec.handler = user.username; rec.handleTime = nowTime();
      saveArr(VID_REPORTS, reports);
      if (rec.authorUid) {
        addNotif(rec.authorUid, {
          type: 'system', fromUid: user.uid, fromName: user.username, videoId: rec.videoId,
          note: action === 'remove' ? '你在《' + rec.title + '》下的评论被管理员删除了'
                                    : '你在《' + rec.title + '》下的评论被管理员隐藏了',
          href: '/video.html?id=' + rec.videoId
        });
      }
      return json(res, 200, { ok: true, note: NAMES[action] });
    }

    if (action === 'hide' || action === 'remove') {
      const all = loadVideos();
      const a = all.find(x => x.id === rec.videoId);
      if (action === 'hide') { if (a) { a.status = 'hidden'; saveVideos(all); } }
      else {
        saveVideos(all.filter(x => x.id !== rec.videoId));
        try { fs.rmSync(videoDir(rec.videoId), { recursive: true, force: true }); } catch { /* 没有就算了 */ }
      }
      reports.forEach(r => {
        if (r.videoId === rec.videoId && r.id !== rec.id && r.status === 'pending') {
          r.status = 'done'; r.action = NAMES[action]; r.handler = user.username; r.handleTime = nowTime();
        }
      });
    }
    rec.status = 'done'; rec.action = NAMES[action]; rec.handler = user.username; rec.handleTime = nowTime();
    saveArr(VID_REPORTS, reports);
    if (rec.authorUid) {
      addNotif(rec.authorUid, {
        type: 'system', fromUid: user.uid, fromName: user.username, videoId: rec.videoId,
        note: action === 'remove' ? '你的视频《' + rec.title + '》因为被举报已删除'
            : action === 'hide'   ? '你的视频《' + rec.title + '》因为被举报已隐藏'
            : '有人举报了你的视频《' + rec.title + '》，管理员看了没问题',
        href: action === 'remove' ? null : ('/video.html?id=' + rec.videoId)
      });
    }
    return json(res, 200, { ok: true, note: NAMES[action] });
  }

  // ===== 视频评论 =====
  if ((url === '/video/comments' || url.startsWith('/video/comments?')) && method === 'GET') {
    const me = findUserByToken(getToken(req));
    const myUid = me ? (me.uid || null) : null;
    const arg = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '');
    const id = parseInt(arg.get('videoId'), 10);
    if (!loadVideos().some(x => x.id === id)) return json(res, 404, { ok: false, error: '视频不存在' });
    const likes = loadArr(VID_CMT_LIKES);
    const list = loadVidComments(id).filter(c => !c.hidden).map(c => Object.assign({}, c, {
      likes: likes.filter(x => x.cid === c.id).length,
      likedByMe: myUid ? likes.some(x => x.cid === c.id && x.uid === myUid) : false
    }));
    return json(res, 200, { ok: true, list });
  }
  if (url === '/video/comment' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const no = muteReason(user);
    if (no) return json(res, 403, { ok: false, error: no });
    const body = await readJSON(req);
    const id = parseInt(body.videoId, 10);
    const a = loadVideos().find(x => x.id === id);
    if (!a) return json(res, 404, { ok: false, error: '视频不存在' });
    const text = String(body.text || '').trim().slice(0, 500);
    if (!text) return json(res, 400, { ok: false, error: '评论不能为空' });
    const list = loadVidComments(id);
    let parent = null, toName = null, toUid = null;
    if (body.parent != null && body.parent !== '') {
      const aim = list.find(c => c.id === parseInt(body.parent, 10));
      if (!aim) return json(res, 400, { ok: false, error: '要回复的那条评论已经不在了' });
      toName = aim.name || null; toUid = aim.uid || null;
      parent = (aim.parent == null) ? aim.id : aim.parent;
    }
    const rec = {
      id: nextId(list), uid: user.uid || null, name: user.username, text, time: nowTime(),
      parent, toName, floor: parent == null ? (list.filter(c => c.floor).length + 1) : null
    };
    list.push(rec);
    saveVidComments(id, list);
    if (toUid && toUid !== user.uid) {
      addNotif(toUid, {
        type: 'system', fromUid: user.uid, fromName: user.username, videoId: id,
        note: '有人回复了你在《' + a.title + '》下的评论', href: '/video.html?id=' + id + '#cmt' + rec.id
      });
    } else if (a.uid && a.uid !== user.uid && parent == null) {
      addNotif(a.uid, {
        type: 'system', fromUid: user.uid, fromName: user.username, videoId: id,
        note: '有人评论了你的视频《' + a.title + '》', href: '/video.html?id=' + id + '#cmt' + rec.id
      });
    }
    return json(res, 200, { ok: true, id: rec.id });
  }
  if (url === '/video/comment/delete' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const body = await readJSON(req);
    const id = parseInt(body.videoId, 10);
    const cid = parseInt(body.id, 10);
    const list = loadVidComments(id);
    const c = list.find(x => x.id === cid);
    if (!c) return json(res, 404, { ok: false, error: '评论不存在' });
    if (c.uid !== user.uid && !isAdmin(user)) return json(res, 403, { ok: false, error: '只能删自己的评论' });
    const gone = list.filter(x => x.id === cid || x.parent === cid).map(x => x.id);
    saveVidComments(id, list.filter(x => x.id !== cid && x.parent !== cid));
    saveArr(VID_CMT_LIKES, loadArr(VID_CMT_LIKES).filter(x => gone.indexOf(x.cid) === -1));
    return json(res, 200, { ok: true, removed: gone.length });
  }
  if (url === '/video/comment/report' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const body = await readJSON(req);
    const id = parseInt(body.videoId, 10);
    const cid = parseInt(body.id, 10);
    const a = loadVideos().find(x => x.id === id);
    if (!a) return json(res, 404, { ok: false, error: '视频不存在' });
    const c = loadVidComments(id).find(x => x.id === cid);
    if (!c) return json(res, 404, { ok: false, error: '评论不存在' });
    const reports = loadArr(VID_REPORTS);
    if (reports.some(r => r.commentId === cid && r.videoId === id && r.reporterUid === user.uid && r.status === 'pending')) {
      return json(res, 400, { ok: false, error: '你已经举报过了，等管理员处理' });
    }
    reports.push({
      id: nextId(reports), kind: 'vcomment', videoId: id, commentId: cid, title: '《' + a.title + '》下的评论',
      text: String(c.text || '').slice(0, 200), authorUid: c.uid || null, authorName: c.name || '匿名',
      reporter: user.username, reporterUid: user.uid,
      reason: String(body.reason || '').trim().slice(0, 100) || '未填写理由',
      time: nowTime(), status: 'pending', action: null, handler: null, handleTime: null
    });
    saveArr(VID_REPORTS, reports);
    return json(res, 200, { ok: true });
  }
  if (url === '/video/comment/like' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const body = await readJSON(req);
    const cid = parseInt(body.id, 10);
    const arr = loadArr(VID_CMT_LIKES);
    const i = arr.findIndex(x => x.cid === cid && x.uid === user.uid);
    let on;
    if (i === -1) { arr.push({ cid, uid: user.uid, time: nowTime() }); on = true; }
    else { arr.splice(i, 1); on = false; }
    saveArr(VID_CMT_LIKES, arr);
    return json(res, 200, { ok: true, on, count: arr.filter(x => x.cid === cid).length });
  }

  // ===== 视频素材上传（base64 小文件）=====
  if (url === '/video/upload' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const no = muteReason(user);
    if (no) return json(res, 403, { ok: false, error: no });
    const body = await readJSON(req);
    const kind = String(body.kind || '');
    const rule = UPLOAD_RULES[kind];
    if (!rule) return json(res, 400, { ok: false, error: '只支持 image / video / audio' });
    const data = String(body.data || '');
    const m = data.match(/^data:([A-Za-z0-9.+\/-]+);base64,([\s\S]*)$/);
    if (!m) return json(res, 400, { ok: false, error: '文件格式不对' });
    const ext = (MIME_EXT[m[1].toLowerCase()] || '').toLowerCase();
    if (!ext || rule.ext.indexOf(ext) === -1) return json(res, 400, { ok: false, error: '不支持的文件类型（' + m[1] + '）' });
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) return json(res, 400, { ok: false, error: '文件是空的' });
    if (buf.length > rule.max) return json(res, 400, { ok: false, error: `${kindName(kind)}最大 ${fmtSize(rule.max)}，这个 ${fmtSize(buf.length)}` });
    const used = articleMediaBytes(true);
    if (used + buf.length > ART_TOTAL_LIMIT) return json(res, 400, { ok: false, error: '网站素材空间已满（上限 100GB），先找站长清理一下' });
    const check = uploadAllowed(user.uid, buf.length);
    if (!check.ok) return json(res, 429, { ok: false, error: check.error });
    const key = videoTargetKey(user.uid, parseInt(body.videoId, 10) || 0);
    const dir = videoMediaDir(key);
    fs.mkdirSync(dir, { recursive: true });
    const name = Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(dir, name), buf);
    return json(res, 200, { ok: true, url: `/video/media/${key}/${name}`, kind, size: buf.length, name });
  }

  // ===== 视频大文件分片上传：start → chunk → finish =====
  if (url === '/video/upload/start' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const no = muteReason(user);
    if (no) return json(res, 403, { ok: false, error: no });
    const body = await readJSON(req);
    const kind = String(body.kind || '');
    const rule = UPLOAD_RULES[kind];
    if (!rule) return json(res, 400, { ok: false, error: '只支持 image / video / audio' });
    const size = parseInt(body.size, 10);
    if (!size || size <= 0) return json(res, 400, { ok: false, error: '文件大小不对' });
    if (size > rule.max) return json(res, 400, { ok: false, error: `${kindName(kind)}最大 ${fmtSize(rule.max)}，这个 ${fmtSize(size)}` });
    let ext = '';
    const nm = String(body.name || '');
    const dot = nm.lastIndexOf('.');
    if (dot !== -1) ext = nm.slice(dot + 1).toLowerCase();
    if (!ext) ext = MIME_EXT[String(body.mime || '').toLowerCase()] || '';
    if (!ext || rule.ext.indexOf(ext) === -1) return json(res, 400, { ok: false, error: `不支持的${kindName(kind)}格式（${ext || '未知'}）` });
    const used = articleMediaBytes(true);
    if (used + size > ART_TOTAL_LIMIT) return json(res, 400, { ok: false, error: '网站素材空间已满（上限 100GB），先找站长清理一下' });
    const check = uploadAllowed(user.uid, size);
    if (!check.ok) return json(res, 429, { ok: false, error: check.error });
    const uploadId = 'v' + Date.now() + crypto.randomBytes(4).toString('hex');
    fs.mkdirSync(VID_TMP, { recursive: true });
    uploadSessions[uploadId] = {
      uploadId, uid: user.uid, kind, ext, size,
      videoId: parseInt(body.videoId, 10) || 0,
      path: path.join(VID_TMP, uploadId + '.part'),
      got: 0, at: Date.now()
    };
    fs.writeFileSync(uploadSessions[uploadId].path, Buffer.alloc(0));
    return json(res, 200, { ok: true, uploadId });
  }
  if (url === '/video/upload/chunk' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const body = await readJSON(req);
    const s = uploadSessions[String(body.uploadId || '')];
    if (!s || s.uid !== user.uid) return json(res, 400, { ok: false, error: '上传已经过期了，重新来一次' });
    const m = String(body.data || '').match(/^data:[^;]+;base64,([\s\S]*)$/);
    if (!m) return json(res, 400, { ok: false, error: '分片格式不对' });
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > CHUNK_MAX) return json(res, 400, { ok: false, error: '单片太大' });
    if (s.got + buf.length > s.size + CHUNK_MAX) {
      delete uploadSessions[s.uploadId];
      try { fs.rmSync(s.path, { force: true }); } catch { /* 忽略 */ }
      return json(res, 400, { ok: false, error: '实际文件比声明的大，已中止' });
    }
    fs.appendFileSync(s.path, buf);
    s.got += buf.length; s.at = Date.now();
    return json(res, 200, { ok: true, got: s.got, size: s.size });
  }
  if (url === '/video/upload/finish' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const body = await readJSON(req);
    const s = uploadSessions[String(body.uploadId || '')];
    if (!s || s.uid !== user.uid) return json(res, 400, { ok: false, error: '上传已经过期了，重新来一次' });
    if (!s.got) { delete uploadSessions[s.uploadId]; return json(res, 400, { ok: false, error: '一个字节都没收到' }); }
    const key = videoTargetKey(user.uid, s.videoId);
    const dir = videoMediaDir(key);
    fs.mkdirSync(dir, { recursive: true });
    const name = Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.' + s.ext;
    fs.renameSync(s.path, path.join(dir, name));
    delete uploadSessions[s.uploadId];
    return json(res, 200, { ok: true, url: `/video/media/${key}/${name}`, kind: s.kind, size: s.got, name });
  }
  if (url === '/video/upload/cancel' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    const body = await readJSON(req);
    const s = uploadSessions[String(body.uploadId || '')];
    if (s && s.uid === user.uid) {
      try { fs.rmSync(s.path, { force: true }); } catch { /* 忽略 */ }
      delete uploadSessions[s.uploadId];
    }
    return json(res, 200, { ok: true });
  }

  // ===== 取视频素材（视频本体 / 封面）=====
  if (url.startsWith('/video/media/') && method === 'GET') {
    const tail = decodeURIComponent(url.slice('/video/media/'.length).split('?')[0]);
    const parts = tail.split('/');
    if (parts.length !== 2 || !parts.every(p => /^[A-Za-z0-9._-]+$/.test(p))) {
      res.writeHead(400); return res.end('Bad Request');
    }
    const full = path.join(videoMediaDir(parts[0]), parts[1]);
    if (!full.startsWith(VID_DIR) || !fs.existsSync(full)) { res.writeHead(404); return res.end('Not Found'); }
    const buf = fs.readFileSync(full);
    const ext = path.extname(parts[1]).slice(1).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MEDIA_MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
    return res.end(buf);
  }

  // ===== 视频素材空间（共享 100GB）=====
  if (url === '/video/quota' && method === 'GET') {
    const used = articleMediaBytes(true);
    return json(res, 200, {
      ok: true, used, limit: ART_TOTAL_LIMIT,
      usedMB: +(used / 1024 / 1024).toFixed(1), limitGB: ART_TOTAL_LIMIT / 1024 / 1024 / 1024
    });
  }

  // ===== 更新日志 =====
  if (url === '/logs' && method === 'GET') {
    return json(res, 200, loadLogs());
  }

  if (url === '/logs' && method === 'POST') {
    const user = findUserByToken(getToken(req));
    if (!user) return json(res, 401, { ok: false, error: '请先登录' });
    // 权限在后端把关：普通人就算自己造请求也发不进来
    if (!isAdmin(user)) return json(res, 403, { ok: false, error: '只有站长和管理员能改更新日志' });

    const body = await readJSON(req);
    const text = String(body.text || '').trim();
    if (!text) return json(res, 400, { ok: false, error: '内容不能为空' });

    const entry = { date: today(), text: text.slice(0, 200), by: user.username };
    const list = loadLogs();
    list.unshift(entry);           // 插到最前面 = 最新
    saveLogs(list);

    return json(res, 200, { ok: true, date: entry.date, text: entry.text });
  }


// ===== 重点关注：只留指定几个人的「近期动态」记录 =====
  if (url === '/feed-watch' && method === 'GET') {
    return json(res, 200, loadWatch());
  }

  // ===== 近期动态：后端代抓 moonbazaar =====
  // 浏览器直连会被 CORS 拦，只能走公共代理，那些代理又慢又爱挂；
  // 后端是 Node，能直连源站（实测 ~300ms），所以让前端改问自己后端。
  if ((url === '/live-feed' || url.startsWith('/live-feed?')) && method === 'GET') {
    const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
    const arg = new URLSearchParams(qs);
    const limit = Math.min(Math.max(parseInt(arg.get('limit'), 10) || 30, 1), 128);
    const offset = Math.max(parseInt(arg.get('offset'), 10) || 0, 0);

    // 缓存 3 秒：页面 5 秒刷一次，几个人同时开着也不会一直打源站
    const key = limit + ':' + offset;
    const hit = feedCache[key];
    if (hit && Date.now() - hit.at < 3000) return json(res, 200, hit.data);

    const data = await feedGetJSON(`${FEED_API}?limit=${limit}&offset=${offset}`);
    if (!data) return json(res, 502, { ok: false, error: 'moonbazaar 这会儿连不上' });

    feedCache[key] = { at: Date.now(), data };
    return json(res, 200, data);
  }

  res.writeHead(404);
  res.end('Not Found');
});

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/* ================= 重点关注（近期动态里指定几个人的记录） =================
   后端每隔一会儿自己去 moonbazaar 抓一次，把命中这几个人的条目攒进
   Backend/test/feed-watch.json。前端「近期动态」页读 /feed-watch 显示。
   注意：这个得后端开着才会攒，电脑关了就抓不到（接口只留最近若干条，
   隔太久再开机补不回来）。 */
const WATCH_FILE = path.join(RESOURCES_DIR, 'test', 'feed-watch.json');
const WATCH_NAMES = ['chengfayunsuan', 'hym666'];
const WATCH_KEEP = 500;                 // 每个人最多留多少条
const WATCH_GAP = 60000;                // 多久抓一次（毫秒）
const FEED_API = 'https://moonbazaar.xyz/home/get_live_feed.php';
const feedCache = {};               // /live-feed 的 3 秒小缓存

const FEED_PROXIES = [
  u => u,
  u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u),
  u => 'https://cors.eu.org/' + u
];

function loadWatch() {
  try {
    const d = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8'));
    if (d && d.users) return d;
  } catch { /* 文件还没生成 */ }
  return { updatedAt: null, users: {} };
}

function saveWatch(db) {
  try {
    fs.mkdirSync(path.dirname(WATCH_FILE), { recursive: true });
    fs.writeFileSync(WATCH_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.log('[feed-watch] 写文件失败：', e.message);
  }
}

const watchFp = tx => `${tx.username}|${tx.source}|${tx.robux_val}|${tx.created_at || tx.time_ago}`;

async function feedGetJSON(url) {
  for (const p of FEED_PROXIES) {
    try {
      const r = await fetch(p(url), { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const d = await r.json();
      if (Array.isArray(d)) return d;
    } catch { /* 换下一个代理 */ }
  }
  return null;
}

let watchBusy = false;
async function tickWatch() {
  if (watchBusy) return 0;
  watchBusy = true;
  try {
    // 实测这个接口最多只留 128 条（约 5~6 小时），limit 给再大也只返回这么多，
    // 所以一次要 128 条就等于把整个历史窗口都拿到了，不用翻页。
    const data = await feedGetJSON(`${FEED_API}?limit=128&offset=0`) || [];
    if (!data.length) return 0;

    const db = loadWatch();
    db.users = db.users || {};
    let added = 0;

    for (const name of WATCH_NAMES) {
      const hits = data.filter(tx => tx.username === name);
      if (!hits.length) continue;
      const old = db.users[name] || [];
      const seen = new Set(old.map(watchFp));
      for (const tx of hits) {
        if (seen.has(watchFp(tx))) continue;
        seen.add(watchFp(tx));
        old.push({
          username: tx.username,
          robux_val: tx.robux_val,
          source: tx.source,
          created_at: tx.created_at || null,
          time_ago: tx.time_ago
        });
        added++;
      }
      old.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
      db.users[name] = old.slice(0, WATCH_KEEP);
    }

    db.updatedAt = new Date().toISOString();
    saveWatch(db);
    if (added) {
      console.log('[feed-watch] +' + added + ' 条 | ' +
        WATCH_NAMES.map(n => n + '=' + (db.users[n] || []).length).join(' '));
    }
    return added;
  } catch (e) {
    console.log('[feed-watch] 这一轮出错：', e.message);
    return 0;
  } finally {
    watchBusy = false;
  }
}

function startWatch() {
  tickWatch();                                            // 一开机先把整个窗口捞回来
  setInterval(tickWatch, WATCH_GAP).unref();              // 之后定时增量
}

migrateMessages();
migrateNotifs();
startWatch();

// 文章 / 视频系统：目录先建好
[ART_DIR, ART_TMP, VID_DIR, VID_TMP].forEach(d => {
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* 已经有了 */ }
});
// 上次没传完的临时分片清掉（文章 + 视频），别白占硬盘
[ART_TMP, VID_TMP].forEach(tmp => {
  try {
    fs.mkdirSync(tmp, { recursive: true });
    fs.readdirSync(tmp).forEach(f => { try { fs.rmSync(path.join(tmp, f), { force: true }); } catch { /* 忽略 */ } });
  } catch { /* 忽略 */ }
});

// 超过 2 小时还没传完的分片会话，定时清掉
setInterval(() => {
  const now = Date.now();
  Object.keys(uploadSessions).forEach(k => {
    if (now - uploadSessions[k].at > 2 * 60 * 60 * 1000) {
      try { fs.rmSync(uploadSessions[k].path, { force: true }); } catch { /* 忽略 */ }
      delete uploadSessions[k];
    }
  });
}, 30 * 60 * 1000).unref();
console.log('素材已用 ' + (articleMediaBytes(true) / 1024 / 1024).toFixed(1) + ' MB / 上限 102400 MB（文章+视频共享）');

server.listen(3000, () => {
  console.log('服务器跑在 http://localhost:3000');
});
