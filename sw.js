/**
 * Service Worker - 英语启蒙家长伴读教练
 * 缓存策略：App Shell Cache First，运行时 Stale While Revalidate
 */
// ⚠️ 版本号必须随每次发版递增。
// 旧策略是"固定缓存名 + App Shell Cache First"，结果是用户永远拿到旧 index.html，
// 出现"代码明明改了、页面却没变"。改名后 activate 阶段会清理全部旧缓存。
// v8 ：接入真实 PNG 图标（favicon/apple-touch-icon/maskable）+ CDN 改懒加载。
// v9 ：计划模块（Plan）统一日程数据源。
// v10：授权与激活码（LICENSE，离线签名验签）。
// v11：走查修复（第 3/4/5 步）—— 排课/计划/打卡数据源统一。
// v12：开发者身份作为独立功能位（DEV=32），同一网址可用开发者码解锁维护入口。
// v13：点读发音静默失败自愈（安卓微信"接口在却不出声"）+ 我的页发音自检。
// v14：M0 收口 —— 删除不可达的设置页死代码、发音引擎可手动切换、兼容性自检。
// v15：更新提示可见 —— 原先"已更新到新版本"会被自动刷新瞬间冲掉，现在留 2.2 秒窗口。
const CACHE_NAME = 'reading-coach-v15';
const ASSETS = [
  // ⚠️ 这里刻意【不写 './'】：
  //    部分静态托管对"目录根"不返回 index.html（直接 404），而 addAll 是"全成或全败"，
  //    一个 404 就会让整个 SW 安装失败、离线能力全部失效。'./index.html' 已足够覆盖首屏。
  './index.html',
  './manifest.json',
  './baseline_books.js',
  './favicon-32.png',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

// CDN 库（Tesseract.js / xlsx）- 首次访问时缓存
const CDN_CACHE = 'cdn-libraries-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // 逐个 add 并各自吞掉失败：addAll 一旦有任一资源取不到就整体失败，
      // 结果是 SW 装不上、离线能力全废。逐个加载则"能缓的缓存、缓不到的不影响其它"。
      .then((cache) => Promise.all(ASSETS.map((u) => cache.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME && key !== CDN_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 只处理 GET 请求
  if (event.request.method !== 'GET') return;

  // 跳过非 http(s) 协议
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 有道TTS接口 - Network Only（需要实时结果）
  if (url.hostname === 'dict.youdao.com') return;

  // CDN 库 - Cache First
  // 说明：tesseract.js(拍照OCR) 与 xlsx(Excel导入) 已改为"用到时才动态加载"，
  // 首次加载仍会走这里缓存下来，之后离线也能用。
  // 注意 host 白名单要覆盖 LibLoader 里用到的所有源，否则备用源不会被缓存。
  if (url.hostname.includes('unpkg.com')
      || url.hostname.includes('cdn.jsdelivr.net')
      || url.hostname.includes('bytecdntp.com')) {
    event.respondWith(
      caches.open(CDN_CACHE).then((cache) => {
        return cache.match(event.request).then((cached) => {
          if (cached) return cached;
          return fetch(event.request).then((response) => {
            // 克隆响应，因为 response.body 只能读一次
            const clone = response.clone();
            cache.put(event.request, clone);
            return response;
          }).catch(() => cached);
        });
      })
    );
    return;
  }

  // App Shell - Network First（优先取新代码，断网时回落缓存）
  // 为什么改：Cache First 会让用户永久停留在旧版本，"改了看不到"的元凶就是它。
  if (url.pathname === '/' || url.pathname.endsWith('index.html')) {
    event.respondWith(
      fetch(event.request).then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      }).catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // 其他请求 - Stale While Revalidate
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request).then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});

// 监听消息
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then((keys) =>
        Promise.all(keys.map((key) => caches.delete(key)))
      )
    );
  }
});
