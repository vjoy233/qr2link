/**
 * parsers.js — QR2Link 结构化内容解析（V1.2-PLAN PR-2，C1；DESIGN §4.4 渲染契约不变）
 *
 * 挂载全局命名空间 window.Parsers：
 *   parse(text) → {kind, …} | null
 *       null = 不识别 / 防御性拒绝 → 调用方回落纯文本卡片（锁定契约，e2e F 组负面用例）
 *       kind ∈ wifi | totp | hotp | vcard | tel | sms | mailto | geo
 *   generateTotp(secretB32, {digits, period, algorithm}, atMs?) → Promise<string>
 *       RFC 6238 动态验证码（拍板①：WebCrypto HMAC 本地生成，零网络）；
 *       正确性由 e2e F4 以 RFC 6238 Appendix B 官方测试向量锁定
 *   totpRemaining(period, atMs?) → number 当前窗口剩余秒数（倒计时显示）
 *   maskSecrets(text) → otpauth:// 的 secret= 参数显示层打码；其余文本原样返回
 *       （存储 / 复制保持原文 —— 打码只发生在显示层，PR-2 review P1）
 *
 * 防御性上限（超限 / 畸形一律返回 null，绝不抛错、绝不半解析渲染）：
 *   输入 ≤ 4096 字符；WIFI 字段数 ≤ 16、单字段（还原转义后）≤ 256；
 *   vCard 行数 ≤ 100、单行 ≤ 512；tel/sms/mailto/geo 各值 ≤ 256
 *
 * 解析原则：宽容输入（前缀大小写、Base32 大小写 / 内嵌空白归一），严格输出
 * （任一必填字段缺失或枚举字段非法 → 整体 null）；重复字段后值覆盖
 * （与 URLSearchParams 语义一致，F1/F2 测试锁定）。
 */
(function () {
  'use strict';

  var MAX_TEXT = 4096;
  var WIFI_MAX_PAIRS = 16;
  var WIFI_MAX_FIELD = 256;
  var VCARD_MAX_LINES = 100;
  var VCARD_MAX_LINE = 512;
  var URI_MAX_VALUE = 256;

  // ---------------- WIFI:（转义 \; \, \: \\ 按规范还原） ----------------
  // 按「未转义分号」切分并还原转义；悬空反斜杠视为畸形返回 null
  function splitWifiParts(s) {
    var parts = [], cur = '', i = 0;
    while (i < s.length) {
      var c = s.charAt(i);
      if (c === '\\') {
        if (i + 1 >= s.length) return null;
        cur += s.charAt(i + 1);
        i += 2;
        continue;
      }
      if (c === ';') {
        parts.push(cur);
        cur = '';
        i++;
        continue;
      }
      cur += c;
      i++;
    }
    parts.push(cur);
    return parts;
  }

  function parseWifi(text) {
    var body = text.slice(5); // 去掉 'WIFI:'（前缀匹配已保证）
    if (body.length > MAX_TEXT) return null;
    var parts = splitWifiParts(body);
    if (!parts) return null;
    var map = {};
    var count = 0;
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (!seg) continue; // 末尾 ';;' 产生的空段
      if (++count > WIFI_MAX_PAIRS) return null;
      var colon = seg.indexOf(':');
      if (colon <= 0) return null; // 无 key / 无冒号分隔
      var key = seg.slice(0, colon).toUpperCase();
      var value = seg.slice(colon + 1);
      if (value.length > WIFI_MAX_FIELD) return null;
      map[key] = value; // 重复字段后值覆盖（锁定契约）
    }
    if (!map.S || !map.S.length) return null; // SSID 必填
    var auth;
    if (!map.T) auth = 'nopass';
    else {
      var t = map.T.toUpperCase();
      if (t === 'WPA' || t === 'WPA2') auth = 'WPA';
      else if (t === 'WEP') auth = 'WEP';
      else if (t === 'NOPASS' || t === '') auth = 'nopass';
      else return null; // 未知加密方式 → 整体拒绝
    }
    var hidden = false;
    if (map.H) {
      var h = map.H.toLowerCase();
      if (h === 'true') hidden = true;
      else if (h === 'false') hidden = false;
      else return null;
    }
    return {
      kind: 'wifi',
      ssid: map.S,
      auth: auth,
      password: map.P || null,
      hidden: hidden,
    };
  }

  // ---------------- otpauth://（RFC 6238 TOTP / RFC 4226 HOTP URI 格式） ----------------
  var B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  // 严格 Base32 解码（RFC 4648，canonical 校验，PR #5 review P2 采纳）：
  // 去空白/连字符 → 大写 → 字符集 / 尾位组合 / 填充数量 / 未用尾位 全量校验；
  // 非法字符、非规范长度、非 canonical 填充（如 GE= / GE=======）或尾位非零（如 GF）一律 null
  function base32Decode(s) {
    var clean = String(s).replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-Z2-7]+=*$/.test(clean)) return null;
    var pad = clean.length - clean.replace(/=+$/, '').length;
    var body = clean.slice(0, clean.length - pad);
    var bits = 0, value = 0, out = [];
    for (var i = 0; i < body.length; i++) {
      var idx = B32_ALPHABET.indexOf(body.charAt(i));
      if (idx < 0) return null;
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        out.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    // 长度合法性：规范的无填充长度（字符数 mod 8 ∈ {0,2,4,5,7}）解码后残位 ∈ 0–4；
    // 残位 >4（mod 8 ∈ {1,3,6}）意味着本可再编一个字符，拒绝
    if (bits > 4) return null;
    // 填充规范性：有 '=' 时数量必须恰为 canonical 值（期望填充 (8 - len%8)%8 ∈ {1,3,4,6}；
    // body 长已对齐 8 时不允许任何 '='）
    if (pad > 0) {
      var expectPad = (8 - (body.length % 8)) % 8;
      if (expectPad === 0 || pad !== expectPad) return null;
    }
    // 未用尾位必须为 0：canonical 编码器只在最后一个字符内补零（如 'GF' 的尾位 01 ≠ 0 → 拒绝）
    if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) return null;
    return out;
  }

  function parseIntParam(raw, def, min, max) {
    if (raw == null) return def;
    if (!/^\d+$/.test(raw)) return null; // 拒绝 '6.5' / '6abc' / 负号
    var n = parseInt(raw, 10);
    if (n < min || n > max) return null;
    return n;
  }

  function normalizeAlgorithm(raw) {
    var a = String(raw || 'SHA1').toUpperCase();
    return (a === 'SHA1' || a === 'SHA256' || a === 'SHA512') ? a : null;
  }

  // query 参数取末值（PR #5 review P2 采纳）：URLSearchParams.get() 取第一个，
  // 与本文件「重复字段后值覆盖」契约不一致；显式迭代取最后一项（%XX 解码后按键名精确匹配，
  // 与 URLSearchParams 同源——'secret' 与 '%73ecret' 为同一参数名）
  function lastParam(sp, name) {
    var v = null;
    sp.forEach(function (value, key) {
      if (key === name) v = value;
    });
    return v;
  }

  function parseOtpauth(text) {
    var u;
    try {
      u = new URL(text); // otpauth 为非特殊 scheme：host 承载 type，pathname 承载 label
    } catch (e) { return null; }
    var type = u.host.toLowerCase();
    if (type !== 'totp' && type !== 'hotp') return null;
    var label = '';
    try {
      label = decodeURIComponent(u.pathname.replace(/^\//, ''));
    } catch (e) { return null; }
    // label 形如 'issuer:account'（issuer 可选）；issuer 亦可由 query 提供
    // （Google Key URI 规范）——query issuer 优先，缺省回落 label 前段（PR #5 review P2 采纳）
    var colon = label.indexOf(':');
    var labelIssuer = colon >= 0 ? label.slice(0, colon) : '';
    var account = colon >= 0 ? label.slice(colon + 1) : label;
    var q = u.searchParams;
    var issuer = lastParam(q, 'issuer') || labelIssuer;
    var secretRaw = lastParam(q, 'secret');
    if (secretRaw == null || !String(secretRaw).length) return null;
    var secret = String(secretRaw).replace(/[\s-]/g, '').toUpperCase(); // 大小写/空白宽容归一
    var secretBytes = base32Decode(secret);
    if (!secretBytes || !secretBytes.length || secretBytes.length > 128) return null;
    var algorithm = normalizeAlgorithm(lastParam(q, 'algorithm'));
    if (!algorithm) return null;
    var digits = parseIntParam(lastParam(q, 'digits'), 6, 6, 8);
    if (digits == null) return null;
    if (type === 'totp') {
      var period = parseIntParam(lastParam(q, 'period'), 30, 2, 3600);
      if (period == null) return null;
      return {
        kind: 'totp', issuer: issuer, account: account, secret: secret,
        digits: digits, period: period, algorithm: algorithm,
      };
    }
    var counter = parseIntParam(lastParam(q, 'counter'), 0, 0, Number.MAX_SAFE_INTEGER);
    if (counter == null) return null;
    return {
      kind: 'hotp', issuer: issuer, account: account, secret: secret,
      digits: digits, counter: counter, algorithm: algorithm,
    };
  }

  // RFC 6238 动态码（拍板①）：WebCrypto HMAC + 动态截断；atMs 缺省取当前时间。
  // secretB32 为 Base32 密钥；opts 与 parse 输出字段同构。
  // 参数校验与 parseOtpauth 共享口径（PR #5 review P3 采纳）：digits/period 越界或非整数
  // 一律 reject，不静默吞成默认值；缺省时才取 6 / 30
  function generateTotp(secretB32, opts, atMs) {
    opts = opts || {};
    var digits = opts.digits == null ? 6 : opts.digits;
    if (typeof digits !== 'number' || !Number.isInteger(digits) || digits < 6 || digits > 8) {
      return Promise.reject(new Error('BAD_DIGITS'));
    }
    var period = opts.period == null ? 30 : opts.period;
    if (typeof period !== 'number' || !Number.isInteger(period) || period < 2 || period > 3600) {
      return Promise.reject(new Error('BAD_PERIOD'));
    }
    var hashName = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' }[String(opts.algorithm || 'SHA1').toUpperCase()];
    if (!hashName) return Promise.reject(new Error('BAD_ALGORITHM'));
    var keyBytes = base32Decode(secretB32);
    if (!keyBytes || !keyBytes.length) return Promise.reject(new Error('BAD_SECRET'));
    var counter = Math.floor((atMs == null ? Date.now() : atMs) / 1000 / period);
    var msg = new Uint8Array(8);
    var dv = new DataView(msg.buffer);
    dv.setUint32(0, Math.floor(counter / 4294967296));
    dv.setUint32(4, counter >>> 0);
    var keyBuf = new Uint8Array(keyBytes);
    return crypto.subtle.importKey('raw', keyBuf, { name: 'HMAC', hash: { name: hashName } }, false, ['sign'])
      .then(function (k) { return crypto.subtle.sign('HMAC', k, msg); })
      .then(function (sig) {
        var hb = new Uint8Array(sig);
        var off = hb[hb.length - 1] & 0xf; // 动态截断（RFC 4226 §5.3）
        var dyn = ((hb[off] & 0x7f) << 24) | (hb[off + 1] << 16) | (hb[off + 2] << 8) | hb[off + 3];
        var code = String(dyn % Math.pow(10, digits));
        while (code.length < digits) code = '0' + code; // 前导零补齐
        return code;
      });
  }

  // 倒计时纯函数（显示用）：period 非法时按默认 30 兜底（非法值不产生 NaN 污染 UI；
  // 真正的校验在 parseOtpauth / generateTotp 侧，PR #5 review P3）
  function totpRemaining(period, atMs) {
    if (typeof period !== 'number' || !Number.isInteger(period) || period < 1) period = 30;
    var sec = Math.floor((atMs == null ? Date.now() : atMs) / 1000);
    return period - (sec % period);
  }

  // ---------------- vCard（BEGIN:VCARD … END:VCARD） ----------------
  // 单趟左到右扫描反转义（PR #5 review P2 采纳）：vCard 3.0 的 \\ \n(\N) \; \,；
  // 两段 replace 会把字面量「反斜杠 + n」（\\n 序列）误变两次——'a\\nb' 应得 'a\nb'
  // （反斜杠 + 字母 n），而非换行
  function vcardUnescape(v) {
    var out = '', i = 0;
    while (i < v.length) {
      var c = v.charAt(i);
      if (c === '\\' && i + 1 < v.length) {
        var n = v.charAt(i + 1);
        out += (n === 'n' || n === 'N') ? '\n' : n;
        i += 2;
      } else {
        out += c;
        i++;
      }
    }
    return out;
  }

  function parseVcard(text) {
    if (!/^BEGIN:VCARD\r?\n/i.test(text)) return null;
    var rawLines = text.split(/\r?\n/);
    if (rawLines.length > VCARD_MAX_LINES) return null;
    for (var i = 0; i < rawLines.length; i++) {
      if (rawLines[i].length > VCARD_MAX_LINE) return null;
    }
    // 换行折叠（RFC 2425 §5.8.1）：以空格/制表符开头的行拼接前一行
    var lines = [];
    for (var j = 0; j < rawLines.length; j++) {
      var ln = rawLines[j];
      if ((ln.charAt(0) === ' ' || ln.charAt(0) === '\t') && lines.length) {
        lines[lines.length - 1] += ln.slice(1);
        if (lines[lines.length - 1].length > VCARD_MAX_LINE) return null; // 展开后超长同样拒绝
        continue;
      }
      lines.push(ln);
    }
    // 记录级校验（PR #5 review P2 采纳）：END:VCARD 必须是独立记录行——值里出现
    // （如 FN:END:VCARD）不算结束；结束后只允许空行；无冒号的非结构行拒绝
    // （与「畸形一律 null、绝不半解析」契约一致；未知属性「有冒号」仍宽容忽略）
    if (lines[0].toUpperCase() !== 'BEGIN:VCARD') return null;
    var endIdx = -1;
    for (var r = 1; r < lines.length; r++) {
      var rl = lines[r];
      if (!rl) continue; // 空行（含结尾换行产生的尾空行）忽略
      var upper = rl.toUpperCase();
      if (endIdx < 0 && upper === 'END:VCARD') { endIdx = r; continue; }
      if (endIdx >= 0) return null; // 结束记录之后的非空尾随内容 → 拒绝
      if (upper === 'BEGIN:VCARD') return null; // 不支持嵌套
      if (rl.indexOf(':') <= 0) return null; // 无冒号 / 无属性名的非结构行 → 拒绝
    }
    if (endIdx < 0) return null; // 无独立结束记录
    var fn = '', org = '', title = '';
    var tels = [], emails = [];
    for (var k = 1; k < endIdx; k++) {
      var line = lines[k];
      if (!line) continue;
      var c = line.indexOf(':');
      if (c <= 0) continue; // 上方记录级校验已拒绝；此处兜底
      var name = line.slice(0, c).split(';')[0].toUpperCase(); // 剥离 ;TYPE=… 等参数
      var value = vcardUnescape(line.slice(c + 1));
      if (name === 'FN') fn = value;
      else if (name === 'ORG') org = value.split(';')[0]; // ORG 可为分号多段，取主段
      else if (name === 'TITLE') title = value;
      else if (name === 'TEL') { if (value && tels.length < 8) tels.push(value); }
      else if (name === 'EMAIL') { if (value && emails.length < 8) emails.push(value); }
    }
    if (!fn && !tels.length && !emails.length && !org && !title) return null; // 无任何可展示字段
    return {
      kind: 'vcard', fn: fn, tels: tels, emails: emails, org: org, title: title,
      raw: text, // 下载 .vcf 用原文（textContent 渲染 / data-URI 下载均不经过 HTML 解析）
    };
  }

  // ---------------- tel: / sms: / smsto: / mailto: / geo:（仅复制，不打开） ----------------
  // 号号最小语法（PR #5 review P2 采纳）：'+' 只允许出现在首位（0 或 1 次），其余为
  // 数字/分隔符；且必须含至少一个数字（拒绝 'tel:+' / 'tel:++' / 'tel:()'）
  function checkTelNumber(num) {
    return /^\+?[0-9\-().\s]{1,63}$/.test(num) && /[0-9]/.test(num);
  }

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return null; }
  }

  function parseTel(text) {
    var num = safeDecode(text.slice(4).trim());
    if (!num || !checkTelNumber(num)) return null;
    return { kind: 'tel', number: num };
  }

  function parseSms(text) {
    var rest = text.slice(text.toLowerCase().indexOf(':') + 1); // sms: / smsto:
    var number = null, body = null;
    var q = rest.indexOf('?');
    if (/^smsto:/i.test(text)) {
      // Android 常见形态 smsto:number,body；亦宽容 ?body= 形态
      var comma = rest.indexOf(',');
      if (comma >= 0) {
        number = safeDecode(rest.slice(0, comma).trim());
        body = safeDecode(rest.slice(comma + 1));
      } else {
        number = safeDecode((q >= 0 ? rest.slice(0, q) : rest).trim());
        if (q >= 0) body = lastParam(new URLSearchParams(rest.slice(q + 1)), 'body');
      }
    } else {
      number = safeDecode((q >= 0 ? rest.slice(0, q) : rest).trim());
      if (q >= 0) body = lastParam(new URLSearchParams(rest.slice(q + 1)), 'body');
    }
    if (!number || !checkTelNumber(number)) return null;
    if (body != null && body.length > URI_MAX_VALUE) return null;
    return { kind: 'sms', number: number, body: body || null };
  }

  function parseMailto(text) {
    var rest = text.slice(7); // 去掉 'mailto:'
    var q = rest.indexOf('?');
    var to = safeDecode((q >= 0 ? rest.slice(0, q) : rest).trim());
    if (!to || !to.length || to.length > URI_MAX_VALUE) return null;
    var subject = null, body = null;
    if (q >= 0) {
      var sp = new URLSearchParams(rest.slice(q + 1));
      subject = lastParam(sp, 'subject'); // 重复参数末值覆盖（与本文件契约一致）
      body = lastParam(sp, 'body');
    }
    if (subject != null && subject.length > URI_MAX_VALUE) return null;
    if (body != null && body.length > URI_MAX_VALUE) return null;
    return { kind: 'mailto', to: to, subject: subject || null, body: body || null };
  }

  function parseGeo(text) {
    var rest = text.slice(4).split(';')[0]; // 剥离 ;crs=… 等参数
    var parts = rest.split(',');
    // RFC 5870：lat,lon[,alt]——至多三段（PR #5 review P2 采纳：第三段存在即须为合法数值，
    // 更多逗号段拒绝；每段长度受 URI_MAX_VALUE 约束）
    if (parts.length < 2 || parts.length > 3) return null;
    var lat = parts[0].trim(), lon = parts[1].trim();
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].trim().length > URI_MAX_VALUE) return null;
    }
    if (parts.length === 3) {
      var alt = parts[2].trim();
      if (!/^[-+]?\d+(\.\d+)?$/.test(alt)) return null; // 海拔可为负
    }
    if (!/^-?\d+(\.\d+)?$/.test(lat) || !/^-?\d+(\.\d+)?$/.test(lon)) return null;
    var la = parseFloat(lat), lo = parseFloat(lon);
    if (la < -90 || la > 90 || lo < -180 || lo > 180) return null;
    return { kind: 'geo', lat: la, lon: lo };
  }

  // ---------------- 显示层打码（存储 / 复制保持原文） ----------------
  var MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'; // •×8

  // PR #5 review P1 修复 + 复核 P3 改进：对原始 query 做「段级替换」——只把解码后
  // 参数名为 secret（大小写宽容，%73ecret 等编码形态同源）的段替换为打码值，其余段、
  // path 与编码形态全部原样保留（issuer=Foo+Bar 不会被重编码成 Foo%20Bar）；重复
  // secret 逐项全部遮蔽。契约：显示层允许去掉首尾空白（判断前 trim）；存储/复制取原文。
  // new URL 仅作「可解析的 URL 形态」守门，失败原样返回（parse 亦不命中，无打码面）
  function maskSecrets(text) {
    if (typeof text !== 'string') return text;
    var t = text.trim();
    if (!/^otpauth:\/\//i.test(t)) return text;
    try {
      new URL(t);
    } catch (e) {
      return text;
    }
    var hashIdx = t.indexOf('#');
    var head = hashIdx >= 0 ? t.slice(0, hashIdx) : t;
    var tail = hashIdx >= 0 ? t.slice(hashIdx) : '';
    var qIdx = head.indexOf('?');
    if (qIdx < 0) return head + tail; // 无 query 即无 secret
    var segments = head.slice(qIdx + 1).split('&');
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var eq = seg.indexOf('=');
      if (eq <= 0) continue; // 裸 flag 段 / 无 '=' 段不动
      var name = null;
      try {
        name = decodeURIComponent(seg.slice(0, eq));
      } catch (e) { name = null; } // 非法 %XX：URLSearchParams 同样按字面保留，不匹配
      if (name !== null && name.toLowerCase() === 'secret') {
        segments[i] = seg.slice(0, eq + 1) + MASK;
      }
    }
    return head.slice(0, qIdx + 1) + segments.join('&') + tail;
  }

  // ---------------- 主入口 ----------------
  function parse(text) {
    if (typeof text !== 'string') return null;
    var t = text.trim();
    if (!t || t.length > MAX_TEXT) return null;
    try {
      if (/^wifi:/i.test(t)) return parseWifi(t);
      if (/^otpauth:\/\//i.test(t)) return parseOtpauth(t);
      if (/^BEGIN:VCARD/i.test(t)) return parseVcard(t);
      if (/^tel:/i.test(t)) return parseTel(t);
      if (/^sms:/i.test(t) || /^smsto:/i.test(t)) return parseSms(t);
      if (/^mailto:/i.test(t)) return parseMailto(t);
      if (/^geo:/i.test(t)) return parseGeo(t);
    } catch (e) {
      return null; // 任何解析异常都回落纯文本卡片（防御性）
    }
    return null;
  }

  window.Parsers = {
    parse: parse,
    generateTotp: generateTotp,
    totpRemaining: totpRemaining,
    maskSecrets: maskSecrets,
  };
})();
