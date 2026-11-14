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

  // 严格 Base32 解码（RFC 4648）：去空白/连字符 → 大写 → 字符与尾位合法性校验；
  // 非法字符 / 非法尾位组合返回 null
  function base32Decode(s) {
    var clean = String(s).replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-Z2-7]+=*$/.test(clean)) return null;
    var body = clean.replace(/=+$/, '');
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
    // 尾位合法性：规范的无填充长度（字符数 mod 8 ∈ {0,2,4,5,7}）解码后残位 ∈ 0–4；
    // 残位 >4 意味着本可再编一个字符的非规范长度（如 6 字符 → 残 6），拒绝
    if (bits > 4) return null;
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
    // label 形如 'issuer:account'（issuer 可选）
    var colon = label.indexOf(':');
    var issuer = colon >= 0 ? label.slice(0, colon) : '';
    var account = colon >= 0 ? label.slice(colon + 1) : label;
    var q = u.searchParams;
    var secretRaw = q.get('secret');
    if (secretRaw == null || !String(secretRaw).length) return null;
    var secret = String(secretRaw).replace(/[\s-]/g, '').toUpperCase(); // 大小写/空白宽容归一
    var secretBytes = base32Decode(secret);
    if (!secretBytes || !secretBytes.length || secretBytes.length > 128) return null;
    var algorithm = normalizeAlgorithm(q.get('algorithm'));
    if (!algorithm) return null;
    var digits = parseIntParam(q.get('digits'), 6, 6, 8);
    if (digits == null) return null;
    if (type === 'totp') {
      var period = parseIntParam(q.get('period'), 30, 2, 3600);
      if (period == null) return null;
      return {
        kind: 'totp', issuer: issuer, account: account, secret: secret,
        digits: digits, period: period, algorithm: algorithm,
      };
    }
    var counter = parseIntParam(q.get('counter'), 0, 0, Number.MAX_SAFE_INTEGER);
    if (counter == null) return null;
    return {
      kind: 'hotp', issuer: issuer, account: account, secret: secret,
      digits: digits, counter: counter, algorithm: algorithm,
    };
  }

  // RFC 6238 动态码（拍板①）：WebCrypto HMAC + 动态截断；atMs 缺省取当前时间。
  // secretB32 为 Base32 密钥；opts 与 parse 输出字段同构
  function generateTotp(secretB32, opts, atMs) {
    opts = opts || {};
    var digits = opts.digits || 6;
    var period = opts.period || 30;
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

  function totpRemaining(period, atMs) {
    period = period || 30;
    var sec = Math.floor((atMs == null ? Date.now() : atMs) / 1000);
    return period - (sec % period);
  }

  // ---------------- vCard（BEGIN:VCARD … END:VCARD） ----------------
  function vcardUnescape(v) {
    // vCard 3.0 转义：\\ \; \, \n（\n / \N 为换行）
    return v.replace(/\\[nN]/g, '\n').replace(/\\(.)/g, '$1');
  }

  function parseVcard(text) {
    if (!/^BEGIN:VCARD\r?\n/i.test(text)) return null;
    if (!/END:VCARD/i.test(text)) return null;
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
    var fn = '', org = '', title = '';
    var tels = [], emails = [];
    for (var k = 0; k < lines.length; k++) {
      var line = lines[k];
      if (!line) continue;
      var c = line.indexOf(':');
      if (c <= 0) continue; // 畸形行跳过（VERSION 等无值行亦如此处理）
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
  function checkTelNumber(num) {
    return /^[+0-9\-().\s]{1,64}$/.test(num) && /[0-9+]/.test(num);
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
        if (q >= 0) body = new URLSearchParams(rest.slice(q + 1)).get('body');
      }
    } else {
      number = safeDecode((q >= 0 ? rest.slice(0, q) : rest).trim());
      if (q >= 0) body = new URLSearchParams(rest.slice(q + 1)).get('body');
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
      subject = sp.get('subject');
      body = sp.get('body');
    }
    if (subject != null && subject.length > URI_MAX_VALUE) return null;
    if (body != null && body.length > URI_MAX_VALUE) return null;
    return { kind: 'mailto', to: to, subject: subject || null, body: body || null };
  }

  function parseGeo(text) {
    var rest = text.slice(4).split(';')[0]; // 剥离 ;crs=… 等参数
    var parts = rest.split(',');
    if (parts.length < 2) return null;
    var lat = parts[0].trim(), lon = parts[1].trim();
    if (!/^-?\d+(\.\d+)?$/.test(lat) || !/^-?\d+(\.\d+)?$/.test(lon)) return null;
    var la = parseFloat(lat), lo = parseFloat(lon);
    if (la < -90 || la > 90 || lo < -180 || lo > 180) return null;
    return { kind: 'geo', lat: la, lon: lo };
  }

  // ---------------- 显示层打码（存储 / 复制保持原文） ----------------
  var MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'; // •×8

  function maskSecrets(text) {
    if (typeof text !== 'string' || !/^otpauth:\/\//i.test(text)) return text;
    return text.replace(/([?&]secret=)[^&]*/i, '$1' + MASK);
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
