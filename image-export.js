// PNG export consumes independent snapshots. It never accesses Tavern storage.
const RATIO = 2;
const PAGE_MARGIN = 26;
const MAX_PIXELS = 32000000;
const sizeRanges = { width: [720, 4096], maxHeight: [1024, 32768] };
const PREF_KEY = 'fb-image-export-options-v1';
const defaults = { mode: 'original', width: 1440, maxHeight: 8192, title: true, charName: true, chatName: true, floor: true, sender: true, tags: false, ts: false, marks: true, images: true, rich: true };
const labels = { title: '标题', charName: '角色卡', chatName: '聊天', floor: '楼层 / 版本', sender: '发送者', tags: '标签', ts: '收藏时间', marks: '划重点', images: '图片', rich: '富文本排版' };
let active = null;
let libraryPromise;

function loadLibrary() {
    if (globalThis.htmlToImage?.toBlob) return Promise.resolve(globalThis.htmlToImage);
    if (!libraryPromise) libraryPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = new URL('./vendor/html-to-image.js', import.meta.url).href;
        script.onload = () => globalThis.htmlToImage?.toBlob ? resolve(globalThis.htmlToImage) : reject(new Error('本地 PNG 库未能初始化'));
        script.onerror = () => reject(new Error('本地 PNG 库加载失败，请重试'));
        document.head.append(script);
    }).catch(error => { libraryPromise = null; throw error; });
    return libraryPromise;
}

function preferences() {
    try {
        const saved = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
        return Object.fromEntries(Object.entries(defaults).map(([key, value]) => {
            if (key === 'mode') return [key, ['original', 'share-light', 'share-dark'].includes(saved[key]) ? saved[key] : value];
            if (key in sizeRanges) return [key, validSize(key, saved[key]) ? saved[key] : value];
            return [key, typeof saved[key] === 'boolean' ? saved[key] : value];
        }));
    } catch { return { ...defaults }; }
}

function validSize(key, value) {
    const [min, max] = sizeRanges[key];
    return Number.isInteger(value) && value >= min && value <= max && value % RATIO === 0;
}

function pageLimits(options) {
    const width = options.width / RATIO;
    const maxHeight = Math.min(options.maxHeight, Math.floor(MAX_PIXELS / options.width / RATIO) * RATIO);
    return { width, maxHeight, contentHeight: maxHeight / RATIO - PAGE_MARGIN * 2 };
}

function node(tag, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
}

function timeout(promise, signal, milliseconds = 12000) {
    return new Promise((resolve, reject) => {
        const abort = () => finish(reject, new DOMException('已中断', 'AbortError'));
        const timer = setTimeout(() => finish(reject, new Error('资源读取超时')), milliseconds);
        function finish(fn, value) { clearTimeout(timer); signal.removeEventListener('abort', abort); fn(value); }
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        else promise.then(value => finish(resolve, value), error => finish(reject, error));
    });
}

function dataUrl(blob, signal) {
    return timeout(new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('资源转换失败'));
        reader.readAsDataURL(blob);
    }), signal);
}

const exportCSS = width => `
*{box-sizing:border-box}html,body{margin:0;padding:0;width:${width}px}body{overflow:visible}
table{color:inherit}
.fbi-paper{width:${width}px;min-height:100px;padding:26px;background:var(--paper-bg);color:var(--paper-fg);font:var(--paper-font);overflow:hidden;overflow-wrap:anywhere}
.fbi-paper .fbv-body{padding:0 14px;overflow:visible;line-height:1.7;font-size:14px;min-height:0;word-break:break-word}
.fbv-body img{max-width:100%;height:auto}.fbv-body p{margin:0 0 .8em}.fbv-body pre{white-space:pre-wrap;overflow-wrap:anywhere}.fbv-body table{max-width:100%;border-collapse:collapse}.fbv-body td,.fbv-body th{padding:4px 8px;border:1px solid #8886}
.fbi-meta{padding:0 14px 18px;border-bottom:1px solid #8885;margin-bottom:26px;font-size:13px;line-height:1.8}.fbi-meta h1{font-size:24px;line-height:1.4;margin:0 0 8px}.fbi-meta p{margin:1px 0}.fbi-plain{white-space:pre-wrap}
.fbi-placeholder{display:block;padding:14px;border:1px dashed #a57541;background:#a5754114;color:inherit;font:13px/1.5 sans-serif;margin:8px 0}
.fb-mark{box-decoration-break:clone;-webkit-box-decoration-break:clone;border-radius:2px}.fb-h-y{background:var(--fb-h-y)}.fb-h-g{background:var(--fb-h-g)}.fb-h-b{background:var(--fb-h-b)}.fb-h-p{background:var(--fb-h-p)}.fb-f-r{color:var(--fb-f-r)}.fb-f-o{color:var(--fb-f-o)}.fb-f-b{color:var(--fb-f-b)}.fb-f-g{color:var(--fb-f-g)}.fb-u-s{text-decoration:underline;text-underline-offset:2px}.fb-u-w{text-decoration:underline wavy;text-underline-offset:3px}
.fbi-share .fbv-body{font-size:17px;line-height:1.85}.fbi-share .fbi-meta h1{font-size:28px}.fbi-share .fbv-body blockquote{margin:16px 0;padding:4px 18px;border-left:3px solid #8888}.fbi-share .fbv-body code{background:#8882;padding:2px 4px;border-radius:3px}
*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}
`;

async function renderSnapshot({ meta, full, applyMarks, prepareImageSnapshot, options, frame, signal, embedResources = true, cachedResources = new Map() }) {
    const doc = frame.contentDocument;
    const warnings = new Set();
    const warn = text => warnings.add(text);
    const style = doc.createElement('style');
    style.textContent = exportCSS(options.width / RATIO);
    doc.head.append(style);
    const paper = doc.createElement('article');
    paper.className = `fbi-paper${options.mode === 'original' ? '' : ' fbi-share'}`;
    const reference = document.querySelector('#fb-viewer .fbv-body') || document.body;
    const theme = getComputedStyle(reference);
    const viewerBox = document.querySelector('#fb-viewer .fbv-box');
    const viewerTheme = getComputedStyle(viewerBox || reference);
    let bg = viewerBox ? viewerTheme.backgroundColor : viewerTheme.getPropertyValue('--SmartThemeBlurTintColor').trim();
    if (!bg || bg === 'rgba(0, 0, 0, 0)') bg = viewerTheme.getPropertyValue('--SmartThemeBlurTintColor').trim();
    if (!bg || bg === 'rgba(0, 0, 0, 0)') bg = '#24242a';
    paper.style.setProperty('--paper-bg', options.mode === 'share-light' ? '#faf8f3' : options.mode === 'share-dark' ? '#20232a' : bg);
    paper.style.setProperty('--paper-fg', options.mode === 'share-light' ? '#24272c' : options.mode === 'share-dark' ? '#edeef2' : theme.color);
    paper.style.setProperty('--paper-font', options.mode === 'original' ? `${theme.fontSize} ${theme.fontFamily}` : '16px system-ui,sans-serif');
    const colors = { 'h-y': 'rgba(255,214,79,.45)', 'h-g': 'rgba(129,199,132,.45)', 'h-b': 'rgba(100,181,246,.42)', 'h-p': 'rgba(244,143,177,.45)', 'f-r': '#ff8a80', 'f-o': '#ffb74d', 'f-b': '#82b1ff', 'f-g': '#a5d6a7' };
    for (const [key, value] of Object.entries(colors)) paper.style.setProperty(`--fb-${key}`, theme.getPropertyValue(`--fb-${key}`).trim() || value);
    const header = doc.createElement('header');
    header.className = 'fbi-meta';
    if (options.title && meta.title) header.append(node('h1', meta.title));
    const values = { charName: meta.charName, chatName: meta.chatName, floor: meta.floor === undefined ? '' : `第 ${Number(meta.floor) + 1} 层${meta.swipeId === undefined ? '' : ` · 版本 ${Number(meta.swipeId) + 1}`}`, sender: meta.sender, tags: Array.isArray(meta.tags) ? meta.tags.join('、') : '', ts: meta.ts ? new Date(meta.ts).toLocaleString() : '' };
    for (const [key, value] of Object.entries(values)) if (options[key] && value !== '') header.append(node('p', `${labels[key]}：${value}`));
    if (header.childNodes.length) paper.append(header);
    // Keep network images in a document without a browsing context until their
    // local resources are ready; inserting them earlier starts a second request.
    const staging = document.implementation.createHTMLDocument('');
    const base = staging.createElement('base'); base.href = document.baseURI; staging.head.append(base);
    const body = staging.createElement('div'); body.className = 'fbv-body';
    body.innerHTML = full.html || '<p>（内容为空）</p>';
    if (options.marks && typeof applyMarks === 'function') applyMarks(body, full.marks || []);
    if (typeof prepareImageSnapshot === 'function') prepareImageSnapshot(body);
    // 智绘姬的按钮主题在宿主 head 中，将其外观带入独立的 PNG 文档。
    const chatuStyle = document.getElementById('st-chatu8-generate-btn-style');
    if (options.rich && body.querySelector('.st-chatu8-image-button') && chatuStyle?.tagName === 'STYLE') {
        const decoration = doc.createElement('style');
        decoration.textContent = '.st-chatu8-image-button{font-family:var(--mainFontFamily,sans-serif),sans-serif;font-size:var(--mainFontSize,14px)}\n' + chatuStyle.textContent;
        for (const [, name] of decoration.textContent.matchAll(/var\(\s*(--[\w-]+)/g)) {
            const value = theme.getPropertyValue(name).trim();
            if (value) paper.style.setProperty(name, value);
        }
        // Marks refer to saved text offsets and have already been applied. Place
        // host rules before saved styles so the snapshot keeps its own overrides.
        body.prepend(decoration);
    }
    for (const element of body.querySelectorAll('[data-fb-capture-warning]')) {
        warn(element.getAttribute('data-fb-capture-warning') || '收藏中的部分图片没有保存，请核对后再导出。');
    }
    const svgNamespace = 'http://www.w3.org/2000/svg';
    const isSvgImage = el => el.namespaceURI === svgNamespace && el.localName === 'image';
    const imageLabel = el => el.alt || el.getAttribute('aria-label') || '无说明';
    const imageSource = el => isSvgImage(el) ? (el.getAttribute('href') || el.getAttribute('xlink:href') || '') : el.getAttribute('src');
    function setImageSource(el, url) {
        if (isSvgImage(el)) { el.setAttribute('href', url); el.removeAttributeNS('http://www.w3.org/1999/xlink', 'href'); }
        else el.src = url;
    }
    function replaceImage(el, text) {
        if (isSvgImage(el)) {
            const placeholder = doc.createElementNS(svgNamespace, 'text');
            placeholder.setAttribute('x', el.getAttribute('x') || '0');
            placeholder.setAttribute('y', String((parseFloat(el.getAttribute('y')) || 0) + 18));
            placeholder.style.cssText = 'font:14px sans-serif;fill:currentColor';
            placeholder.textContent = text;
            el.replaceWith(placeholder);
        } else el.replaceWith(node('span', text, 'fbi-placeholder'));
    }
    for (const el of body.querySelectorAll('*')) {
        for (const attr of [...el.attributes]) if (/^on/i.test(attr.name) || ['autofocus', 'srcdoc'].includes(attr.name)) el.removeAttribute(attr.name);
        if (['SCRIPT', 'NOSCRIPT', 'BASE', 'META'].includes(el.tagName)) { el.remove(); continue; }
        if (['IFRAME', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO', 'CANVAS', 'LINK'].includes(el.tagName)) {
            const placeholder = node('span', `［${el.tagName.toLowerCase()} 内容未导出］`, 'fbi-placeholder');
            el.replaceWith(placeholder);
            warn('快照含嵌入内容或外部样式，已使用占位；脚本和交互内容不会执行。');
            continue;
        }
        if (el.tagName === 'STYLE') {
            if (/@import\b/i.test(el.textContent)) { warn('快照中的外部 CSS 导入未加载，已省略。'); el.textContent = el.textContent.replace(/@import\s+[^;]+;?/gi, ''); }
            el.textContent = el.textContent.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, url) => { try { return `url("${new URL(url, document.baseURI).href.replace(/"/g, '%22')}")`; } catch { return 'none'; } });
        }
        for (const attr of ['href', 'xlink:href', 'action', 'formaction']) if (el.hasAttribute(attr)) {
            const value = el.getAttribute(attr).trim();
            if (/^(?:javascript|vbscript|data):/i.test(value) && !(isSvgImage(el) && /^data:image\//i.test(value))) el.removeAttribute(attr);
        }
        if (el.hasAttribute('style')) el.style.cssText = el.style.cssText.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, url) => { try { return `url("${new URL(url, document.baseURI).href.replace(/"/g, '%22')}")`; } catch { return 'none'; } });
        if (el.tagName === 'IMG') {
            el.removeAttribute('srcset'); el.removeAttribute('loading');
        }
        if (el.tagName === 'IMG' || isSvgImage(el)) {
            try { setImageSource(el, new URL(imageSource(el) || '', document.baseURI).href); }
            catch { if (isSvgImage(el)) { el.removeAttribute('href'); el.removeAttributeNS('http://www.w3.org/1999/xlink', 'href'); } else el.removeAttribute('src'); }
        }
    }
    // Offsets always refer to the original snapshot DOM. Simplification happens
    // after marks are applied, and preserves only their spans and paragraph flow.
    if (!options.rich) {
        const blocks = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'LI', 'TR', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
        function simplify(item) {
            if (item.nodeType === 3) return doc.createTextNode(item.textContent);
            if (item.nodeType !== 1 || ['STYLE', 'SCRIPT', 'NOSCRIPT'].includes(item.tagName)) return doc.createDocumentFragment();
            if (['BR', 'IMG', 'svg'].includes(item.tagName)) return item.cloneNode(true);
            const el = doc.createElement(blocks.has(item.tagName) ? 'div' : 'span');
            if (item.classList.contains('fb-mark')) el.className = [...item.classList].filter(name => name === 'fb-mark' || /^fb-[hfu]-[ygbprosw]$/.test(name)).join(' ');
            else if (item.classList.contains('fbi-placeholder')) el.className = 'fbi-placeholder';
            for (const child of item.childNodes) el.append(simplify(child));
            if (blocks.has(item.tagName)) el.style.marginBottom = '.8em';
            return el;
        }
        body.replaceChildren(...[...body.childNodes].map(simplify));
    }
    if (!options.images) for (const img of body.querySelectorAll('img, svg image')) replaceImage(img, `［图片：${imageLabel(img)}］`);
    const resourceCache = new Map();
    async function resource(url) {
        if (url.startsWith('data:')) return url;
        if (cachedResources.has(url)) return cachedResources.get(url);
        if (!resourceCache.has(url)) resourceCache.set(url, (async () => {
            const response = await timeout(fetch(url, { signal, mode: 'cors', credentials: 'same-origin' }), signal);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const embedded = await dataUrl(await timeout(response.blob(), signal), signal);
            cachedResources.set(url, embedded);
            return embedded;
        })());
        return resourceCache.get(url);
    }
    await Promise.all([...body.querySelectorAll('img')].map(async img => {
        const src = imageSource(img);
        if (!src) return;
        const url = new URL(src, document.baseURI);
        if (!/^https?:$/.test(url.protocol) || url.origin !== location.origin) return;
        try { setImageSource(img, await resource(url.href)); }
        catch (error) {
            if (signal.aborted) throw error;
            warn(`图片缺失：${imageLabel(img)}（下载失败：${error.message}）`);
            replaceImage(img, `［图片缺失：${imageLabel(img)}］`);
        }
    }));
    paper.append(body);
    doc.body.append(paper);
    for (const root of [doc.documentElement, doc.body]) root.style.setProperty('overflow', 'hidden', 'important');
    if (!embedResources) {
        if (!options.images) {
            const hiddenImages = doc.createElement('style'); doc.head.append(hiddenImages);
            let imageId = 0;
            for (const el of [paper, ...paper.querySelectorAll('*')]) {
                if (['STYLE', 'SCRIPT'].includes(el.tagName)) continue;
                for (const pseudo of [null, '::before', '::after']) {
                    const computed = doc.defaultView.getComputedStyle(el, pseudo);
                    if (pseudo && ['none', 'normal', ''].includes(computed.content)) continue;
                    for (const property of ['background-image', 'border-image-source', 'list-style-image', 'mask-image', 'content']) {
                        if (!/url\(/i.test(computed.getPropertyValue(property))) continue;
                        if (!pseudo) el.style.setProperty(property, 'none');
                        else {
                            if (!el.hasAttribute('data-fbi-resource')) el.setAttribute('data-fbi-resource', String(++imageId));
                            hiddenImages.sheet.insertRule(`[data-fbi-resource="${el.getAttribute('data-fbi-resource')}"]${pseudo}{${property}:none!important}`);
                        }
                    }
                }
            }
        }
        await Promise.all([...body.querySelectorAll('img')].map(async img => {
            try {
                await timeout(img.decode(), signal);
            }
            catch (error) {
                if (signal.aborted) throw error;
                warn(`图片缺失：${imageLabel(img)}（解码失败：${error.message}）`);
                replaceImage(img, `［图片缺失：${imageLabel(img)}］`);
            }
        }));
        return { paper, height: Math.ceil(paper.getBoundingClientRect().height), warnings: [...warnings] };
    }
    for (const img of [...body.querySelectorAll('img, svg image')]) {
        try {
            if (!imageSource(img)) throw new Error('缺少地址');
            const embedded = await resource(imageSource(img));
            setImageSource(img, embedded);
            const probe = isSvgImage(img) ? doc.createElement('img') : img;
            if (probe !== img) probe.src = embedded;
            await timeout(probe.decode(), signal);
        } catch (error) {
            if (signal.aborted) throw error;
            warn(`图片缺失：${imageLabel(img)}（${error.message}）`);
            replaceImage(img, `［图片缺失：${imageLabel(img)}］`);
        }
    }
    // Resolve resources on the element and its rendered pseudo-elements before
    // capture; the renderer otherwise silently omits some failed CSS images.
    const resourceStyle = doc.createElement('style');
    doc.head.append(resourceStyle);
    let resourceId = 0;
    for (const el of [paper, ...paper.querySelectorAll('*')]) {
        if (['STYLE', 'SCRIPT'].includes(el.tagName)) continue;
        for (const pseudo of [null, '::before', '::after']) {
            const computed = doc.defaultView.getComputedStyle(el, pseudo);
            if (pseudo && ['none', 'normal', ''].includes(computed.content)) continue;
            for (const property of ['background-image', 'border-image-source', 'list-style-image', 'mask-image', 'content']) {
                const value = computed.getPropertyValue(property);
                const urls = [...value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)];
                if (!urls.length) continue;
                let embedded = options.images ? value : 'none';
                if (options.images) for (const match of urls) {
                    try { embedded = embedded.replace(match[0], `url("${await resource(new URL(match[2], document.baseURI).href)}")`); }
                    catch (error) {
                        if (signal.aborted) throw error;
                        warn(`CSS 图片资源缺失（${error.message}），已使用占位。`);
                        embedded = 'none';
                        el.append(node('span', '［背景图片缺失］', 'fbi-placeholder'));
                    }
                }
                if (pseudo) {
                    if (!el.hasAttribute('data-fbi-resource')) el.setAttribute('data-fbi-resource', String(++resourceId));
                    resourceStyle.sheet.insertRule(`[data-fbi-resource="${el.getAttribute('data-fbi-resource')}"]${pseudo}{${property}:${embedded}!important}`);
                } else el.style.setProperty(property, embedded);
            }
        }
    }
    // Only embed faces that this snapshot actually uses; inaccessible author styles
    // are outside the snapshot contract and are disclosed in the preview UI.
    const families = new Set([paper, ...paper.querySelectorAll('*')].flatMap(el => doc.defaultView.getComputedStyle(el).fontFamily.split(',').map(s => s.trim().replace(/["']/g, '').toLowerCase())));
    const fontRules = new Map();
    function collect(rules) {
        for (const rule of rules) {
            if (rule.type === CSSRule.FONT_FACE_RULE && families.has(rule.style.fontFamily.replace(/["']/g, '').toLowerCase())) {
                const base = rule.parentStyleSheet?.href || document.baseURI;
                fontRules.set(`${base}\n${rule.cssText}`, { css: rule.cssText, base });
            }
            else if (rule.cssRules) collect(rule.cssRules);
        }
    }
    for (const sheet of [...document.styleSheets, ...doc.styleSheets]) { try { collect(sheet.cssRules); } catch { /* External theme sheets are not part of saved HTML. */ } }
    const embeddedFonts = [];
    for (const rule of fontRules.values()) {
        let css = rule.css;
        for (const match of [...css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)]) {
            try { css = css.replace(match[0], `url("${await resource(new URL(match[2], rule.base).href)}")`); }
            catch (error) { if (signal.aborted) throw error; warn(`字体资源缺失（${error.message}），将使用系统字体。`); css = ''; break; }
        }
        if (css) {
            const face = doc.createElement('style'); face.textContent = css; doc.head.append(face);
            embeddedFonts.push(css);
        }
    }
    await timeout(doc.fonts.ready, signal);
    for (const font of doc.fonts) if (font.status === 'error') warn(`字体 ${font.family} 加载失败，将使用系统字体。`);
    await timeout(new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))), signal);
    return { paper, height: Math.ceil(paper.getBoundingClientRect().height), warnings: [...warnings], fontEmbedCSS: embeddedFonts.join('\n') || ' ' };
}

function planSegments(paper, height, contentHeight) {
    const doc = paper.ownerDocument;
    const origin = paper.getBoundingClientRect().top;
    const protectedAreas = [];
    function protect(rect, padding = 1, image = false) {
        if (!rect.width || !rect.height) return;
        const start = padding ? Math.floor(rect.top - origin) - padding : (image ? Math.floor : Math.round)((rect.top - origin) * RATIO) / RATIO;
        const end = padding ? Math.ceil(rect.bottom - origin) + padding : (image ? Math.ceil : Math.round)((rect.bottom - origin) * RATIO) / RATIO;
        protectedAreas.push([Math.max(PAGE_MARGIN, start), Math.min(height - PAGE_MARGIN, end)]);
    }
    const walker = doc.createTreeWalker(paper, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent.trim() || text.parentElement.closest('style,script')) continue;
        const range = doc.createRange();
        range.selectNodeContents(text);
        for (const rect of range.getClientRects()) protect(rect);
    }
    for (const element of paper.querySelectorAll('img,svg,tr')) {
        const rect = element.getBoundingClientRect();
        if (element.matches('img,svg') && rect.height > contentHeight) {
            const required = Math.ceil(rect.height + PAGE_MARGIN * 2) * RATIO;
            if (required > sizeRanges.maxHeight[1]) throw new Error(`单张图片需要至少 ${required} px 高，超过当前 ${sizeRanges.maxHeight[1]} px 设置范围，请单独保存原图；未裁切或缩小。`);
            throw new Error(`图片高度超过当前单段内容区，请提高每段最大高度至至少 ${required} px；若像素预算不足，可减小输出宽度。图片保持原尺寸，未裁切或缩小。`);
        }
        if (rect.height <= contentHeight) protect(rect, 0, element.matches('img,svg'));
    }
    const merged = [];
    for (const area of protectedAreas.sort((a, b) => a[0] - b[0])) {
        const previous = merged[merged.length - 1];
        if (previous && area[0] < previous[1]) previous[1] = Math.max(previous[1], area[1]);
        else merged.push(area);
    }
    const segments = [];
    const bottom = height - PAGE_MARGIN;
    for (let top = PAGE_MARGIN; top < bottom;) {
        let end = Math.min(bottom, top + contentHeight);
        if (end < bottom) {
            const crossing = merged.find(([start, bottom]) => start < end && bottom > end);
            if (crossing) end = crossing[0];
        }
        if (end <= top) throw new Error('单个内容块超过分段上限，请提高每段最大高度，或关闭富文本排版后重试');
        segments.push({ top, height: end - top });
        top = end;
    }
    return segments;
}

function mountPage(paper, segment, width) {
    const doc = paper.ownerDocument;
    const viewport = doc.createElement('div');
    const height = segment.height + PAGE_MARGIN * 2;
    const background = doc.defaultView.getComputedStyle(paper).backgroundColor;
    viewport.style.cssText = `width:${width}px;height:${height}px;padding:${PAGE_MARGIN}px 0;overflow:hidden;position:relative;background:${background};box-sizing:border-box`;
    const slice = doc.createElement('div');
    slice.style.cssText = `width:${width}px;height:${segment.height}px;overflow:hidden;position:relative`;
    paper.style.transform = `translateY(-${segment.top}px)`;
    paper.style.transformOrigin = 'top left';
    paper.before(viewport); viewport.append(slice); slice.append(paper);
    return viewport;
}

export async function openImageExport({ meta, full, applyMarks, prepareImageSnapshot }) {
    active?.close();
    if (!document.querySelector('link[data-fb-image-export]')) {
        const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = new URL('./image-export.css', import.meta.url).href; css.dataset.fbImageExport = ''; document.head.append(css);
    }
    const previousFocus = document.activeElement;
    const options = preferences();
    const overlay = node('div'); overlay.id = 'fb-image-export'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', '导出图片');
    overlay.innerHTML = `<section class="fbi-dialog"><header class="fbi-header"><h2>导出图片</h2><button type="button" class="menu_button fbi-close" aria-label="关闭图片预览">关闭</button></header><div class="fbi-layout"><aside class="fbi-options"><label class="fbi-mode">版式<select name="mode" class="text_pole"><option value="original">原样</option><option value="share-light">分享 · 浅色</option><option value="share-dark">分享 · 深色</option></select></label><fieldset class="fbi-sizes"><legend>图片尺寸 · px</legend><label for="fbi-width">输出宽度</label><div class="fbi-size-control"><input type="range" data-size="width" min="720" max="4096" step="2" aria-label="调整输出宽度"><input id="fbi-width" class="text_pole" type="number" name="width" min="720" max="4096" step="2"></div><label for="fbi-height">每段最大高度</label><div class="fbi-size-control"><input type="range" data-size="maxHeight" min="1024" max="32768" step="2" aria-label="调整每段最大高度"><input id="fbi-height" class="text_pole" type="number" name="maxHeight" min="1024" max="32768" step="2"></div></fieldset><details class="fbi-extra"><summary>说明项</summary><fieldset class="fbi-fields"></fieldset></details><details class="fbi-extra"><summary>正文选项</summary><fieldset class="fbi-content"></fieldset></details></aside><div class="fbi-workspace"><div class="fbi-progress"><div class="fbi-status" role="status" aria-live="polite">正在准备预览…</div><div class="fbi-warnings"></div><label class="fbi-confirm" hidden><input name="confirmMissing" type="checkbox">使用占位继续导出</label><div class="fbi-actions"><button type="button" class="menu_button fbi-generate" disabled>生成高清 PNG</button><button type="button" class="menu_button fbi-save" disabled hidden>保存 PNG</button><button type="button" class="menu_button fbi-edit" hidden>调整排版</button><button type="button" class="menu_button fbi-retry">重试</button><button type="button" class="menu_button fbi-cancel">中断</button></div><div class="fbi-page-nav" hidden><button type="button" class="menu_button fbi-prev">上一段</button><span class="fbi-page-count"></span><button type="button" class="menu_button fbi-next">下一段</button></div></div><div class="fbi-preview"></div></div></div></section>`;
    for (const key of Object.keys(labels)) {
        const label = node('label'); const input = node('input'); input.type = 'checkbox'; input.name = key; input.checked = options[key]; label.append(input, document.createTextNode(labels[key]));
        overlay.querySelector(['marks', 'images', 'rich'].includes(key) ? '.fbi-content' : '.fbi-fields').append(label);
    }
    overlay.querySelector('[name=mode]').value = options.mode;
    for (const key of Object.keys(sizeRanges)) {
        overlay.querySelector(`[name=${key}]`).value = options[key];
        overlay.querySelector(`[data-size=${key}]`).value = options[key];
    }
    document.body.append(overlay);
    const status = overlay.querySelector('.fbi-status'), preview = overlay.querySelector('.fbi-preview');
    const save = overlay.querySelector('.fbi-save'), generate = overlay.querySelector('.fbi-generate');
    const cancel = overlay.querySelector('.fbi-cancel'), edit = overlay.querySelector('.fbi-edit');
    const confirm = overlay.querySelector('[name=confirmMissing]'), navigation = overlay.querySelector('.fbi-page-nav');
    const previous = overlay.querySelector('.fbi-prev'), next = overlay.querySelector('.fbi-next');
    const urls = new Set(), cachedResources = new Map();
    let alive = true, revision = 0, debounce, aborter, workFrame, layoutFrame, layout, pageIndex = 0;
    let parts = [], missing = false, busy = false, ready = false, invalidInputs = false;
    function clearOutput() {
        parts = []; save.disabled = true; save.hidden = true; edit.hidden = true;
        preview.replaceChildren(); navigation.hidden = true;
        for (const url of urls) URL.revokeObjectURL(url);
        urls.clear();
    }
    function stop() {
        revision += 1; clearTimeout(debounce); aborter?.abort(); busy = false; ready = false;
        cancel.disabled = true; generate.disabled = true;
        workFrame?.remove(); layoutFrame?.remove(); workFrame = layoutFrame = layout = null;
    }
    function close() {
        if (!alive) return;
        alive = false; stop(); clearOutput(); cachedResources.clear(); document.removeEventListener('keydown', keyboard, true);
        window.removeEventListener('resize', placeExport); window.removeEventListener('scroll', placeExport);
        window.visualViewport?.removeEventListener('resize', placeExport); window.visualViewport?.removeEventListener('scroll', placeExport); overlay.remove();
        if (active?.close === close) active = null;
        if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    }
    function keyboard(event) {
        if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
        if (event.key !== 'Tab') return;
        const controls = [...overlay.querySelectorAll('button:not(:disabled),input,select')].filter(el => el.getClientRects().length);
        if (!controls.length) return;
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
    function refreshSave() {
        const allowed = alive && !busy && parts.length > 0 && (!missing || confirm.checked);
        save.disabled = !allowed;
        preview.querySelectorAll('button').forEach(button => { button.disabled = !allowed; });
    }
    function download(part, index) {
        if (busy || !alive || (missing && !confirm.checked) || !parts.includes(part)) return;
        const a = node('a'); a.href = part.url;
        const title = String(meta.title || meta.charName || '楼层书签').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80);
        a.download = `${title}${parts.length > 1 ? `-${index + 1}` : ''}.png`; a.click();
    }
    function frameFor(width, parent = document.body) {
        const frame = node('iframe'); frame.setAttribute('sandbox', 'allow-same-origin'); frame.tabIndex = -1;
        frame.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:1px;border:0;pointer-events:none;`;
        parent.append(frame); return frame;
    }
    function warnings(result, final) {
        missing = result.warnings.length > 0;
        overlay.querySelector('.fbi-warnings').textContent = result.warnings.join('\n');
        confirm.checked = false; confirm.parentElement.hidden = !final || !missing;
    }
    function fitPreview() {
        const holder = preview.querySelector('.fbi-layout-preview');
        if (!holder || !layoutFrame || !layout) return;
        const segment = layout.segments[pageIndex];
        const height = segment.height + PAGE_MARGIN * 2;
        const scale = Math.min(1, Math.max(100, preview.clientWidth - 36) / layout.width);
        holder.style.cssText = `width:${layout.width * scale}px;height:${height * scale}px;position:relative;margin:auto`;
        layoutFrame.style.cssText = `display:block;width:${layout.width}px;height:${height}px;border:0;transform:scale(${scale});transform-origin:top left;pointer-events:none;`;
    }
    function placeExport() {
        const viewport = window.visualViewport;
        const x = viewport?.offsetLeft || 0, y = viewport?.offsetTop || 0;
        overlay.style.left = '0px'; overlay.style.top = '0px';
        overlay.style.right = 'auto'; overlay.style.bottom = 'auto';
        overlay.style.width = `${viewport?.width || window.innerWidth}px`;
        overlay.style.height = `${viewport?.height || window.innerHeight}px`;
        // Tavern transforms html; compensate its fixed-position containing block
        // instead of allowing inset/flex centering against a long document.
        const origin = overlay.getBoundingClientRect();
        overlay.style.left = `${x - origin.left}px`; overlay.style.top = `${y - origin.top}px`;
        fitPreview();
    }
    function showPage() {
        if (!layout || !layoutFrame) return;
        const old = layout.viewport;
        if (old) { old.before(layout.paper); old.remove(); }
        layout.viewport = mountPage(layout.paper, layout.segments[pageIndex], layout.width);
        const segment = layout.segments[pageIndex];
        overlay.querySelector('.fbi-page-count').textContent = `${pageIndex + 1} / ${layout.segments.length} · ${options.width} × ${(segment.height + PAGE_MARGIN * 2) * RATIO} px`;
        previous.disabled = pageIndex === 0; next.disabled = pageIndex === layout.segments.length - 1;
        previous.hidden = next.hidden = layout.segments.length === 1;
        navigation.hidden = false; fitPreview();
    }
    async function preparePreview() {
        stop(); clearOutput();
        invalidInputs = Object.keys(sizeRanges).some(key => {
            const input = overlay.querySelector(`[name=${key}]`);
            return !input.value || !validSize(key, Number(input.value));
        });
        if (invalidInputs) { status.textContent = '请先填写范围内的偶数像素尺寸，再重试预览。'; return; }
        const ticket = revision, current = () => alive && ticket === revision;
        aborter = new AbortController(); const signal = aborter.signal;
        cancel.disabled = false; status.textContent = '正在准备预览…';
        const limits = pageLimits(options);
        const holder = node('div', undefined, 'fbi-layout-preview'); preview.append(holder);
        const frame = frameFor(limits.width, holder); workFrame = frame;
        try {
            const result = await renderSnapshot({ meta, full, applyMarks, prepareImageSnapshot, options: { ...options }, frame, signal, embedResources: false, cachedResources });
            if (!current()) return;
            const segments = planSegments(result.paper, result.height, limits.contentHeight);
            layout = { ...result, ...limits, segments }; pageIndex = Math.min(pageIndex, segments.length - 1);
            workFrame = null; layoutFrame = frame;
            showPage(); warnings(result, false); ready = true; generate.disabled = false; cancel.disabled = true;
            status.textContent = `排版预览 · ${segments.length} 段`;
        } catch (error) {
            if (!current()) return;
            frame.remove(); workFrame = null; cancel.disabled = true;
            status.textContent = error.name === 'AbortError' ? '已中断，可点击重试。' : `无法预览：${error.message}`;
        }
    }
    async function generatePng() {
        if (!ready || busy || invalidInputs) return;
        stop(); clearOutput();
        const ticket = revision, current = () => alive && ticket === revision;
        aborter = new AbortController(); const signal = aborter.signal;
        busy = true; cancel.disabled = false; status.textContent = '正在准备高清图片素材…';
        const selectedOptions = { ...options };
        const limits = pageLimits(selectedOptions), frame = frameFor(limits.width); workFrame = frame;
        try {
            const library = await timeout(loadLibrary(), signal);
            const result = await renderSnapshot({ meta, full, applyMarks, prepareImageSnapshot, options: selectedOptions, frame, signal, cachedResources });
            if (!current()) return;
            const segments = planSegments(result.paper, result.height, limits.contentHeight);
            warnings(result, true);
            for (let index = 0; index < segments.length; index += 1) {
                if (!current()) return;
                const segment = segments[index], height = segment.height + PAGE_MARGIN * 2;
                status.textContent = `正在生成第 ${index + 1} / ${segments.length} 段高清 PNG…`;
                const viewport = mountPage(result.paper, segment, limits.width);
                let blob;
                try { blob = await timeout(library.toBlob(viewport, { width: limits.width, height, canvasWidth: limits.width, canvasHeight: height, pixelRatio: RATIO, skipAutoScale: true, fontEmbedCSS: result.fontEmbedCSS, cacheBust: false }), signal, 45000); }
                finally { if (viewport.parentNode) { viewport.before(result.paper); viewport.remove(); } }
                if (!current()) return;
                if (!blob || blob.type !== 'image/png') throw new Error('浏览器无法生成此尺寸，请减小输出宽度或每段最大高度');
                const header = new DataView(await blob.slice(0, 24).arrayBuffer());
                if (!current()) return;
                if (header.byteLength < 24 || header.getUint32(16) !== selectedOptions.width || header.getUint32(20) !== height * RATIO) throw new Error('浏览器未保留指定图片尺寸，请减小宽度或分段高度后重试');
                const url = URL.createObjectURL(blob); urls.add(url); const part = { blob, url }; parts.push(part);
                const figure = node('figure'), img = node('img'); img.src = url; img.alt = `PNG 预览，第 ${index + 1} 段`;
                figure.append(img, node('figcaption', `${index + 1} / ${segments.length} · ${selectedOptions.width} × ${height * RATIO} px`));
                if (segments.length > 1) { const button = node('button', `保存第 ${index + 1} 段`); button.disabled = true; button.addEventListener('click', () => download(part, index)); figure.append(button); }
                preview.append(figure);
            }
            if (!current()) return;
            busy = false; ready = true; generate.disabled = false; cancel.disabled = true; edit.hidden = false; save.hidden = parts.length !== 1;
            status.textContent = missing ? `PNG 已生成 · ${parts.length} 段，请确认缺失素材` : `PNG 已生成 · ${parts.length} 段`;
            refreshSave();
        } catch (error) {
            if (!current()) return;
            clearOutput(); busy = false; ready = true; generate.disabled = false; cancel.disabled = true; edit.hidden = false;
            status.textContent = error.name === 'AbortError' ? '已中断，可点击重试。' : `生成失败：${error.message}`;
        } finally { frame.remove(); if (workFrame === frame) workFrame = null; }
    }
    function update(event) {
        const input = event.target;
        if (!(input.name in defaults)) return;
        // Number inputs emit input while typing and change again on blur. The
        // latter must not cancel a Generate/Next click for an unchanged value.
        if (input.name in sizeRanges && input.value && Number(input.value) === options[input.name] && !invalidInputs) return;
        stop(); clearOutput(); confirm.parentElement.hidden = true;
        if (input.name in sizeRanges) {
            const value = Number(input.value);
            if (!input.value || !validSize(input.name, value)) { invalidInputs = true; status.textContent = '请输入范围内的偶数像素尺寸，再生成预览。'; return; }
            options[input.name] = value;
            overlay.querySelector(`[data-size=${input.name}]`).value = value;
        } else options[input.name] = input.name === 'mode' ? input.value : input.checked;
        const invalid = Object.keys(sizeRanges).some(key => !overlay.querySelector(`[name=${key}]`).validity.valid || !overlay.querySelector(`[name=${key}]`).value);
        invalidInputs = invalid;
        if (invalid) { status.textContent = '请先填写有效的图片尺寸。'; return; }
        try { localStorage.setItem(PREF_KEY, JSON.stringify(options)); } catch { /* Session controls remain usable without storage. */ }
        status.textContent = '正在更新排版预览…'; debounce = setTimeout(preparePreview, 180);
    }
    overlay.querySelector('.fbi-close').addEventListener('click', close);
    overlay.addEventListener('pointerdown', event => { if (event.target === overlay) close(); });
    overlay.querySelector('.fbi-retry').addEventListener('click', preparePreview);
    edit.addEventListener('click', preparePreview); generate.addEventListener('click', generatePng);
    cancel.addEventListener('click', () => { stop(); clearOutput(); status.textContent = '已中断，可点击重试预览。'; });
    previous.addEventListener('click', () => { if (layout && pageIndex > 0) { pageIndex -= 1; showPage(); } });
    next.addEventListener('click', () => { if (layout && pageIndex < layout.segments.length - 1) { pageIndex += 1; showPage(); } });
    confirm.addEventListener('change', refreshSave);
    save.addEventListener('click', () => { if (parts.length === 1) download(parts[0], 0); });
    overlay.querySelector('.fbi-options').addEventListener('change', update);
    overlay.querySelector('.fbi-options').addEventListener('input', event => {
        const size = event.target.dataset.size;
        if (size in sizeRanges) {
            const number = overlay.querySelector(`[name=${size}]`); number.value = event.target.value;
            update({ target: number });
        } else if (event.target.name in sizeRanges) update(event);
    });
    document.addEventListener('keydown', keyboard, true); window.addEventListener('resize', placeExport); window.addEventListener('scroll', placeExport, { passive: true });
    window.visualViewport?.addEventListener('resize', placeExport); window.visualViewport?.addEventListener('scroll', placeExport);
    active = { close }; placeExport(); overlay.querySelector('.fbi-close').focus({ preventScroll: true }); debounce = setTimeout(preparePreview, 0); return active;
}
