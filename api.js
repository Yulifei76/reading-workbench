/**
 * 前端 API 调用层 （PostgreSQL 版）
 *
 * 架构：
 *  - 普通数据读写（绘本列表/打卡/输出/学习状态）→ 前端 rdb() 直连 PostgREST，由 RLS 控制权限
 *  - 敏感服务端逻辑（激活码/灌基线库）→ 云函数 callFunction
 *
 * 使用方式：
 *   <script src="https://web-9gikjguf125098e1d-1259652802.tcloudbaseapp.com/js/cloudbase-js-sdk/1.7.2/cloudbase.full.js"></script>
 *   <script src="api.js"></script>
 *
 * 初始化：
 *   await API.init();
 */

const API = (function () {
  let app = null;
  let openid = null;
  let role = 'user';
  let inited = false;

  const ENV_ID = 'reading-workbench-d5db3n0a0cb657';

  // 从登录态中稳健提取用户唯一标识（uid/openid）。
  // CloudBase 1.x 登录态字段位置不定：可能在顶层 uid/openid，
  // 也可能在 user / userInfo / credential / _cache 等嵌套对象里（如 {user: e, _LoginType: 'ANONYMOUS'}）。
  function extractUid(ls) {
    if (!ls) return null;
    const candidates = [ls];
    for (const k of ['user', 'userInfo', 'credential', '_cache', 'authState', 'identity']) {
      if (ls[k] && typeof ls[k] === 'object') candidates.push(ls[k]);
    }
    for (const obj of candidates) {
      for (const key of ['uid', 'openid', 'openId', 'id', 'userId', 'sub', 'uuid']) {
        if (obj && typeof obj[key] === 'string' && obj[key]) {
          // 跳过看起来像 URL/无意义的占位串
          if (obj[key] === 'anonymous') continue;
          return obj[key];
        }
      }
    }
    return null;
  }

  async function init() {
    if (inited) return;
    try {
      app = cloudbase.init({ env: ENV_ID });
      const auth = app.auth();
      // 匿名登录（SDK 1.x 官方写法）：未登录则发起匿名登录获取 openid
      if (!(await auth.getLoginState())) {
        await auth.anonymousAuthProvider().signIn();
      }
      const loginState = await auth.getLoginState();
      openid = extractUid(loginState) || null;

      if (openid) {
        // 开发者身份（本地标记）或查服权限状态
        const stored = localStorage.getItem('_dev_role');
        if (stored === 'developer') { role = 'developer'; }
        else {
          try {
            const res = await call('activate', { action: 'status' });
            if (res.code === 0 && res.data) { role = res.data.role || 'user'; }
          } catch (e) { console.warn('[API] 权限查询失败:', e.message); }
        }
      }
      inited = true;
    } catch (e) {
      console.error('[API] 初始化失败:', e);
      throw e;
    }
  }

  function getOpenId() { return openid; }
  function getRole() { return role; }
  function isDev() { return role === 'developer'; }

  // rdb() 实例（PostgREST 前端直连，走 RLS）
  function rdb() {
    if (!app) throw new Error('请先 await API.init()');
    return app.rdb();
  }

  // 云函数调用（激活码等敏感逻辑）
  async function call(fnName, data) {
    if (!app) await init();
    try {
      const res = await app.callFunction({ name: fnName, data: data || {} });
      return res.result || res;
    } catch (e) {
      console.error(`[API] callFunction ${fnName} 失败:`, e);
      return { code: 'NETWORK', msg: e.message, data: {} };
    }
  }

  // ===== 绘本库（前端 rdb 直连）=====
  const books = {
    /** 列表：scope = 'baseline' | 'private' | 'all' */
    async list(scope = 'all', skip = 0, limit = 100) {
      const db = rdb();
      let query = db.from('books').select('*').range(skip, skip + limit - 1);
      if (scope === 'baseline') query = query.eq('source', 'baseline');
      else if (scope === 'private') query = query.eq('source', 'private').eq('owner', openid);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },

    /** 单本详情 */
    async get(bookId) {
      const db = rdb();
      const { data, error } = await db.from('books').select('*').eq('id', bookId).single();
      if (error) throw error;
      return data;
    },

    /** 用户添加私有绘本 */
    async add(title, series, rawText) {
      const db = rdb();
      const { data, error } = await db.from('books').insert({
        title, series: series || '未分类', raw_text: rawText,
        source: 'private', owner: openid
      }).select('*').single();
      if (error) throw error;
      return data;
    },

    /** 更新学习状态 */
    async updateStatus(bookId, fields) {
      const db = rdb();
      const { data, error } = await db.from('user_books').upsert({
        openid, book_id: bookId, ...fields, updated_at: new Date().toISOString()
      }).select('*').single();
      if (error) throw error;
      return data;
    },

    /** 开发者灌基线库（云函数） */
    async uploadBase(booksArr) {
      return call('books', { action: 'upload_base', books: booksArr });
    },

    /** 批量取分析结果（云函数，按 content_hash 查 book_analyses） */
    async analyses(hashes) {
      return call('books', { action: 'analyses', hashes });
    }
  };

  // ===== 激活码（云函数）=====
  const activate = {
    activate: (code) => call('activate', { action: 'activate', code }),
    status: () => call('activate', { action: 'status' }),
    revoke: (code) => call('activate', { action: 'revoke', code }),
    list: () => call('activate', { action: 'list' })
  };

  // ===== 打卡（前端 rdb 直连）=====
  const checkins = {
    async getByDate(date) {
      const db = rdb();
      const { data, error } = await db.from('checkins').select('*').eq('openid', openid).eq('date', date).maybeSingle();
      if (error) throw error;
      return data;
    },
    async upsert(date, fields) {
      const db = rdb();
      const { data, error } = await db.from('checkins').upsert({
        openid, date, ...fields
      }).select('*').single();
      if (error) throw error;
      return data;
    },
    async listAll() {
      const db = rdb();
      const { data, error } = await db.from('checkins').select('*').eq('openid', openid);
      if (error) throw error;
      return data;
    }
  };

  // ===== 输出库（前端 rdb 直连）=====
  const outputs = {
    async add(word, fields) {
      const db = rdb();
      const { data, error } = await db.from('outputs').upsert({
        openid, word, ...fields
      }).select('*').single();
      if (error) throw error;
      return data;
    },
    async listDue(date) {
      const db = rdb();
      const { data, error } = await db.from('outputs')
        .select('*').eq('openid', openid)
        .lte('next_review', date.toISOString());
      if (error) throw error;
      return data;
    },
    async markReviewed(id) {
      const db = rdb();
      const { data, error } = await db.from('outputs')
        .update({ review_count: db.raw('review_count+1'), last_review: new Date().toISOString() })
        .eq('id', id).eq('openid', openid).select('*').single();
      if (error) throw error;
      return data;
    }
  };

  const ping = (echo) => call('ping', { echo });

  return {
    init, call, rdb, getOpenId, getRole, isDev,
    books, activate, checkins, outputs, ping
  };
})();