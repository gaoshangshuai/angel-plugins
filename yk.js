// 优酷影视 - XPTV 插件
// 取流：mtop.youku.play.ups.appinfo.get（服务端签名中转 → 设备端可播）
//
// 为什么必须走中转：
//   ups.appinfo.get 是 mtop 签名接口，签名 = md5(令牌 & 时间戳 & appKey & data)，
//   令牌由服务端通过 Set-Cookie 下发（_m_h5_tk）。XPTV 的 iOS 网络层不把 Set-Cookie
//   暴露给 JS，插件拿不到令牌 → 签名必然错 → 服务端返回 FAIL_SYS_ILLEGAL_ACCESS。
//   因此令牌获取 + 签名 + ckey 轮换全部放在中转服务（服务端有完整 Cookie 能力），
//   插件只发一个普通 GET 拿现成 m3u8。硬编码 token / ckey 的方案（你给的那版）
//   在令牌轮换后必然失效，这也是它播不了的原因。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// 取流中转（公网，2026-11-25 发布；含直播与点播）
const RELAY = 'https://youku-ckey-service.app.workbuddy.host/yk/a3f7c29e51b8d640';
const RELAY_QS = '?sharecode=TTQUPYMAC5';   // 必须拼在 URL 末尾

const appConfig = {
    ver: 1,
    title: '优酷影视',
    site: 'https://www.youku.com',
    tabs: [
        { name: '电影', ext: { id: '电影' } },
        { name: '电视剧', ext: { id: '电视剧' } },
        { name: '动漫', ext: { id: '动漫' } },
        { name: '短剧', ext: { id: '短剧' } },
        { name: '综艺', ext: { id: '综艺' } },
        { name: '少儿', ext: { id: '少儿' } },
        { name: '纪录片', ext: { id: '纪录片' } }
    ]
};

const SESSION = {};
const filterList = {};

function getHeaders() {
    return { 'User-Agent': UA, 'Referer': 'https://www.youku.com' };
}

function httpsIt(u) {
    const s = String(u || '');
    return s.indexOf('http://') === 0 ? 'https://' + s.slice(7) : s;
}

function emsg(e) {
    return String((e && e.message) || e).slice(0, 120);
}

// ==================== 列表 ====================

async function fetchCategory(id, filters, page, session) {
    const params = Object.assign({}, filters || {});
    params.type = id;
    const paramsStr = encodeURIComponent(JSON.stringify(params));

    let url;
    if (page > 1 && session) {
        url = appConfig.site + '/category/data?session=' + encodeURIComponent(session) + '&pageNo=' + page + '&params=' + paramsStr;
    } else {
        url = appConfig.site + '/category/data?optionRefresh=1&pageNo=' + page + '&params=' + paramsStr;
    }

    const res = await $fetch.get(url, { headers: getHeaders() });
    const json = JSON.parse(res.data);
    const filterData = (json.data && json.data.filterData) || {};

    let sess = filterData.session;
    if (sess && typeof sess !== 'string') sess = JSON.stringify(sess);

    return { listData: filterData.listData || [], session: sess || '' };
}

async function getConfig() { return JSON.stringify(appConfig); }

async function getCards(ext) {
    ext = typeof ext === 'string' ? JSON.parse(ext) : (ext || {});
    const id = ext.id || '电影';
    const page = Number(ext.page || 1);
    const filters = ext.filters || {};

    let result;
    if (page > 1 && !SESSION[id]) {
        const first = await fetchCategory(id, filters, 1, '');
        SESSION[id] = first.session;
        result = await fetchCategory(id, filters, page, SESSION[id]);
    } else {
        result = await fetchCategory(id, filters, page, SESSION[id]);
    }
    if (result.session) SESSION[id] = result.session;

    const cards = [];
    (result.listData || []).forEach(function (it) {
        const link = it.videoLink || '';
        let vid = '';
        if (it.rightTagColor === 'BLUE' && link.indexOf('groupId=') >= 0) {
            const m = link.match(/groupId=([^&]+)/);
            if (m) vid = m[1];
        } else if (link.indexOf('id_') >= 0) {
            vid = link.split('id_')[1].split('.html')[0];
        }
        if (!vid) return;                       // 没有可播 id 的条目直接丢（避免点开空白）
        cards.push({
            vod_id: vid,
            vod_name: it.title || '',
            vod_pic: httpsIt(it.img || ''),
            vod_remarks: it.subTitle || '',
            vod_content: it.summary || '',
            ext: { id: vid, name: it.title || '' }
        });
    });

    return JSON.stringify({ list: cards, filter: filterList[id] || [] });
}

// ==================== 剧集 ====================

async function getTracks(ext) {
    ext = typeof ext === 'string' ? JSON.parse(ext) : (ext || {});
    let showId = ext.id;
    const name = ext.name || '';

    // 卡片 id 不是 showId 时（部分榜单给的是单个 videoId），用标题反查 showId
    if (!showId && name) {
        const sUrl = 'https://search.youku.com/api/search?pg=1&keyword=' + encodeURIComponent(name);
        const res = await $fetch.get(sUrl, { headers: getHeaders() });
        const sJson = JSON.parse(res.data);
        const item = (sJson.pageComponentList || []).find(function (x) { return x && x.commonData; });
        if (item) showId = item.commonData.showId;
    }
    if (!showId) return JSON.stringify({ list: [] });

    const url = 'https://search.youku.com/api/search?appScene=show_episode&showIds=' + encodeURIComponent(showId);
    const res2 = await $fetch.get(url, { headers: getHeaders() });
    const json = JSON.parse(res2.data);

    const tracks = [];
    (json.serisesList || []).forEach(function (it) {
        if (!it || !it.videoId) return;
        const epName = it.showVideoStage
            ? String(it.showVideoStage).replace('期', '集')
            : (it.displayName || it.title || '');
        tracks.push({
            name: epName,
            ext: { id: it.videoId, showId: showId, name: epName }
        });
    });

    return JSON.stringify({ list: [{ title: '默认清晰度', tracks: tracks }] });
}

// ==================== 播放 ====================

async function relayVod(vid) {
    if (!RELAY) return { err: '未配置中转' };
    const url = RELAY + '/vod/' + encodeURIComponent(vid) + RELAY_QS;
    const res = await $fetch.get(url, { headers: { 'Accept': 'application/json' } });
    const txt = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    let j = null;
    try { j = JSON.parse(txt); } catch (e) { return { err: '中转返回非JSON' }; }
    if (j && j.url) return j;
    return { err: (j && j.err) || '中转无流' };
}

async function getPlayinfo(ext) {
    ext = typeof ext === 'string' ? JSON.parse(ext) : (ext || {});
    const vid = String(ext.id || '').trim();
    if (!vid) return JSON.stringify({ urls: [] });

    // 中转首次 + 一次重试（服务端令牌抖动时）
    for (let i = 0; i < 2; i++) {
        try {
            const r = await relayVod(vid);
            if (r && r.url) {
                return JSON.stringify({
                    urls: [httpsIt(r.url)],
                    headers: [{ 'User-Agent': UA, 'Referer': 'https://v.youku.com/' }]
                });
            }
            if (i === 1) {
                // 失败也回一个可读的错误，方便在播放器里看到原因
                return JSON.stringify({
                    urls: [],
                    header: { 'User-Agent': UA },
                    msg: '取流失败：' + (r.err || '未知')
                });
            }
        } catch (e) {
            if (i === 1) return JSON.stringify({ urls: [], msg: '取流异常：' + emsg(e) });
        }
    }
    return JSON.stringify({ urls: [] });
}

// ==================== 搜索 ====================

async function search(ext) {
    ext = typeof ext === 'string' ? JSON.parse(ext) : (ext || {});
    const text = String(ext.text || ext.wd || ext.keyword || '').trim();
    const page = Number(ext.page || 1);
    if (!text) return JSON.stringify({ list: [] });

    // 纯 videoId / showId：直接给一张卡，省一次搜索
    if (/^[A-Za-z0-9=+/_]{8,}$/.test(text)) {
        return JSON.stringify({
            list: [{
                vod_id: text,
                vod_name: text,
                vod_pic: '',
                vod_remarks: '按 ID 播放',
                ext: { id: text, name: '' }
            }]
        });
    }

    const url = 'https://search.youku.com/api/search?pg=' + page + '&keyword=' + encodeURIComponent(text);
    const res = await $fetch.get(url, { headers: getHeaders() });
    const json = JSON.parse(res.data);

    const cards = [];
    (json.pageComponentList || []).forEach(function (it) {
        if (!it || !it.commonData) return;
        const c = it.commonData;
        const title = (c.titleDTO && c.titleDTO.displayName) || '';
        if (!c.showId) return;
        cards.push({
            vod_id: c.showId,
            vod_name: title,
            vod_pic: httpsIt((c.posterDTO && c.posterDTO.vThumbUrl) || ''),
            vod_remarks: c.stripeBottom || '',
            ext: { id: c.showId, name: title }
        });
    });

    return JSON.stringify({ list: cards });
}
