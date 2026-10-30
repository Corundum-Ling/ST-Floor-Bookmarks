/**
 * SillyTavern 插件: 楼层书签 (Floor Bookmarks)
 *
 * 定位: 构画(ST-SevenDaysCal)「坐标」功能的轻量平替。
 *      只做「收藏楼层 + 回看 + 跳转 + 单条标注(标题/标签)」，
 *      不含标签体系管理、日程、大纲等重型功能。
 *
 * 适用: SillyTavern 1.18.0
 * 安装: data/default-user/extensions/ST-FloorBookmarks/
 *
 * 存储: data/default-user/user/files/fb-*.json
 *       - fb-index.json   轻量索引(元数据)
 *       - fb-<id>.json    单条正文(HTML 快照)
 *       索引与正文分离 → 删单条只删一个文件，不需重写全量。
 *
 * 设计要点(参考构画 coordinate 模块的正确做法):
 *  1. 读路径 404 才算空，其他错误一律抛出 —— 绝不拿网络错误当空数据覆盖旧收藏
 *  2. 写操作进串行队列 —— 防止并发写互相覆盖
 *  3. HTML 快照经 DOMPurify 清洗 —— 防止收藏里夹带脚本
 *  4. 保存后立即落盘(非防抖) —— 切档时防抖保存会被 ST 取消，导致丢失
 */

const PLUGIN = 'FloorBookmarks';
const INDEX_FILE = 'fb-index.json';
const FILE_PREFIX = 'fb-';
const SCHEMA_VERSION = 1;

// 标题与标签的边界（防止单条收藏被塞成一本书）
const MAX_TITLE_LEN = 60;
const MAX_TAGS = 5;
const MAX_TAG_LEN = 20;

// 划重点的样式表。键名会写进 fb-<id>.json 的 marks[].k，改键名要兼容旧数据。
// 首字母是「族」：h 底色 / f 字色 / u 线型。同族互斥 —— 一段文字同族只能有一种样式。
const MARK_KINDS = {
    'h-y': { cls: 'fb-h-y', label: '黄底' },
    'h-g': { cls: 'fb-h-g', label: '绿底' },
    'h-b': { cls: 'fb-h-b', label: '蓝底' },
    'h-p': { cls: 'fb-h-p', label: '粉底' },
    'f-r': { cls: 'fb-f-r', label: '红字' },
    'f-o': { cls: 'fb-f-o', label: '橙字' },
    'f-b': { cls: 'fb-f-b', label: '蓝字' },
    'f-g': { cls: 'fb-f-g', label: '绿字' },
    'u-s': { cls: 'fb-u-s', label: '下划线' },
    'u-w': { cls: 'fb-u-w', label: '波浪线' },
};
const MARK_FAMILIES = ['h', 'f', 'u'];
// 套层顺序（内 → 外）：线型贴文字，字色居中，底色在最外层
const MARK_WRAP_ORDER = ['u-s', 'u-w', 'f-r', 'f-o', 'f-b', 'f-g', 'h-y', 'h-g', 'h-b', 'h-p'];

const CTX_WAIT_MS = 200;
const CTX_TIMEOUT_MS = 30000;

// ── 运行时状态 ────────────────────────────────────
let panelEl = null;
let indexCache = null;      // { version, items: [] }
let writeQueue = Promise.resolve();
let ctxReady = false;

// 查看器里正在编辑的条目：{ id, tags: [] }
let editCtx = null;
// 上一次渲染的「已有标签」列表，供点击时按下标取回（避免把中文塞进 data-*）
let editPoolTags = [];
let editingComposing = false;

// ── 上下文 ────────────────────────────────────────

function ctx() {
    return window.SillyTavern?.getContext?.() ?? null;
}

function waitForContext() {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
            const c = ctx();
            if (c && c.eventSource && typeof c.saveMetadata === 'function') return resolve(c);
            if (Date.now() - start > CTX_TIMEOUT_MS) return reject(new Error('等待 ST 上下文超时'));
            setTimeout(tick, CTX_WAIT_MS);
        };
        tick();
    });
}

// ═══════════════════════════════════════════════════════════════
//  存储层
// ═══════════════════════════════════════════════════════════════

function headers() {
    const c = ctx();
    return c?.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' };
}

/** UTF-8 → base64。直接 btoa(中文) 会抛 InvalidCharacterError。 */
function toBase64(text) {
    const bytes = new TextEncoder().encode(String(text ?? ''));
    let binary = '';
    // 分块，避免 String.fromCharCode(...bigArray) 爆栈
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

function fileUrl(name) {
    return `/user/files/${name}`;
}

async function uploadJson(name, value) {
    const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ name, data: toBase64(JSON.stringify(value)) }),
    });
    if (!res.ok) throw new Error(`写入 ${name} 失败: HTTP ${res.status}`);
    return (await res.json()).path;
}

/** 返回 { missing, value }。只有 404 算 missing，其他错误抛出。 */
async function readJson(name) {
    const res = await fetch(fileUrl(name), { method: 'GET', cache: 'no-cache', headers: headers() });
    if (res.status === 404) return { missing: true, value: null };
    if (!res.ok) throw new Error(`读取 ${name} 失败: HTTP ${res.status}`);
    try {
        return { missing: false, value: JSON.parse(await res.text()) };
    } catch (e) {
        throw new Error(`解析 ${name} 失败: 文件内容不是合法 JSON`);
    }
}

async function deleteFile(name) {
    const res = await fetch('/api/files/delete', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ path: `user/files/${name}` }),
    });
    if (!res.ok && res.status !== 404) throw new Error(`删除 ${name} 失败: HTTP ${res.status}`);
}

/** 串行化写操作，避免并发互相覆盖 */
function enqueue(task) {
    const next = writeQueue.then(task, task);
    writeQueue = next.catch(() => {});
    return next;
}

// ── 索引 ──────────────────────────────────────────

function emptyIndex() {
    return { version: SCHEMA_VERSION, items: [] };
}

/**
 * 把任意输入规整成合法标签数组：去空白、去重、限长、限数量。
 * 老索引里没有 tags 字段 —— 走 Array.isArray 兜底成空数组，不需要迁移脚本。
 */
function normTags(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const t of raw) {
        if (typeof t !== 'string') continue;
        const v = t.trim().slice(0, MAX_TAG_LEN);
        if (!v || out.includes(v)) continue;
        out.push(v);
        if (out.length >= MAX_TAGS) break;
    }
    return out;
}

function normalizeIndex(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return null;
    return {
        version: Number(raw.version) || SCHEMA_VERSION,
        items: raw.items.filter(i => i && typeof i === 'object' && i.id).map(i => healMeta({
            id: String(i.id),
            chatId: i.chatId ?? null,
            chatIdHash: i.chatIdHash ?? null,
            chatName: String(i.chatName || ''),
            charName: String(i.charName || ''),
            charId: i.charId === undefined || i.charId === null ? null : String(i.charId),
            isGroup: !!i.isGroup,
            floor: Number(i.floor) || 0,
            swipeId: Number(i.swipeId) || 0,
            sender: String(i.sender || ''),
            preview: String(i.preview || ''),
            ts: Number(i.ts) || 0,
            title: String(i.title || '').trim().slice(0, MAX_TITLE_LEN),
            tags: normTags(i.tags),
        })),
    };
}

async function loadIndex(force = false) {
    if (indexCache && !force) return indexCache;
    const result = await readJson(INDEX_FILE);
    const next = result.missing ? emptyIndex() : normalizeIndex(result.value);
    if (!next) throw new Error('索引文件结构损坏，已中止以免覆盖');
    indexCache = next;
    return indexCache;
}

function saveIndex() {
    return uploadJson(INDEX_FILE, indexCache);
}

function fileOf(id) {
    return `${FILE_PREFIX}${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.json`;
}

// ═══════════════════════════════════════════════════════════════
//  楼层身份
// ═══════════════════════════════════════════════════════════════

/** 与构画一致的字符串哈希，用于聊天改名后仍能对上。 */
function strHash(input) {
    const s = String(input ?? '');
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
        const ch = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function currentChat() {
    const c = ctx();
    if (!c) return null;
    const isGroup = c.groupId !== undefined && c.groupId !== null && c.groupId !== '';
    const charName = isGroup
        ? (c.groups?.[c.groupId]?.name || '')
        : (c.name2 || c.characterName || c.characters?.[c.characterId]?.name || '');
    const chatId = c.chatId || '';
    const rawCharId = c.characterId;
    return {
        chatId,
        chatIdHash: chatId ? strHash(chatId) : null,
        chatName: deriveChatName(chatId, charName),
        charName: charName || '未知角色',
        // 只用来判断「是不是同一张角色卡」，切换聊天要靠它兜底校验
        charId: isGroup || rawCharId === undefined || rawCharId === null ? null : String(rawCharId),
        isGroup,
    };
}

/**
 * 从 chatId 剥出「纯聊天名」。
 *
 * ST 的 chatId 就是聊天文件名（不含 .jsonl）：
 *   单角色: `{角色名} - {日期时间}`  → 如 `斯莫特·诺瓦尔 - 2026-06-16@09h13m12s789ms - Branch #16`
 *   群聊  : groups[].chat_id，通常是独立命名
 *
 * 之前直接用 chatMetadata.name，它是空的，于是回退到角色名，
 * 导致面板显示「斯莫特·诺瓦尔 斯莫特·诺瓦尔」这种重复。
 */
function deriveChatName(chatId, charName) {
    const id = String(chatId || '').trim();
    if (!id) return '未命名聊天';

    // chatMetadata.name 优先（用户可能自定义过存档名）
    const metaName = ctx()?.chatMetadata?.name;
    if (typeof metaName === 'string' && metaName.trim()) return metaName.trim();

    // 剥掉 `{角色名} - ` 前缀
    if (charName) {
        const prefix = `${charName} - `;
        if (id.startsWith(prefix)) {
            const rest = id.slice(prefix.length).trim();
            if (rest) return rest;
        }
    }

    return id;
}

/**
 * 读时修复历史数据。
 * v1.1.0 及更早写入的 chatName 是错的（等于角色名），不改用户数据，
 * 只在读取时按 chatId 重新推导。
 */
function healMeta(item) {
    const charName = String(item.charName || '').trim();
    const chatId = String(item.chatId || '').trim();
    if (!chatId) return item;

    // 旧数据特征：chatName 为空、或恰好等于角色名、或等于整个 chatId
    const bad = !item.chatName || item.chatName === charName || item.chatName === chatId;
    if (!bad) return item;

    let fixed = chatId;
    if (charName && chatId.startsWith(`${charName} - `)) {
        fixed = chatId.slice(charName.length + 3).trim() || chatId;
    }
    return { ...item, chatName: fixed };
}

// ═══════════════════════════════════════════════════════════════
//  快照捕获
// ═══════════════════════════════════════════════════════════════

/** 清洗 HTML：去掉 script、on* 事件、危险协议 */
function sanitize(htmlRaw) {
    let html = String(htmlRaw ?? '');
    if (window.DOMPurify?.sanitize) {
        html = window.DOMPurify.sanitize(html, {
            ADD_TAGS: ['style'],
            FORBID_TAGS: ['script'],
            FORBID_ATTR: [/^on/i],
        });
        return html;
    }
    // DOMPurify 不可用时退化为纯文本，宁可丢格式也不放脚本
    return `<p>${escapeHtml(stripTags(html))}</p>`;
}

function stripTags(html) {
    const box = document.createElement('template');
    box.innerHTML = String(html ?? '');
    box.content.querySelectorAll('script, style').forEach(n => n.remove());
    return box.content.textContent || '';
}

function makePreview(html, max = 140) {
    const text = stripTags(html).replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 取某层当前显示版本的 HTML 快照 */
function captureFloor(mesid) {
    const c = ctx();
    const m = c?.chat?.[mesid];
    if (!m) return null;

    const swipeId = m.swipe_id ?? 0;

    // 优先取 DOM 里已渲染的 .mes_text（含用户自定义 CSS 效果）
    const el = document.querySelector(`.mes[mesid="${mesid}"] .mes_text`);
    let html;
    if (el) {
        html = el.innerHTML;
    } else {
        // 未渲染时退回原始文本（当前 swipe 版本，注意 m.mes 永远是第 0 个）
        const raw = Array.isArray(m.swipes) && m.swipes.length > 0
            ? (m.swipes[swipeId] ?? m.mes)
            : m.mes;
        html = String(raw ?? '').replace(/\n/g, '<br>');
    }

    return {
        html: sanitize(html),
        swipeId,
        sender: m.name || (m.is_user ? (c.name1 || 'You') : (currentChat()?.charName || '')),
    };
}

// ═══════════════════════════════════════════════════════════════
//  收藏操作
// ═══════════════════════════════════════════════════════════════

function findItem(items, chatId, floor, swipeId) {
    return items.findIndex(i =>
        String(i.chatId) === String(chatId) &&
        Number(i.floor) === Number(floor) &&
        Number(i.swipeId) === Number(swipeId)
    );
}

/** 当前层是否已收藏（同层同 swipe 版本才算） */
function isBookmarked(chatId, floor, swipeId) {
    const items = indexCache?.items;
    if (!items) return false;
    return findItem(items, chatId, floor, swipeId) >= 0;
}

async function toggleBookmark(mesid, btn) {
    const chat = currentChat();
    if (!chat || !chat.chatId) {
        toastr?.warning?.('当前没有打开的聊天');
        return;
    }

    const snap = captureFloor(mesid);
    if (!snap) {
        toastr?.warning?.(`找不到第 ${mesid + 1} 层`);
        return;
    }

    try {
        await loadIndex();
        const idx = findItem(indexCache.items, chat.chatId, mesid, snap.swipeId);

        if (idx >= 0) {
            // ── 取消收藏 ──
            const removed = indexCache.items[idx];
            await enqueue(async () => {
                await deleteFile(fileOf(removed.id));
                indexCache.items.splice(idx, 1);
                await saveIndex();
            });
            btn?.classList.remove('fb-on');
            toastr?.info?.(`已取消收藏第 ${mesid + 1} 层`);
        } else {
            // ── 新增收藏 ──
            const id = globalThis.crypto?.randomUUID?.() ||
                `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

            const meta = {
                id,
                chatId: chat.chatId,
                chatIdHash: chat.chatIdHash,
                chatName: chat.chatName,
                charName: chat.charName,
                charId: chat.charId,
                isGroup: chat.isGroup,
                floor: mesid,
                swipeId: snap.swipeId,
                sender: snap.sender,
                preview: makePreview(snap.html),
                ts: Date.now(),
                title: '',
                tags: [],
            };

            await enqueue(async () => {
                await uploadJson(fileOf(id), { ...meta, html: snap.html });
                indexCache.items.push(meta);
                await saveIndex();
            });

            btn?.classList.add('fb-on');
            toastr?.success?.(`已收藏第 ${mesid + 1} 层`);
        }

        renderPanel();
    } catch (e) {
        console.error(`[${PLUGIN}]`, e);
        toastr?.error?.(`操作失败: ${e.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════
//  星标按钮注入
// ═══════════════════════════════════════════════════════════════

// 扫描计数器 —— 用于验证「打开大聊天时插件到底跑了多少次扫描」
const stats = { scans: 0, injected: 0 };

/**
 * 为单条消息注入书签按钮。
 *
 * 判据是「DOM 里是否真的有按钮」而不是 dataset 缓存 —— 因为
 * 柏宝工具箱(ST-BaiBai-Tools)的长聊天优化会重建 .mes 内部节点，
 * 缓存标记会残留而按钮已被清掉，导致那层永远不再注入。
 */
function injectOne(mesEl) {
    if (!mesEl) return false;

    const mesid = Number(mesEl.getAttribute('mesid'));
    if (!Number.isFinite(mesid)) return false;

    const holder = mesEl.querySelector('.mes_buttons')
        || mesEl.querySelector('.mes_block');
    if (!holder) return false;

    // 以 DOM 为准：按钮还在就不重复插
    const existing = holder.querySelector('.fb-star');
    if (existing) {
        // 顺手校正状态（swipe 切换后可能变了）
        syncStar(existing, mesid);
        return false;
    }

    const btn = document.createElement('div');
    btn.className = 'mes_button fb-star fa-solid fa-bookmark';
    btn.title = '收藏本层（楼层书签）';
    btn.dataset.mesid = String(mesid);

    syncStar(btn, mesid);

    btn.addEventListener('click', e => {
        e.stopPropagation();
        e.preventDefault();
        toggleBookmark(Number(btn.dataset.mesid), btn);
    });

    holder.appendChild(btn);
    stats.injected++;
    return true;
}

/**
 * 全量补扫 —— **只在明确时机调用**（聊天加载完、面板打开）。
 * 绝不挂在 MutationObserver 或高频事件上。
 * 关键：不删任何已有按钮，只补缺失的，避免 DOM 变动引发观察者风暴。
 */
function injectAll() {
    stats.scans++;
    const chat = ctx()?.chat;
    if (!Array.isArray(chat) || chat.length === 0) return;

    // 只扫 DOM 里实际存在的 .mes（ST 会做懒加载，DOM 数量 ≈ 视口内 + 缓冲）
    document.querySelectorAll('#chat > .mes[mesid]').forEach(injectOne);
}

/** 按当前收藏状态刷新单个星标外观（只改 class，不动 DOM 结构） */
function syncStar(btn, mesid) {
    const chat = currentChat();
    const m = ctx()?.chat?.[mesid];
    if (!chat?.chatId || !m) return;
    const on = isBookmarked(chat.chatId, mesid, m.swipe_id ?? 0);
    btn.classList.toggle('fb-on', on);
}

/**
 * 刷新所有已存在星标的状态。
 * 只遍历 DOM 里已有的 .fb-star 并改 class —— 不删除、不重建、不产生 DOM 增删。
 * 这是修复「观察者反馈循环」的核心：改 class 不触发 childList 类观察者。
 */
function refreshStars() {
    document.querySelectorAll('#chat > .mes[mesid] .fb-star')
        .forEach(btn => {
            const mesid = Number(btn.dataset.mesid);
            if (Number.isFinite(mesid)) syncStar(btn, mesid);
        });
}

/**
 * 合并式调度：把一帧内多次触发合并成一次执行。
 * 修复原 v1.0.0 的致命问题 —— 1368 层的聊天会触发 1368 次 MESSAGE_RENDERED，
 * 原本每次都排队一个 setTimeout(0) 做全量扫描，导致上百万次 DOM 查询。
 */
let rafScheduled = false;
function scheduleInject() {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
        rafScheduled = false;
        injectAll();
    });
}

// ═══════════════════════════════════════════════════════════════
//  面板
// ═══════════════════════════════════════════════════════════════

function buildPanel() {
    panelEl = document.createElement('div');
    panelEl.id = 'fb-panel';
    panelEl.innerHTML = `
        <div class="fb-head">
            <i class="fa-solid fa-grip-vertical fb-grip" title="拖动"></i>
            <i class="fa-solid fa-bookmark"></i>
            <span>楼层书签</span>
            <span class="fb-count"></span>
            <i class="fa-solid fa-arrows-rotate fb-btn fb-reload" title="重新载入"></i>
            <i class="fa-solid fa-window-minimize fb-btn fb-collapse" title="折叠/展开"></i>
            <i class="fa-solid fa-xmark fb-btn fb-close" title="关闭"></i>
        </div>
        <div class="fb-body">
            <div class="fb-filters">
                <input type="text" class="fb-search text_pole" placeholder="搜索内容 / 发送者…">
                <select class="fb-filter text_pole">
                    <option value="all">全部收藏</option>
                    <option value="current">只看当前聊天</option>
                    <option value="other">只看其他聊天</option>
                </select>
            </div>
            <div class="fb-list"></div>
        </div>
        <div class="fb-resize fb-resize-r" title="调整宽度"></div>
        <div class="fb-resize fb-resize-b" title="调整高度"></div>
        <div class="fb-resize fb-resize-l" title="调整宽度"></div>
        <div class="fb-resize fb-resize-se" title="调整大小"></div>
        <div class="fb-resize fb-resize-sw" title="调整大小"></div>`;

    document.body.appendChild(panelEl);

    panelEl.querySelector('.fb-close').addEventListener('click', () =>
        panelEl.classList.remove('fb-show'));

    panelEl.querySelector('.fb-collapse').addEventListener('click', () => {
        panelEl.classList.toggle('fb-collapsed');
        savePanelGeometry();
    });

    panelEl.querySelector('.fb-reload').addEventListener('click', async () => {
        try {
            await loadIndex(true);
            renderPanel();
            refreshStars();
            toastr?.info?.('已重新载入');
        } catch (e) {
            toastr?.error?.(e.message);
        }
    });

    panelEl.querySelector('.fb-search').addEventListener('input', debounce(renderPanel, 150));
    panelEl.querySelector('.fb-filter').addEventListener('change', renderPanel);

    makeDraggable(panelEl);
    makeResizable(panelEl, new Set(['.fb-resize']));

    renderPanel();
}

// ── 面板几何：位置/尺寸持久化 ─────────────────────
// 存在 localStorage（是设备相关的 UI 状态，不该跟聊天数据走）

const GEOM_KEY = `${PLUGIN}_panelGeom`;

function savePanelGeometry() {
    if (!panelEl) return;
    const r = panelEl.getBoundingClientRect();
    try {
        localStorage.setItem(GEOM_KEY, JSON.stringify({
            left: Math.round(r.left),
            top: Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height),
            collapsed: panelEl.classList.contains('fb-collapsed'),
        }));
    } catch { /* 隐私模式下 localStorage 可能不可用 */ }
}

function restorePanelGeometry() {
    if (!panelEl) return;
    let g = null;
    try { g = JSON.parse(localStorage.getItem(GEOM_KEY) || 'null'); } catch { /* ignore */ }

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (!g) {
        // 默认：右上角，但小屏上占满大部分宽度
        const w = Math.min(420, vw - 24);
        panelEl.style.width = `${w}px`;
        panelEl.style.height = '';
        panelEl.style.left = `${Math.max(8, vw - w - 16)}px`;
        panelEl.style.top = '60px';
        return;
    }

    // 夹回视口内（窗口变小、换设备、或上次拖到边缘后可能跑出可视区）
    const w = Math.min(Math.max(240, g.width || 420), vw - 8);
    const h = g.height ? Math.min(Math.max(160, g.height), vh - 8) : null;

    // 面板完整可见：left/top 上限是 视口 - 面板尺寸
    const maxLeft = Math.max(0, vw - w);
    const maxTop = Math.max(0, vh - (h || Math.min(vh, 400)));
    const left = Math.min(Math.max(0, g.left ?? (vw - w - 16)), maxLeft);
    const top = Math.min(Math.max(0, g.top ?? 60), maxTop);

    panelEl.style.width = `${w}px`;
    if (h) panelEl.style.height = `${h}px`;
    panelEl.style.left = `${left}px`;
    panelEl.style.top = `${top}px`;
    panelEl.classList.toggle('fb-collapsed', !!g.collapsed);
}

// ── 拖动 ──────────────────────────────────────────
// 用 Pointer Events 统一鼠标 / 触屏 / 触控笔，移动端无需额外分支。

function makeDraggable(panel) {
    const handle = panel.querySelector('.fb-head');
    if (!handle) return;

    let dragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    let pointerId = null;

    const onDown = e => {
        // 点在按钮上不触发拖动
        if (e.target.closest('.fb-btn')) return;
        if (e.button !== undefined && e.button !== 0) return;

        const r = panel.getBoundingClientRect();
        dragging = true;
        pointerId = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        startLeft = r.left;
        startTop = r.top;

        handle.setPointerCapture?.(e.pointerId);
        panel.classList.add('fb-dragging');
        e.preventDefault();
    };

    const onMove = e => {
        if (!dragging || e.pointerId !== pointerId) return;

        const w = panel.offsetWidth;
        const h = panel.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        // 严格夹在视口内：面板完整可见，不允许拖出边界。
        // 面板比视口还大时（小屏），退化为贴边（left/top 取 0）。
        const minLeft = w >= vw ? 0 : 0;
        const maxLeft = w >= vw ? 0 : vw - w;
        const minTop = 0;
        const maxTop = h >= vh ? 0 : vh - h;

        const rawLeft = startLeft + (e.clientX - startX);
        const rawTop = startTop + (e.clientY - startY);

        const left = Math.min(Math.max(minLeft, rawLeft), Math.max(minLeft, maxLeft));
        const top = Math.min(Math.max(minTop, rawTop), Math.max(minTop, maxTop));

        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        e.preventDefault();
    };

    const onUp = e => {
        if (!dragging) return;
        dragging = false;
        panel.classList.remove('fb-dragging');
        handle.releasePointerCapture?.(e.pointerId);
        savePanelGeometry();
    };

    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
}

// ── 缩放 ──────────────────────────────────────────

function makeResizable(panel, handlesSet) {
    const handles = [...panel.querySelectorAll('.fb-resize')];
    if (handles.length === 0) return;

    let resizing = null;
    let startX = 0, startY = 0, startRect = null;
    let pointerId = null;

    const onDown = e => {
        if (e.button !== undefined && e.button !== 0) return;

        const dir = e.target.classList.contains('fb-resize-r') ? 'r'
            : e.target.classList.contains('fb-resize-l') ? 'l'
            : e.target.classList.contains('fb-resize-b') ? 'b'
            : e.target.classList.contains('fb-resize-se') ? 'se'
            : e.target.classList.contains('fb-resize-sw') ? 'sw'
            : null;
        if (!dir) return;

        resizing = dir;
        pointerId = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        startRect = panel.getBoundingClientRect();

        e.target.setPointerCapture?.(e.pointerId);
        panel.classList.add('fb-resizing');
        e.preventDefault();
        e.stopPropagation();
    };

    const onMove = e => {
        if (!resizing || e.pointerId !== pointerId) return;

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const MIN_W = 240;
        const MIN_H = 160;

        let { width, height, left, top } = startRect;

        if (resizing === 'r' || resizing === 'se') {
            width = Math.max(MIN_W, startRect.width + dx);
        } else if (resizing === 'l' || resizing === 'sw') {
            width = Math.max(MIN_W, startRect.width - dx);
        }
        if (resizing === 'b' || resizing === 'se' || resizing === 'sw') {
            height = Math.max(MIN_H, startRect.height + dy);
        }
        if (resizing === 'l' || resizing === 'sw') {
            left = startRect.left + (startRect.width - width);
        }

        // 严格夹在视口内：右侧/底部不越界，左侧/顶部也不越界
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        width = Math.min(width, vw);
        if (height) height = Math.min(height, vh);

        // 左边界：向左拉时不能越过屏幕左边
        if (left < 0) {
            width += left;               // 吃掉越界的那部分宽度
            left = 0;
        }
        if (width < MIN_W) width = Math.min(MIN_W, vw);

        // 右边界
        if (left + width > vw) {
            if (resizing === 'l' || resizing === 'sw') {
                width = Math.max(MIN_W, vw - left);
            } else {
                width = Math.max(MIN_W, vw - left);
            }
        }

        // 上下边界
        if (top < 0) top = 0;
        if (height && top + height > vh) {
            if (resizing === 'b' || resizing === 'se' || resizing === 'sw') {
                height = Math.max(MIN_H, vh - top);
            }
        }

        panel.style.width = `${Math.round(width)}px`;
        if (height) panel.style.height = `${Math.round(height)}px`;
        panel.style.left = `${Math.round(left)}px`;
        panel.style.top = `${Math.round(top)}px`;

        e.preventDefault();
    };

    const onUp = e => {
        if (!resizing) return;
        resizing = null;
        panel.classList.remove('fb-resizing');
        e.target.releasePointerCapture?.(e.pointerId);
        savePanelGeometry();
    };

    for (const h of handles) {
        h.addEventListener('pointerdown', onDown);
        h.addEventListener('pointermove', onMove);
        h.addEventListener('pointerup', onUp);
        h.addEventListener('pointercancel', onUp);
    }
}

// ── 简单防抖 ──

function debounce(fn, ms) {
    let t = null;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

// ── 筛选 ──────────────────────────────────────────

/**
 * 按「角色卡 → 聊天」两级筛选。
 * 返回按角色卡分组后的结构，供渲染使用。
 */
/**
 * 角色卡 → 聊天 两级分组。
 *
 * 排序规则（v1.3.0 起）：当前角色卡置顶，其余按收藏数降序；组内当前聊天
 * 置顶，其余按最近收藏时间降序。分支聊天（`- Branch #N`）名字高度相似，
 * 把人现在待着的地方顶到最上面，才不用在一堆近似名字里找。
 */
function groupItems(items, cur) {
    const byChar = new Map();

    for (const it of items) {
        const charKey = String(it.charName || '未知角色');
        if (!byChar.has(charKey)) {
            byChar.set(charKey, { charName: charKey, charId: it.charId || null, chats: new Map(), total: 0 });
        }
        const g = byChar.get(charKey);
        if (!g.charId && it.charId) g.charId = it.charId;
        const chatKey = String(it.chatId || '');
        if (!g.chats.has(chatKey)) {
            g.chats.set(chatKey, { chatId: chatKey, chatName: it.chatName || '未命名聊天', items: [] });
        }
        g.chats.get(chatKey).items.push(it);
        g.total++;
    }

    const lastTs = c => Math.max(...c.items.map(i => i.ts || 0));
    const isCurChat = c => !!cur?.chatId && String(c.chatId) === String(cur.chatId);
    // 旧收藏没有 charId，只能退回名字比较
    const isCurChar = g => {
        if (!cur) return false;
        if (cur.charId && g.charId) return String(cur.charId) === String(g.charId);
        return String(cur.charName) === String(g.charName);
    };

    return [...byChar.values()].map(g => ({
        ...g,
        chats: [...g.chats.values()].sort((a, b) => {
            const ca = isCurChat(a) ? 1 : 0;
            const cb = isCurChat(b) ? 1 : 0;
            if (ca !== cb) return cb - ca;
            return lastTs(b) - lastTs(a);
        }),
    })).sort((a, b) => {
        const ca = isCurChar(a) ? 1 : 0;
        const cb = isCurChar(b) ? 1 : 0;
        if (ca !== cb) return cb - ca;
        return b.total - a.total;
    });
}

function visibleItems() {
    const all = indexCache?.items ?? [];
    if (!panelEl) return all;

    const mode = panelEl.querySelector('.fb-filter')?.value || 'all';
    const kw = (panelEl.querySelector('.fb-search')?.value || '').trim().toLowerCase();
    const chat = currentChat();

    let items = all;

    if (mode === 'current') {
        items = chat?.chatId
            ? items.filter(i => String(i.chatId) === String(chat.chatId))
            : [];
    } else if (mode === 'other') {
        items = chat?.chatId
            ? items.filter(i => String(i.chatId) !== String(chat.chatId))
            : items;
    }

    if (kw) {
        items = items.filter(i =>
            String(i.preview || '').toLowerCase().includes(kw) ||
            String(i.title || '').toLowerCase().includes(kw) ||
            (Array.isArray(i.tags) && i.tags.some(t => t.toLowerCase().includes(kw))) ||
            String(i.sender || '').toLowerCase().includes(kw) ||
            String(i.chatName || '').toLowerCase().includes(kw) ||
            String(i.charName || '').toLowerCase().includes(kw)
        );
    }

    return items;
}

function renderPanel() {
    if (!panelEl) return;
    const list = panelEl.querySelector('.fb-list');
    const items = visibleItems();
    const all = indexCache?.items ?? [];

    panelEl.querySelector('.fb-count').textContent =
        items.length === all.length ? `${all.length} 条` : `${items.length} / ${all.length} 条`;

    if (items.length === 0) {
        list.innerHTML = all.length === 0
            ? '<div class="fb-empty">还没有收藏。<br>点击消息旁的 <i class="fa-solid fa-bookmark"></i> 收藏本层。</div>'
            : '<div class="fb-empty">没有符合条件的收藏。</div>';
        return;
    }

    const cur = currentChat();
    const groups = groupItems(items, cur);

    let html = '';
    for (const g of groups) {
        html += `<div class="fb-group">
            <div class="fb-group-head" data-char="${escapeAttr(g.charName)}">
                <i class="fa-solid fa-chevron-down fb-caret"></i>
                <i class="fa-solid fa-user fb-gicon"></i>
                <span class="fb-gname">${escapeHtml(g.charName)}</span>
                <span class="fb-gcount">${g.total}</span>
            </div>
            <div class="fb-group-body">`;

        for (const ch of g.chats) {
            const isCur = cur?.chatId && String(ch.chatId) === String(cur.chatId);
            html += `<div class="fb-chat${isCur ? ' fb-chat-cur' : ''}">
                <div class="fb-chat-head">
                    <i class="fa-solid fa-comments fb-chicon"></i>
                    <span class="fb-chname">${escapeHtml(ch.chatName)}</span>
                    ${isCur ? '<span class="fb-cur-tag">当前</span>' : ''}
                    <span class="fb-chcount">${ch.items.length}</span>
                    ${isCur ? '' : `<i class="fa-solid fa-arrow-right-to-bracket fb-chat-open" data-chat="${escapeHtml(ch.chatId)}" title="切换到该聊天"></i>`}
                </div>`;

            for (const i of ch.items.slice().sort((a, b) => (a.floor - b.floor))) {
                const swipe = Number(i.swipeId) > 0
                    ? `<span class="fb-swipe">版本${Number(i.swipeId) + 1}</span>` : '';
                const title = String(i.title || '').trim();
                const tags = Array.isArray(i.tags) ? i.tags : [];
                // 有标题时正文降为副行并收紧行数，避免一条占掉半屏
                html += `
                <div class="fb-item" data-id="${escapeAttr(i.id)}">
                    <div class="fb-meta">
                        <span class="fb-sender">${escapeHtml(i.sender || '(无名)')}</span>
                        <span class="fb-where">第 ${Number(i.floor) + 1} 层</span>
                        ${swipe}
                    </div>
                    ${title ? `<div class="fb-title">${escapeHtml(title)}</div>` : ''}
                    <div class="fb-text${title ? ' fb-text-sub' : ''}">${escapeHtml(i.preview)}</div>
                    ${tags.length ? `<div class="fb-tags">${tags
                        .map(t => `<span class="fb-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
                    <div class="fb-foot">
                        <span class="fb-time">${formatTime(i.ts)}</span>
                    </div>
                    <div class="fb-acts">
                        <i class="fa-solid fa-pen fb-edit" title="编辑标题与标签"></i>
                        <i class="fa-solid fa-copy fb-copy" title="复制正文"></i>
                        <i class="fa-solid fa-file-arrow-down fb-export" title="导出为 Markdown"></i>
                        <i class="fa-solid fa-eye fb-view" title="查看完整消息"></i>
                        <i class="fa-solid fa-arrow-right-to-bracket fb-goto" title="跳转到该层"></i>
                        <i class="fa-solid fa-trash fb-del" title="删除这条收藏"></i>
                    </div>
                </div>`;
            }
            html += '</div>';
        }
        html += '</div></div>';
    }

    list.innerHTML = html;

    // 分组折叠
    list.querySelectorAll('.fb-group-head').forEach(h => {
        h.addEventListener('click', () => {
            h.closest('.fb-group').classList.toggle('fb-gcollapsed');
        });
    });

    // 聊天头右侧的「切换到该聊天」（只切聊天，不跳层）
    list.querySelectorAll('.fb-chat-open').forEach(btn => {
        btn.addEventListener('click', async e => {
            e.stopPropagation();
            const chatId = btn.dataset.chat;
            const item = (indexCache?.items || []).find(i => String(i.chatId) === String(chatId));
            if (!item) return;
            const sw = await switchChat(item);
            if (!sw.ok) {
                toastr?.warning?.(sw.reason);
                return;
            }
            refreshStars();
            renderPanel();
            toastr?.info?.(`已切到「${item.chatName}」`);
        });
    });

    // 条目操作
    list.querySelectorAll('.fb-item').forEach(el => {
        const id = el.dataset.id;
        el.querySelector('.fb-view')?.addEventListener('click', e => {
            e.stopPropagation();
            viewFull(id);
        });
        el.querySelector('.fb-goto')?.addEventListener('click', e => {
            e.stopPropagation();
            gotoFloor(id);
        });
        el.querySelector('.fb-edit')?.addEventListener('click', e => {
            e.stopPropagation();
            viewFull(id, true);
        });
        el.querySelector('.fb-export')?.addEventListener('click', e => {
            e.stopPropagation();
            exportOne(id);
        });
        el.querySelector('.fb-copy')?.addEventListener('click', e => {
            e.stopPropagation();
            copyOne(id, e.currentTarget);
        });
        el.querySelector('.fb-del')?.addEventListener('click', e => {
            e.stopPropagation();
            removeItem(id);
        });
        // 点击条目正文 = 查看完整消息（列表里最自然的默认动作）
        el.querySelector('.fb-text')?.addEventListener('click', e => {
            e.stopPropagation();
            viewFull(id);
        });
        el.querySelector('.fb-title')?.addEventListener('click', e => {
            e.stopPropagation();
            viewFull(id);
        });
    });
}

function formatTime(ts) {
    const n = Number(ts) || 0;
    if (!n) return '';
    const d = new Date(n);
    const pad = v => String(v).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── 查看完整消息 ──────────────────────────────────

let viewerEl = null;
// 查看器当前打开的完整收藏（含 html / marks），划重点要读它也要写回它
let viewerFull = null;
// 每条收藏的正文缺失时用来兜底显示的预览文本
let viewerEmptyText = '';
// 划重点浮条与当前选区（offsets 以 .fbv-body 的 textContent 为基准）
let markBarEl = null;
let markSel = null;
// 手指按在浮条上时，要挡住 selectionchange 引发的「选区没了→关浮条」，
// 否则手机上点色块的瞬间浮条先自己消失，click 却还落在它身上
let selGuardUntil = 0;
let selTimer = 0;
// 复制格式选择菜单
let menuEl = null;

/**
 * 打开「查看完整消息」弹窗，同时也是标题/标签的编辑场所。
 *
 * 为什么编辑放在这里而不是面板里：
 * 面板条目每次 renderPanel 都整体重建 innerHTML，内联输入框会失焦；
 * 而且手机上面板窄，标签编辑器塞不下。弹窗空间充足且已有像素定位逻辑。
 *
 * @param {string} id        收藏条目 id
 * @param {boolean} focusEdit 是否直接把光标放进标题框（面板铅笔按钮用）
 */
async function viewFull(id, focusEdit = false) {
    const meta = indexCache?.items.find(i => i.id === id);
    if (!meta) return;

    let full = null;
    try {
        const r = await readJson(fileOf(id));
        full = r.missing ? null : r.value;
    } catch (e) {
        toastr?.error?.(`读取失败: ${e.message}`);
        return;
    }

    if (!viewerEl) {
        viewerEl = document.createElement('div');
        viewerEl.id = 'fb-viewer';
        viewerEl.innerHTML = `
            <div class="fbv-mask"></div>
            <div class="fbv-box">
                <div class="fbv-head">
                    <span class="fbv-title"></span>
                    <i class="fa-solid fa-xmark fbv-close" title="关闭"></i>
                </div>
                <div class="fbv-meta"></div>
                <div class="fbv-edit">
                    <input class="fbv-title-in" type="text" maxlength="${MAX_TITLE_LEN}"
                           placeholder="给这条收藏起个标题（可留空）">
                    <div class="fbv-chips"></div>
                    <input class="fbv-tag-in" type="text" maxlength="${MAX_TAG_LEN}"
                           placeholder="输入标签后回车，或点下方已有标签">
                    <div class="fbv-pool"></div>
                </div>
                <div class="fbv-body"></div>
            </div>`;
        document.body.appendChild(viewerEl);

        viewerEl.querySelector('.fbv-close').addEventListener('click', closeViewer);
        viewerEl.querySelector('.fbv-mask').addEventListener('click', closeViewer);
        bindEditHandlers();
        bindMarkHandlers();
    }

    // ── 每次打开都要按当前条目重置编辑状态 ──
    editCtx = { id, tags: [...(meta.tags || [])] };
    viewerFull = full;
    viewerEmptyText = meta.preview || '(内容为空)';
    markSel = null;
    hideMarkBar();
    viewerEl.querySelector('.fbv-title-in').value = meta.title || '';
    renderEditTags();

    viewerEl.querySelector('.fbv-title').textContent =
        `${meta.sender || '(无名)'} · 第 ${Number(meta.floor) + 1} 层`;
    viewerEl.querySelector('.fbv-meta').innerHTML =
        `${escapeHtml(meta.charName || '')} / ${escapeHtml(meta.chatName || '')}
         ${Number(meta.swipeId) > 0 ? ` · 版本${Number(meta.swipeId) + 1}` : ''}
         ${meta.ts ? ` · 收藏于 ${formatTime(meta.ts)}` : ''}`;

    // 快照是存下来的 HTML（captureFloor 已 DOMPurify 清洗过），划重点在此之上叠加
    renderViewerBody(false);

    viewerEl.classList.add('fbv-show');
    placeViewer();          // 显示后立刻算一次真实尺寸

    if (focusEdit) {
        const input = viewerEl.querySelector('.fbv-title-in');
        input.focus();
        input.select?.();
    }
}

// ── 标题 / 标签编辑 ───────────────────────────────

/** 收集全部收藏里出现过的标签，去重排序后供选择器展示 */
function collectAllTags() {
    const seen = new Set();
    for (const it of indexCache?.items ?? []) {
        for (const t of (it.tags || [])) {
            if (t) seen.add(t);
        }
    }
    return [...seen].sort((a, b) => a.localeCompare(b, 'zh'));
}

function renderEditTags() {
    if (!viewerEl || !editCtx) return;

    // 注意：data-* 里存的是下标而不是标签文本。
    // escapeAttr 只保留 [a-zA-Z0-9_-]，中文标签会被整条清空 → 点了没反应。
    const chips = viewerEl.querySelector('.fbv-chips');
    chips.innerHTML = editCtx.tags
        .map((t, i) => `<span class="fbv-chip">${escapeHtml(t)}<i class="fa-solid fa-xmark fbv-chip-x" data-i="${i}" title="移除"></i></span>`)
        .join('');

    editPoolTags = collectAllTags().filter(t => !editCtx.tags.includes(t));
    viewerEl.querySelector('.fbv-pool').innerHTML = editPoolTags.length
        ? `<span class="fbv-pool-lb">已有</span>${editPoolTags
            .map((t, i) => `<span class="fbv-pool-tag" data-i="${i}">${escapeHtml(t)}</span>`)
            .join('')}`
        : '';

    const tagIn = viewerEl.querySelector('.fbv-tag-in');
    const full = editCtx.tags.length >= MAX_TAGS;
    tagIn.disabled = full;
    tagIn.placeholder = full
        ? `标签最多 ${MAX_TAGS} 个`
        : '输入标签后回车，或点下方已有标签';
}

/** 把改动写进内存索引并落盘，随后刷新面板。失败要能看见，不能静默。 */
async function commitEdit(patch) {
    const item = indexCache?.items.find(i => i.id === editCtx?.id);
    if (!item) return;
    Object.assign(item, patch);
    try {
        await enqueue(() => saveIndex());
        renderPanel();
    } catch (e) {
        console.error(`[${PLUGIN}]`, e);
        toastr?.error?.(`保存失败: ${e.message}`);
    }
}

function addTag(raw) {
    if (!editCtx) return;
    const v = String(raw || '').trim().slice(0, MAX_TAG_LEN);
    if (!v || editCtx.tags.includes(v)) return;
    if (editCtx.tags.length >= MAX_TAGS) {
        toastr?.warning?.(`标签最多 ${MAX_TAGS} 个`);
        return;
    }
    editCtx.tags.push(v);
    renderEditTags();
    commitEdit({ tags: [...editCtx.tags] });
}

function removeTag(tag) {
    if (!editCtx) return;
    editCtx.tags = editCtx.tags.filter(t => t !== tag);
    renderEditTags();
    commitEdit({ tags: [...editCtx.tags] });
}

function bindEditHandlers() {
    const titleIn = viewerEl.querySelector('.fbv-title-in');
    const tagIn = viewerEl.querySelector('.fbv-tag-in');

    // 标题：回车或失焦时保存
    const saveTitle = () => {
        if (!editCtx) return;
        const item = indexCache?.items.find(i => i.id === editCtx.id);
        const v = String(titleIn.value || '').trim().slice(0, MAX_TITLE_LEN);
        if (item && v === String(item.title || '')) return;
        commitEdit({ title: v });
    };
    titleIn.addEventListener('change', saveTitle);
    titleIn.addEventListener('blur', saveTitle);
    titleIn.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') {
            e.preventDefault();
            saveTitle();
            titleIn.blur();
        }
    });

    // 标签输入：回车/逗号添加，退格在空输入时删掉最后一个
    tagIn.addEventListener('keydown', e => {
        e.stopPropagation();
        // 输入法选词时的回车不算提交
        if (editingComposing) return;
        if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
            e.preventDefault();
            addTag(tagIn.value);
            tagIn.value = '';
        } else if (e.key === 'Backspace' && !tagIn.value && editCtx?.tags.length) {
            removeTag(editCtx.tags[editCtx.tags.length - 1]);
        }
    });

    // 中文输入法：选词时的回车不能当成提交
    tagIn.addEventListener('compositionstart', () => { editingComposing = true; });
    tagIn.addEventListener('compositionend', () => { editingComposing = false; });

    // 点已有标签加入 / 点 chip 上的 × 移除
    viewerEl.querySelector('.fbv-pool').addEventListener('click', e => {
        const el = e.target.closest('.fbv-pool-tag');
        if (el) addTag(editPoolTags[Number(el.dataset.i)]);
    });
    viewerEl.querySelector('.fbv-chips').addEventListener('click', e => {
        const el = e.target.closest('.fbv-chip-x');
        if (el && editCtx) removeTag(editCtx.tags[Number(el.dataset.i)]);
    });
}

// ═══════════════════════════════════════════════════════════════
//  划重点：正文内的标注
// ═══════════════════════════════════════════════════════════════
//
// 标注存的是「字符偏移」而不是直接写进 HTML 的标签，理由有两条：
//   - 包 span 不改变 textContent，偏移永远对得上，反复标注不会漂
//   - 快照 HTML 保持原样，不会越标越套娃（往 HTML 里塞标签，标几次就套几层）
// 量偏移和画标注必须用同一套字符序：这里统一以 .fbv-body 的 textContent 为准。

/** 从 body 开头到 (container, offset) 之间有多少个字符 */
function offsetInBody(body, container, offset) {
    const r = document.createRange();
    r.selectNodeContents(body);
    r.setEnd(container, offset);
    return r.toString().length;
}

/** 按「快照 HTML + marks」重画正文，并尽量保住滚动位置 */
function renderViewerBody(keepScroll = true) {
    const body = viewerEl?.querySelector('.fbv-body');
    if (!body) return;
    const top = keepScroll ? body.scrollTop : 0;
    body.innerHTML = viewerFull?.html
        || `<div class="fb-empty">${escapeHtml(viewerEmptyText || '(内容为空)')}</div>`;
    applyMarks(body, viewerFull?.marks);
    body.scrollTop = top;
}

/**
 * 把标注画到正文上。
 * 区间可以互相重叠（比如黄底 0-10 再叠红字 5-15），所以先按所有边界把文本切成段，
 * 每一段再套上盖住它的那几层。切段前先把文本节点和它们的全局区间收全，
 * 不能边改 DOM 边算偏移 —— 换成多个节点后序号就对不上了。
 */
function applyMarks(body, marks) {
    const list = (marks || []).filter(m =>
        m && Number.isFinite(m.s) && Number.isFinite(m.e) && m.e > m.s && MARK_KINDS[m.k]);
    if (list.length === 0) return;

    const nodes = [];
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let pos = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        nodes.push({ node: n, start: pos, end: pos + n.data.length });
        pos += n.data.length;
    }

    for (const item of nodes) {
        if (item.end <= item.start) continue;

        // 这个文本节点要切在哪些位置
        const cuts = new Set([item.start, item.end]);
        for (const m of list) {
            if (m.s > item.start && m.s < item.end) cuts.add(m.s);
            if (m.e > item.start && m.e < item.end) cuts.add(m.e);
        }
        const points = [...cuts].sort((a, b) => a - b);
        // 没有任何标注盖住整个节点 → 原样留着
        if (points.length === 2 && !list.some(m => m.s <= item.start && m.e >= item.end)) continue;

        const frag = document.createDocumentFragment();
        for (let i = 0; i < points.length - 1; i += 1) {
            const a = points[i];
            const b = points[i + 1];
            let piece = document.createTextNode(item.node.data.slice(a - item.start, b - item.start));
            list
                .filter(m => m.s <= a && m.e >= b)
                .sort((x, y) => MARK_WRAP_ORDER.indexOf(x.k) - MARK_WRAP_ORDER.indexOf(y.k))
                .forEach(m => {
                    const layer = document.createElement('span');
                    layer.className = `fb-mark ${MARK_KINDS[m.k].cls}`;
                    layer.setAttribute('data-fb-mark', '');
                    layer.appendChild(piece);
                    piece = layer;
                });
            frag.appendChild(piece);
        }
        item.node.replaceWith(frag);
    }
}

/** 读当前选区，换算成相对正文的偏移；不在正文里或没有选区时返回 null */
function readMarkSelection() {
    const body = viewerEl?.querySelector('.fbv-body');
    const sel = window.getSelection();
    if (!body || !sel || sel.rangeCount === 0 || sel.isCollapsed) return null;

    const range = sel.getRangeAt(0);
    if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return null;

    const s = offsetInBody(body, range.startContainer, range.startOffset);
    const e = offsetInBody(body, range.endContainer, range.endOffset);
    if (e <= s) return null;
    return { s, e, rect: range.getBoundingClientRect() };
}

/** 组装选区浮条：上行底色 + 字色，下行线型 + 清除 */
function buildMarkBar() {
    const swatch = (k, inner) =>
        `<button class="fbm-btn ${MARK_KINDS[k].cls}" data-k="${k}" title="${MARK_KINDS[k].label}">${inner}</button>`;

    const el = document.createElement('div');
    el.id = 'fb-markbar';
    el.innerHTML = `
        <div class="fbm-row">
            ${['h-y', 'h-g', 'h-b', 'h-p'].map(k => swatch(k, '')).join('')}
            <span class="fbm-sep"></span>
            ${['f-r', 'f-o', 'f-b', 'f-g'].map(k => swatch(k, 'A')).join('')}
        </div>
        <div class="fbm-row">
            ${['u-s', 'u-w'].map(k => swatch(k, 'U')).join('')}
            <span class="fbm-sep"></span>
            <button class="fbm-btn fbm-clear" data-act="clear">清除</button>
        </div>`;

    // 按住浮条不能把选区清掉，否则桌面端点按钮的瞬间选区就没了。
    // 手机上点按钮还会让选区先塌陷，那一下的 selectionchange 必须挡掉，
    // 不然 click 落到按钮上时 markSel 已经被清空。
    el.addEventListener('mousedown', e => {
        selGuardUntil = Date.now() + 1000;
        e.preventDefault();
    });
    el.addEventListener('touchstart', () => { selGuardUntil = Date.now() + 1000; }, { passive: true });
    el.addEventListener('click', e => {
        const btn = e.target.closest('.fbm-btn');
        if (!btn) return;
        if (btn.dataset.act === 'clear') clearMarks();
        else applyMarkKind(btn.dataset.k);
    });

    document.body.appendChild(el);
    return el;
}

function showMarkBar() {
    if (!markBarEl || !markSel?.rect) return;
    markBarEl.classList.add('fbm-show');

    const { rect } = markSel;

    // 手机上双指缩放后，fixed 定位算的是版式视口，而 rect 是视觉视口坐标，
    // 两者能差出整屏。有 visualViewport 就以它为边界。
    const vv = window.visualViewport;
    const vx = vv ? vv.offsetLeft : 0;
    const vy = vv ? vv.offsetTop : 0;
    const vw = vv ? vv.width : window.innerWidth;
    const vh = vv ? vv.height : window.innerHeight;

    // 触屏设备松手后，系统会在选区旁边弹出自己的菜单（复制/全选/朗读…），
    // 浮条跟着选区走必然和它重叠，所以触屏改成贴边停靠，离选区越远越好。
    // 带触屏的笔记本一般同时有 hover 且宽度大，仍然按桌面处理。
    const mq = window.matchMedia;
    const coarse = !!mq && mq('(any-pointer: coarse)').matches;
    const hover = !!mq && mq('(hover: hover)').matches;
    const dock = coarse && (!hover || vw <= 1100);
    markBarEl.classList.toggle('fbm-dock', dock);

    const bw = markBarEl.offsetWidth;
    const bh = markBarEl.offsetHeight;

    // 停靠时已和选区脱钩，就按屏幕居中；桌面才跟着选区走
    let left = dock
        ? vx + (vw - bw) / 2
        : rect.left + rect.width / 2 - bw / 2;
    left = Math.max(vx + 8, Math.min(left, vx + vw - bw - 8));

    // 位置一律用 top 算死像素：手机上 bottom/env() 一旦被 WebKit 整条丢掉，
    // top 又只剩 auto，浮条会退到文档末尾的静态位置，整块看不见。
    let top;
    if (dock) {
        // 停在弹窗内侧底边，别贴屏幕底边（那里可能是酒馆自己的输入栏），
        // 也离系统选区菜单最远；选区正好压在这里就翻到弹窗内侧顶边。
        const box = viewerEl?.querySelector('.fbv-box');
        const boxRect = box ? box.getBoundingClientRect() : null;
        const edgeBottom = boxRect ? boxRect.bottom : vy + vh;
        const edgeTop = boxRect ? boxRect.top : vy;
        top = edgeBottom - bh - 10;
        if (rect.bottom > top - 8) top = edgeTop + 10;
    } else {
        // 桌面：跟着选区，上方放不下就翻到选区下方
        top = rect.top - bh - 10;
        if (top < vy + 8) top = rect.bottom + 10;
    }
    top = Math.max(vy + 8, Math.min(top, vy + vh - bh - 8));

    if (!Number.isFinite(left) || !Number.isFinite(top)) {
        left = vx + 8;
        top = vy + 8;
    }

    markBarEl.style.left = `${Math.round(left)}px`;
    markBarEl.style.top = `${Math.round(top)}px`;
    markBarEl.style.bottom = 'auto';
}

function hideMarkBar() {
    markBarEl?.classList.remove('fbm-show');
    markSel = null;
}

/**
 * 真正决定浮条出不出的地方。
 * 手机上长按选字时，iOS 会直接把这次触摸判成 touchcancel，Android 的
 * touchend 也常常早于选区生成，所以不能靠触摸事件，只能靠 document 的
 * selectionchange + 短防抖，等选区停下来再读。
 */
function onSelectionChange() {
    if (Date.now() < selGuardUntil) return;
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
        if (Date.now() < selGuardUntil) return;   // 防抖期间手指落到浮条上了
        const picked = readMarkSelection();
        if (!picked) {
            hideMarkBar();
            return;
        }
        markSel = picked;
        showMarkBar();
    }, 120);
}

function bindMarkHandlers() {
    const body = viewerEl.querySelector('.fbv-body');
    if (!markBarEl) markBarEl = buildMarkBar();

    body.addEventListener('mouseup', onSelectionChange);
    body.addEventListener('touchend', onSelectionChange);
    body.addEventListener('touchcancel', onSelectionChange);
    document.addEventListener('selectionchange', onSelectionChange);

    // 重新在正文里按下 = 放弃上一次选区。
    // 但手机长按选字后，部分 WebView 会补一个合成 mousedown，那一下不能把
    // 刚落地的选区关掉；真有选区塌陷，selectionchange 会负责关。
    body.addEventListener('mousedown', () => {
        if (markBarEl?.classList.contains('fbm-show')) return;
        hideMarkBar();
    });
    // 滚动时选区会跟着动，重新算一次位置；选区真没了这里自然会关掉浮条
    body.addEventListener('scroll', () => {
        if (markBarEl?.classList.contains('fbm-show')) onSelectionChange();
    }, { passive: true });
}

/**
 * 把某一族样式在 [s, e) 上设成 kind（kind 为 null 即清掉这一段）。
 * 同族里一段位置只能有一种样式，所以与选区相交的旧标注要被裁短或拆成两段。
 */
function setFamily(marks, fam, s, e, kind) {
    const out = [];
    for (const m of marks) {
        if (String(m.k)[0] !== fam) { out.push(m); continue; }  // 别的族不动
        if (m.e <= s || m.s >= e) { out.push(m); continue; }     // 和选区不相交
        if (m.s < s) out.push({ s: m.s, e: s, k: m.k });         // 左侧残段
        if (m.e > e) out.push({ s: e, e: m.e, k: m.k });         // 右侧残段
    }
    if (kind) out.push({ s, e, k: kind });
    return out;
}

function applyMarkKind(k) {
    if (!markSel || !viewerFull || !MARK_KINDS[k]) return;
    const { s, e } = markSel;
    const marks = viewerFull.marks || [];
    // 整段都已经是这个样式 → 再点一次当取消
    const covered = marks.some(m => m.k === k && m.s <= s && m.e >= e);
    commitMarks(setFamily(marks, k[0], s, e, covered ? null : k));
}

function clearMarks() {
    if (!markSel || !viewerFull) return;
    const { s, e } = markSel;
    let next = viewerFull.marks || [];
    for (const fam of MARK_FAMILIES) next = setFamily(next, fam, s, e, null);
    commitMarks(next);
}

async function commitMarks(marks) {
    if (!editCtx || !viewerFull) return;
    viewerFull.marks = marks;
    renderViewerBody();
    hideMarkBar();
    window.getSelection()?.removeAllRanges?.();
    await saveMarks(editCtx.id, marks);
}

/** 标注跟着正文存在同一条 fb-<id>.json 里，不占索引 */
async function saveMarks(id, marks) {
    if (!viewerFull) return;
    try {
        await enqueue(() => uploadJson(fileOf(id), { ...viewerFull, marks }));
    } catch (e) {
        console.error(`[${PLUGIN}]`, e);
        toastr?.error?.(`标注保存失败: ${e.message}`);
    }
}

/**
 * 用像素坐标布置查看器。
 *
 * 不能用 CSS inset/transform 居中：酒馆的 html 上有
 * `-webkit-transform: translateZ(0)`，会让 position:fixed 相对 html 包含块
 * 而不是视口 —— 弹窗会飞到屏幕外。
 * 这里一律用 window.innerWidth/Height 算死像素值。
 */
function placeViewer() {
    if (!viewerEl?.classList.contains('fbv-show')) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 外层容器铺满视口
    viewerEl.style.left = '0px';
    viewerEl.style.top = '0px';
    viewerEl.style.width = `${vw}px`;
    viewerEl.style.height = `${vh}px`;

    const box = viewerEl.querySelector('.fbv-box');
    const mask = viewerEl.querySelector('.fbv-mask');
    if (mask) {
        mask.style.width = `${vw}px`;
        mask.style.height = `${vh}px`;
    }
    if (!box) return;

    const margin = vw <= 600 ? 8 : 24;
    const boxW = Math.min(720, vw - margin * 2);
    const boxH = Math.min(vh - margin * 2, Math.max(200, vh * 0.8));

    const left = Math.max(margin, Math.round((vw - boxW) / 2));
    const top = Math.max(margin, Math.round((vh - boxH) / 2));

    box.style.width = `${Math.round(boxW)}px`;
    box.style.height = `${Math.round(boxH)}px`;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    // 显式清掉可能从别处继承来的定位偏移
    box.style.right = 'auto';
    box.style.bottom = 'auto';
    box.style.transform = 'none';
}

function closeViewer() {
    hideMarkBar();
    viewerEl?.classList.remove('fbv-show');
    viewerFull = null;
    editCtx = null;
}

// ── 单条导出 ──────────────────────────────────────

/**
 * 把一条收藏导出成 Markdown 并下载。
 * 正文用存档里的 HTML 快照转纯文本（保留换行），不直接把 HTML 塞进 .md。
 */
async function exportOne(id) {
    const meta = indexCache?.items.find(i => i.id === id);
    if (!meta) return;

    let full = null;
    try {
        const r = await readJson(fileOf(id));
        full = r.missing ? null : r.value;
    } catch (e) {
        toastr?.error?.(`导出失败，读取收藏出错: ${e.message}`);
        return;
    }

    const body = htmlToMarkdown(full?.html || meta.preview || '');
    const lines = [];

    const title = String(meta.title || '').trim();
    const tags = Array.isArray(meta.tags) ? meta.tags : [];

    lines.push(`# ${title ? `${title} — ` : ''}${meta.sender || '(无名)'} · 第 ${Number(meta.floor) + 1} 层`);
    lines.push('');
    lines.push('| 项目 | 值 |');
    lines.push('| --- | --- |');
    if (title) lines.push(`| 标题 | ${mdCell(title)} |`);
    if (tags.length) lines.push(`| 标签 | ${mdCell(tags.join(' · '))} |`);
    lines.push(`| 角色卡 | ${mdCell(meta.charName || '')} |`);
    lines.push(`| 聊天 | ${mdCell(meta.chatName || '')} |`);
    lines.push(`| 楼层 | 第 ${Number(meta.floor) + 1} 层（mesid ${Number(meta.floor)}） |`);
    lines.push(`| 分支版本 | ${Number(meta.swipeId) + 1} |`);
    lines.push(`| 发送者 | ${mdCell(meta.sender || '')} |`);
    lines.push(`| 收藏时间 | ${formatFullTime(meta.ts)} |`);
    lines.push(`| 聊天文件 | \`${meta.chatId || ''}\` |`);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(body);
    lines.push('');

    const md = lines.join('\n');

    // 文件名：有标题用标题，否则用角色卡；后面接聊天名和层号
    const safe = s => String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim();
    const name = [
        safe(title || meta.charName || 'unknown'),
        safe(meta.chatName || ''),
        `第${Number(meta.floor) + 1}层`,
    ].filter(Boolean).join('-').slice(0, 120);

    downloadBlob(md, `${name}.md`);
    toastr?.success?.('已导出 Markdown');
}

function mdCell(v) {
    return String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function formatFullTime(ts) {
    const n = Number(ts) || 0;
    if (!n) return '';
    const d = new Date(n);
    const pad = v => String(v).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 把消息 HTML 快照转成可读的 Markdown 文本。
 * 目标是"人能看"，不做完整 HTML→MD 转换：保留段落和换行，其余标签剥掉。
 */
function htmlToMarkdown(html) {
    const box = document.createElement('template');
    box.innerHTML = String(html ?? '');

    // 脚本、样式一律丢弃
    box.content.querySelectorAll('script, style').forEach(n => n.remove());

    // <br> → 换行
    box.content.querySelectorAll('br').forEach(n => n.replaceWith('\n'));

    // 行内样式 → Markdown 标记。先处理内层（em）再处理外层（strong），
    // 这样 <strong><em>x</em></strong> 得到 ***x*** 而不是把斜体丢掉。
    // 文本为空就跳过 —— 消息里的 <i class="fa-..."> 是图标，不能变成空标记。
    box.content.querySelectorAll('em, i').forEach(n => {
        const t = n.textContent || '';
        if (t.trim()) n.replaceWith(`*${t}*`);
    });
    box.content.querySelectorAll('strong, b').forEach(n => {
        const t = n.textContent || '';
        if (t.trim()) n.replaceWith(`**${t}**`);
    });
    box.content.querySelectorAll('code').forEach(n => {
        const t = n.textContent || '';
        if (t) n.replaceWith(`\`${t}\``);
    });

    // 块级元素 → 前后加换行，避免文字粘成一段
    box.content.querySelectorAll('p, div, li, blockquote, h1, h2, h3, h4, h5, h6')
        .forEach(n => n.append('\n'));

    // 图片 → Markdown 图片语法（base64 太长，只留 alt 和是否内嵌）
    box.content.querySelectorAll('img').forEach(n => {
        const alt = n.getAttribute('alt') || '';
        const src = String(n.getAttribute('src') || '');
        if (src.startsWith('data:')) n.replaceWith(`![${alt}](内嵌图片)`);
        else if (src) n.replaceWith(`![${alt}](${src})`);
        else n.replaceWith(`![${alt}]()`);
    });

    let text = box.content.textContent || '';

    // 压缩多余空行（保留段落分隔）
    text = text
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return text;
}

function downloadBlob(text, filename) {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    // 交给浏览器把下载排上队后回收
    setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
    }, 1000);
}

// ── 单条复制 ──────────────────────────────────────

/**
 * 写剪贴板。
 * 不能只靠 navigator.clipboard：它只在安全上下文（https 或 localhost）存在，
 * 而本插件的常见用法是局域网 http://192.168.x.x:8000 —— 那里它直接是 undefined。
 * 所以必须留 textarea + execCommand 这条老路。
 */
async function copyToClipboard(text) {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // 权限被拒之类，落到下面的兜底
    }

    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);

    let ok = false;
    try {
        ok = document.execCommand('copy');
    } catch {
        ok = false;
    }
    ta.remove();
    return ok;
}

/** 面板上的「复制」：点一下先选格式 */
function copyOne(id, anchor) {
    showMenu(anchor, [
        { label: '复制 Markdown', hint: '保留段落与图片', run: () => runCopy(id, 'md') },
        { label: '复制纯文本', hint: '去掉图片，只留文字', run: () => runCopy(id, 'txt') },
    ]);
}

async function runCopy(id, fmt) {
    let full = null;
    try {
        const r = await readJson(fileOf(id));
        full = r.missing ? null : r.value;
    } catch (e) {
        toastr?.error?.(`复制失败，读取收藏出错: ${e.message}`);
        return;
    }

    const html = full?.html || '';
    const text = fmt === 'md' ? htmlToMarkdown(html) : plainTextOf(html);
    if (!text) {
        toastr?.warning?.('这条收藏没有正文');
        return;
    }

    if (await copyToClipboard(text)) {
        toastr?.success?.(fmt === 'md' ? '已复制 Markdown' : '已复制纯文本');
    } else {
        toastr?.error?.('复制失败：浏览器拒绝了剪贴板写入');
    }
}

/** 纯文本版：在 Markdown 的基础上把图片语法压成 alt */
function plainTextOf(html) {
    return htmlToMarkdown(html).replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
}

// ── 轻量弹出菜单（选复制格式用）───────────────────

function showMenu(anchor, entries) {
    hideMenu();
    if (!anchor) return;

    const el = document.createElement('div');
    el.id = 'fb-menu';
    el.innerHTML = entries.map((it, i) => `
        <div class="fbmn-item" data-i="${i}">
            <div class="fbmn-label">${escapeHtml(it.label)}</div>
            ${it.hint ? `<div class="fbmn-hint">${escapeHtml(it.hint)}</div>` : ''}
        </div>`).join('');
    document.body.appendChild(el);
    menuEl = el;

    el.addEventListener('mousedown', e => e.preventDefault());
    el.addEventListener('click', e => {
        const row = e.target.closest('.fbmn-item');
        if (!row) return;
        const entry = entries[Number(row.dataset.i)];
        hideMenu();
        entry?.run?.();
    });

    // 贴着按钮放，出界就翻到上方并夹进视口
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, vw - w - 8));

    let top = r.bottom + 6;
    if (top + h > vh - 8) top = Math.max(8, r.top - h - 6);

    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;

    // 推迟一轮再加监听，否则打开它的这次点击会立刻把自己关掉
    setTimeout(() => {
        document.addEventListener('mousedown', onMenuOutside, true);
        document.addEventListener('keydown', onMenuEsc, true);
        window.addEventListener('scroll', hideMenu, true);
    }, 0);
}

function onMenuOutside(e) {
    if (!menuEl || menuEl.contains(e.target)) return;
    hideMenu();
}

function onMenuEsc(e) {
    if (e.key === 'Escape') hideMenu();
}

function hideMenu() {
    document.removeEventListener('mousedown', onMenuOutside, true);
    document.removeEventListener('keydown', onMenuEsc, true);
    window.removeEventListener('scroll', hideMenu, true);
    menuEl?.remove();
    menuEl = null;
}

/** 跳转到收藏所在楼层（仅同聊天有效） */
/**
 * 切到收藏所属的聊天。
 *
 * ST 的聊天分支（`- Branch #N`）是同一张角色卡下的独立聊天文件，切换只需要
 * `openCharacterChat(文件名)`。跨角色卡要连角色卡一起换，整个界面会重建，
 * 那属于另一个量级的改动，这里明确拒绝并提示。
 *
 * 群聊用的是另一套（`openGroupChat`），本插件不处理。
 */
async function switchChat(item) {
    const c = ctx();
    const chat = currentChat();
    if (!c || !item?.chatId) return { ok: false, reason: '找不到这条收藏所属的聊天' };
    if (String(item.chatId) === String(chat?.chatId)) return { ok: true };

    if (item.isGroup || chat?.isGroup) {
        return { ok: false, reason: '群聊的收藏暂不支持前往' };
    }

    // 旧收藏没有 charId，退回角色名比较
    const sameChar = item.charId && chat?.charId
        ? String(item.charId) === String(chat.charId)
        : String(item.charName) === String(chat?.charName);
    if (!sameChar) {
        return { ok: false, reason: `该收藏属于「${item.charName}」，请先切到那张角色卡` };
    }

    if (typeof c.openCharacterChat !== 'function') {
        return { ok: false, reason: '这个酒馆版本不支持自动切换聊天' };
    }

    // 聊天文件可能已被删除或改名，切失败就退回原来的聊天，别把人扔在空聊天里
    const prevChatId = String(c.characters?.[c.characterId]?.chat || '');
    try {
        await c.openCharacterChat(item.chatId);
    } catch (err) {
        console.error('[FloorBookmarks] openCharacterChat 失败', err);
        return { ok: false, reason: '切换聊天失败，聊天可能已被删除' };
    }

    if (await waitForChat(item.chatId)) return { ok: true };

    if (prevChatId && prevChatId !== item.chatId) {
        try {
            await c.openCharacterChat(prevChatId);
            await waitForChat(prevChatId, 4000);
        } catch (err) {
            console.error('[FloorBookmarks] 回滚聊天失败', err);
        }
    }
    return { ok: false, reason: '聊天里没有消息，可能已被删除，已退回原来的聊天' };
}

/** 等聊天真正加载完（chatId 对上且消息列表已渲染） */
function waitForChat(chatId, ms = 10000) {
    return new Promise(resolve => {
        const deadline = Date.now() + ms;
        const tick = () => {
            const c = ctx();
            const loaded = String(c?.chatId || '') === String(chatId) && !!document.querySelector('#chat > .mes');
            if (loaded) return resolve(true);
            if (Date.now() >= deadline) return resolve(false);
            setTimeout(tick, 120);
        };
        tick();
    });
}

async function gotoFloor(id) {
    const item = indexCache?.items.find(i => i.id === id);
    if (!item) return;

    const chat = currentChat();
    const same = !!chat?.chatId && String(item.chatId) === String(chat.chatId);
    if (!same) {
        const sw = await switchChat(item);
        if (!sw.ok) {
            toastr?.warning?.(sw.reason);
            return;
        }
        // 聊天换了，「当前」标记和置顶顺序都得重算
        refreshStars();
        renderPanel();
    }

    toastr?.info?.(`正在定位第 ${Number(item.floor) + 1} 层…`, null, { timeOut: 1200 });

    const found = await locateFloor(item.floor);
    if (!found) {
        toastr?.warning?.(`第 ${item.floor + 1} 层无法定位`);
        return;
    }

    found.scrollIntoView({ behavior: 'smooth', block: 'center' });
    found.classList.add('fb-flash');
    setTimeout(() => found.classList.remove('fb-flash'), 1400);
}

/**
 * 定位某一层。
 *
 * ST 打开聊天时只渲染最后 `power_user.chat_truncation` 条，更早的层
 * **根本不在 DOM 里**（不是被隐藏）。唯一能把它们加载出来的办法是
 * 反复点 ST 自己的「Show more messages」按钮。
 *
 * 所以这里不能干等、也不能猜 scrollTop —— 必须主动驱动 ST 的加载。
 */
async function locateFloor(mesid) {
    const sel = `#chat > .mes[mesid="${mesid}"]`;

    const now = document.querySelector(sel);
    if (now) return now;

    const total = ctx()?.chat?.length || 0;
    // 估算需要点几次「Show more messages」才能覆盖到目标层
    const perBatch = Number(window.power_user?.chat_truncation) || 20;
    const maxClicks = Math.min(60, Math.ceil(total / Math.max(1, perBatch)) + 2);

    for (let i = 0; i < maxClicks; i++) {
        const btn = document.getElementById('show_more_messages');

        if (!btn) break;                       // 已经加载到第 0 层，没有更多了
        if (isElementGone(btn)) break;

        btn.click();

        // 等这一批渲染完（showMoreMessages 是 async，内部有 await）
        const hit = await waitForFloor(sel, 400);
        if (hit) return hit;

        // 如果这一批已经覆盖到目标层以下，没必要继续
        const firstId = Number(document.querySelector('#chat > .mes[mesid]')?.getAttribute('mesid'));
        if (Number.isFinite(firstId) && firstId <= mesid) {
            // 已加载区间包含目标，但仍没找到 —— 给最后一轮机会
            const retry = await waitForFloor(sel, 600);
            if (retry) return retry;
            break;
        }
    }

    return document.querySelector(sel);
}

/** 在给定时间内轮询等待某层出现 */
function waitForFloor(sel, ms) {
    return new Promise(resolve => {
        const deadline = Date.now() + ms;
        const tick = () => {
            const el = document.querySelector(sel);
            if (el) return resolve(el);
            if (Date.now() >= deadline) return resolve(null);
            setTimeout(tick, 50);
        };
        tick();
    });
}

/** 元素是否已从 DOM 移除（jQuery 对象和原生元素都判一下） */
function isElementGone(el) {
    if (!el) return true;
    return !el.isConnected;
}

async function removeItem(id) {
    const item = indexCache?.items.find(i => i.id === id);
    if (!item) return;
    if (!confirm(`删除第 ${Number(item.floor) + 1} 层的收藏？`)) return;

    try {
        await enqueue(async () => {
            await deleteFile(fileOf(id));
            indexCache.items = indexCache.items.filter(i => i.id !== id);
            await saveIndex();
        });
        renderPanel();
        refreshStars();
        toastr?.info?.('已删除');
    } catch (e) {
        toastr?.error?.(e.message);
    }
}

// ── 工具 ──────────────────────────────────────────

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
    return String(s ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
}

// ═══════════════════════════════════════════════════════════════
//  入口
// ═══════════════════════════════════════════════════════════════

async function init() {
    let c;
    try {
        c = await waitForContext();
    } catch (e) {
        console.error(`[${PLUGIN}] ${e.message}`);
        return;
    }
    ctxReady = true;

    try {
        await loadIndex();
    } catch (e) {
        console.error(`[${PLUGIN}] 载入索引失败:`, e);
        toastr?.error?.('楼层书签: 载入失败，请检查控制台');
        indexCache = emptyIndex();
    }

    buildPanel();
    restorePanelGeometry();

    // ESC 关掉查看器 / 面板
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        if (viewerEl?.classList.contains('fbv-show')) { closeViewer(); return; }
        panelEl?.classList.remove('fb-show');
    });

    // 窗口尺寸变化时把面板夹回视口内
    window.addEventListener('resize', debounce(() => {
        // 查看器跟着重算（否则旋转屏幕/改窗口大小后会错位）
        if (viewerEl?.classList.contains('fbv-show')) placeViewer();

        if (!panelEl?.classList.contains('fb-show')) return;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const w = panelEl.offsetWidth;
        const h = panelEl.offsetHeight;
        const r = panelEl.getBoundingClientRect();

        let changed = false;
        let left = r.left;
        let top = r.top;

        if (w > vw - 8) { panelEl.style.width = `${Math.max(240, vw - 8)}px`; changed = true; }
        if (h > vh - 8) { panelEl.style.height = `${Math.max(160, vh - 8)}px`; changed = true; }

        const maxLeft = Math.max(0, vw - panelEl.offsetWidth);
        const maxTop = Math.max(0, vh - panelEl.offsetHeight);

        if (left > maxLeft) { left = maxLeft; changed = true; }
        if (left < 0) { left = 0; changed = true; }
        if (top > maxTop) { top = maxTop; changed = true; }
        if (top < 0) { top = 0; changed = true; }

        if (changed) {
            panelEl.style.left = `${left}px`;
            panelEl.style.top = `${top}px`;
            savePanelGeometry();
        }
    }, 200));

    // ── 等 APP_READY ──
    // 不立刻动 DOM：此时聊天可能还没加载完，过早注入会参与 ST 的加载窗口。
    // 若 APP_READY 早已发过（插件后装/热重载），用超时兜底，避免永远等不到。
    const appReady = await waitForAppReady(c);

    // 首次补扫：此时聊天已就绪
    injectAll();

    // ── 事件监听 ──
    // 全部走 scheduleInject()（rAF 合并），绝不直接全量扫描。
    //
    // 注意：ST 没有 MESSAGE_RENDERED 这个事件（events.js 里只有
    // USER_MESSAGE_RENDERED / CHARACTER_MESSAGE_RENDERED），
    // 历史消息回填靠 MORE_MESSAGES_LOADED —— 这是最容易漏的一条。

    // 聊天切换：DOM 被整体重建，需要重新注入
    c.eventSource.on(c.event_types.CHAT_CHANGED, () => {
        scheduleInject();
        renderPanel();
    });

    // ★ 点「Show more messages」回填历史消息 —— 只发这个事件
    c.eventSource.on(c.event_types.MORE_MESSAGES_LOADED, () => {
        scheduleInject();
    });

    // 单条消息渲染完成：只处理这一条，不触发全局扫描
    const onOneRendered = (mesid) => {
        const id = Number(mesid);
        if (!Number.isFinite(id)) { scheduleInject(); return; }
        const el = document.querySelector(`#chat > .mes[mesid="${id}"]`);
        if (el) injectOne(el);
        else scheduleInject();
    };
    c.eventSource.on(c.event_types.USER_MESSAGE_RENDERED, onOneRendered);
    c.eventSource.on(c.event_types.CHARACTER_MESSAGE_RENDERED, onOneRendered);

    // 切 swipe / 重新生成：只刷新 class，不重建 DOM
    c.eventSource.on(c.event_types.MESSAGE_SWIPED, () => {
        requestAnimationFrame(refreshStars);
    });

    // 消息被删除后楼层会前移，需要重新对齐
    c.eventSource.on(c.event_types.MESSAGE_DELETED, () => {
        scheduleInject();
    });

    // 扩展菜单入口
    const menu = document.getElementById('extensionsMenu');
    if (menu) {
        const item = document.createElement('div');
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.innerHTML = '<i class="fa-solid fa-bookmark"></i><span>楼层书签</span>';
        item.addEventListener('click', () => {
            panelEl?.classList.toggle('fb-show');
            if (panelEl?.classList.contains('fb-show')) {
                // 打开面板时才补扫一次（用户主动行为，安全）
                injectAll();
                refreshStars();
                renderPanel();
            }
        });
        menu.appendChild(item);
    }

    console.log(`[${PLUGIN}] 已就绪，共 ${indexCache.items.length} 条收藏${appReady ? '' : '（APP_READY 超时兜底）'}`);

    // 调试接口
    window.__fb = {
        items: () => indexCache?.items ?? [],
        reload: async () => { await loadIndex(true); renderPanel(); injectAll(); refreshStars(); },
        files: () => [INDEX_FILE, ...(indexCache?.items ?? []).map(i => fileOf(i.id))],
        // 性能诊断：打开一个大聊天后看 scans / injected 两个数字
        stats: () => ({ ...stats, domMes: document.querySelectorAll('#chat > .mes[mesid]').length }),
        resetStats: () => { stats.scans = 0; stats.injected = 0; return '已重置'; },
    };
}

/**
 * 等待 APP_READY。已在就绪状态时不要干等 —— 用 3 秒超时兜底。
 */
function waitForAppReady(c) {
    return new Promise(resolve => {
        let done = false;
        const finish = ok => { if (done) return; done = true; resolve(ok); };

        try {
            c.eventSource.once?.(c.event_types.APP_READY, () => finish(true));
        } catch { /* once 不存在则忽略 */ }

        // 兜底：若 APP_READY 早已发过，3 秒后自行放行
        setTimeout(() => finish(false), 3000);
    });
}

jQuery(async () => { await init(); });
