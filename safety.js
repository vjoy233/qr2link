/**
 * safety.js — QR2Link 链接安全预检（V1.2-PLAN PR-2，C2；纯本地启发式，零网络）
 *
 * 挂载全局命名空间 window.Safety：
 *   assessUrl(raw) → {level: 'ok'|'caution'|'danger', reasons: string[]}
 *
 * 规则枚举（数组序 = reasons 输出序；danger 类恒先于 caution 类，e2e G1 锁定排序）：
 *   danger idnHomograph  xn-- 标签 punycode 解码（内嵌 RFC 3492 解码器）后混排
 *                        拉丁/西里尔/希腊字母 ≥2 种文字（同形仿冒）；解码失败静默跳过
 *   danger userPass      URL 带 userinfo 登录信息（user[:pass]@，含仅用户名形态——覆盖
 *                        https://example.com@evil.com/ 类仿冒；PR #5 review 采纳的宽口径）
 *   caution httpPlain    http: 明文连接
 *   caution ipHost       IP 字面量主机（IPv4 / [IPv6] 含 IPv4-mapped、私网/回环段在内，
 *                        统一归单一原因「内网或本机地址」——外部 review P2 拍板，
 *                        不再按公网/私网细分文案）
 *   caution shortLink    已知短链域名（SHORTENER_DOMAINS，置于顶部便于维护）
 *
 * 边界（V1.2-PLAN）：
 *   - 畸形 URL 到不了本函数 —— popup 入口统一先过 parseHttpUrl；此处对解析失败
 *     仍防御性返回 {level:'ok', reasons:[]}，绝不抛错
 *   - Unicode 域名经 new URL 归一为 xn-- A-label，故混排检测对原文/编码两形态一致
 *   - 纯单码制 IDN（如纯汉字 xn--fiqs8s、纯西里尔仿冒词）不触发混排规则——
 *     检测「看起来像拉丁词」需要 confusables 表，超出本启发式范围（G2 锁定该边界）
 *
 * 注意（拍板③）：本模块仅被 popup.html 引入。background.js 的 openFirstLink 刻意
 *   不接入安全预检（快捷键直扫/右键识别维持 v1.1「照常打开」行为契约），见
 *   background.js 内防合并注释；e2e G6 断言 SW 中不存在 Safety 全局。
 */
(function () {
  'use strict';

  // 已知短链 / QR 短链域名（~15；host 精确匹配或任一层子域命中即算）
  var SHORTENER_DOMAINS = [
    'bit.ly', 'tinyurl.com', 'goo.gl', 'bit.do', 't.co', 'lnkd.in',
    'ow.ly', 'is.gd', 'v.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly',
    'tiny.cc', 'rb.gy', 'shorturl.at',
  ];

  // ---------------- RFC 3492 punycode 解码（单标签；失败返回 null，绝不抛错） ----------------
  function punycodeDecodeLabel(input) {
    var base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700, initialBias = 72, initialN = 128;

    function adapt(delta, numpoints, firsttime) {
      delta = firsttime ? Math.floor(delta / damp) : delta >> 1;
      delta += Math.floor(delta / numpoints);
      var k = 0;
      while (delta > ((base - tMin) * tMax) >> 1) {
        delta = Math.floor(delta / (base - tMin));
        k += base;
      }
      return k + Math.floor(((base - tMin + 1) * delta) / (delta + skew));
    }

    function decodeDigit(cp) {
      // '0'-'9' → 26-35；'A'-'Z' → 0-25；'a'-'z' → 0-25；其余非法
      return cp - 48 < 10 ? cp - 22 : cp - 65 < 26 ? cp - 65 : cp - 97 < 26 ? cp - 97 : base;
    }

    var output = [];
    // 最后一个 '-' 之前是 basic（ASCII）部分；'-' 在最前（basicEnd === 0）表示无 basic 部分
    var basicEnd = input.lastIndexOf('-');
    if (basicEnd > 0) {
      for (var b = 0; b < basicEnd; b++) {
        var bc = input.charCodeAt(b);
        if (bc >= 0x80) return null;
        output.push(input.charAt(b));
      }
    }
    var n = initialN, bias = initialBias, pos = 0;
    var i = basicEnd >= 0 ? basicEnd + 1 : 0;
    while (i < input.length) {
      var oldi = pos, w = 1;
      for (var k = base; ; k += base) {
        if (i >= input.length) return null; // 输入截断
        var digit = decodeDigit(input.charCodeAt(i));
        if (digit >= base) return null; // 非法字符
        i++;
        var t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
        pos += digit * w;
        if (pos > 0x7fffffff || !isFinite(pos)) return null; // 溢出防护（超长恶意标签）
        if (digit < t) break;
        w *= (base - t);
      }
      var outLen = output.length + 1;
      bias = adapt(pos - oldi, outLen, oldi === 0);
      n += Math.floor(pos / outLen);
      pos %= outLen;
      if (n < 0x80 || n > 0x10ffff) return null; // 解码值越界（含 ASCII，不可能合法出现在扩展段）
      if (n >= 0x10000) {
        // 代理对拆分（>BMP 字符）
        var v = n - 0x10000;
        output.splice(pos, 0, String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff)));
      } else {
        output.splice(pos, 0, String.fromCharCode(n));
      }
      pos++;
    }
    return output.join('');
  }

  // 混排检测：拉丁 / 西里尔 / 希腊三系中 ≥2 系同时出现（数字与标点三系共用，不计）
  function isMixedScript(s) {
    var latin = /[A-Za-z]/.test(s);
    var cyrillic = /[\u0400-\u04FF]/.test(s);
    var greek = /[\u0370-\u03FF]/.test(s);
    var scripts = (latin ? 1 : 0) + (cyrillic ? 1 : 0) + (greek ? 1 : 0);
    return scripts >= 2;
  }

  function hasHomographLabel(hostname) {
    var labels = hostname.split('.');
    for (var i = 0; i < labels.length; i++) {
      var label = labels[i];
      if (!/^xn--/i.test(label)) continue;
      var decoded = punycodeDecodeLabel(label.slice(4));
      if (decoded != null && isMixedScript(decoded)) return true;
    }
    return false;
  }

  function isIpLiteralHost(hostname) {
    // IPv6（URL 的 hostname 保留 '[…]' 括号形态；剥括号后含 ':' 即按 IPv6 处理，
    // 覆盖 ::1 / IPv4-mapped ::ffff:1.2.3.4 / 私网段 fe80:: 等）
    var bare = hostname.replace(/^\[|\]$/g, '');
    if (bare.indexOf(':') !== -1) return true;
    // IPv4 点分十进制形状（octet 数值不严格校验：'999.x' 形状本身即应提醒）
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname);
  }

  function isShortenerHost(hostname) {
    for (var i = 0; i < SHORTENER_DOMAINS.length; i++) {
      var d = SHORTENER_DOMAINS[i];
      if (hostname === d || hostname.endsWith('.' + d)) return true;
    }
    return false;
  }

  // ---------------- 主入口 ----------------
  // 规则数组序即 reasons 输出序：danger 类在前、caution 类在后（排序契约由数组保证）
  // userPass 为「任何 userinfo」宽口径（PR #5 review P2 采纳·保留实现原行为并同步方案/文案）：
  // 仅用户名形态同样危险——经典仿冒手法 https://example.com@evil.com/ 的真实主机是 evil.com，
  // 只判 user:pass@ 会放过该形态，故 username/password 任一非空即 danger
  var RULES = [
    { key: 'idnHomograph', level: 'danger', test: function (u) { return hasHomographLabel(u.hostname); } },
    { key: 'userPass', level: 'danger', test: function (u) { return u.username !== '' || u.password !== ''; } },
    { key: 'httpPlain', level: 'caution', test: function (u) { return u.protocol === 'http:'; } },
    { key: 'ipHost', level: 'caution', test: function (u) { return isIpLiteralHost(u.hostname); } },
    { key: 'shortLink', level: 'caution', test: function (u) { return isShortenerHost(u.hostname); } },
  ];

  function assessUrl(raw) {
    var u;
    try {
      u = new URL(String(raw));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return { level: 'ok', reasons: [] }; // 入口约定：非 http(s) 不评估
      }
    } catch (e) {
      return { level: 'ok', reasons: [] }; // 防御：畸形输入不抛错
    }
    var reasons = [];
    var danger = false;
    for (var i = 0; i < RULES.length; i++) {
      var hit = false;
      try {
        hit = RULES[i].test(u);
      } catch (e) { hit = false; } // 单条规则异常不影响整体评估
      if (hit) {
        reasons.push(RULES[i].key);
        if (RULES[i].level === 'danger') danger = true;
      }
    }
    return { level: danger ? 'danger' : (reasons.length ? 'caution' : 'ok'), reasons: reasons };
  }

  window.Safety = {
    assessUrl: assessUrl,
  };
})();
