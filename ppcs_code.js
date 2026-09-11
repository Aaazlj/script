/*
Author: anonymous
Date: 2026.08.21
Adapted: YYB-Go-Enhanced edition
Description: 朴朴超市签到code本（YYB-Go-Enhanced 适配版）
Cron: 20 8,12,20 * * *
----------------------------------------------------------------------------------------------
朴朴超市签到 code 本 v1.2.0 (YYB-Go-Enhanced 适配版)

功能：自动执行朴朴超市小程序每日签到和互相助力任务，支持多账号执行。
登录 code 通过 YYB-Go-Enhanced 的 /wxapp/getCode 获取，无需手动填 ck。

本次完善（对齐 yyb_go 真实接口）：
  1. 修正 getCode 响应解析：网关统一返回信封 {code,msg,data}，数据在 data.result.code
  2. 识别网关 HTTP 语义：400 参数缺失 / 404 账号不存在 / 409 登录态过期 / 502 调用失败
  3. 409 自动调用 /accounts/refresh 续期后重试一次
  4. 502 / 网络错误自动重试，避免网关首次登录握手耗时被误判为失败
  5. 支持只填网关地址（不带 @）自动拉取 /accounts 全部账号
  6. 账号备注名取自网关 nickname/alias，日志带 [账号n/m] 前缀
  7. 开跑前 /health 探活，网关挂掉直接跳过，不再每个账号干等超时
  8. got 缺失时自动降级到 Node 内置 http/https，青龙裸环境也能跑

配置说明：
1. 微信 code 网关（YYB-Go-Enhanced）：
   yyb_server                                      必填，网关地址（支持多条）
   - 多条之间用 &、英文逗号、中文逗号或换行分隔
   - 写法一：{网关地址}@{账号ref}      指定单个账号，ref 可为 账号ID / UIN / OpenID
             示例：http://127.0.0.1:8000@1
                   http://192.168.1.10:8000@owNAxxx...xxx
   - 写法二：{网关地址}                不带 @，自动拉取该网关 /accounts 里的全部账号
             示例：http://127.0.0.1:8000
   - 写法三：{网关地址}@*              等价写法二
   - 地址可以不带协议头，缺协议时自动补 http://（如 yyb-go:8000@1）

2. 兼容旧版变量（yyb_server 为空时生效）：
   wx_server_url                                   网关地址
   ppcs_openid                                     账号ref，多个用 & 或逗号分隔

3. 可选变量：
   ppcs_appid           小程序 appid，默认 wx122ef876a7132eb4
   ppcs_lng / ppcs_lat  定位经纬度前缀，默认福州 119.31 / 26.06
   yyb_auto_refresh     默认 1。账号状态非 alive 时自动 /accounts/refresh 续期
   yyb_skip_expired     默认 1。续期后仍为 expired 的账号直接跳过
   ppcs_version_check   默认 0。设为 1 时启用远端版本检查（联网慢的环境别开）

4. 账号 ref 说明：
   - 纯数字先按 UIN 匹配，匹配不到再按 账号ID 匹配；非数字按 OpenID 匹配
   - OpenID 删除重扫后不变，长期使用更推荐
   - 每个账号需要提前在 YYB-Go-Enhanced 控制台扫码添加

5. 青龙任务建议：
   名称：朴朴超市签到
   命令：task ppcs_code.js
   定时：每天运行 1 - 3 次即可，具体时间自行调整
----------------------------------------------------------------------------------------------
*/

// ==================== 常量定义 ====================
const CommonUtils = createCommonUtils("朴朴超市");
const PROJECT_NAME = "pupu";
const REQUEST_TIMEOUT = 20000;
const GATEWAY_TIMEOUT = 60000;   // getCode 首次调用会触发登录握手，超时给宽一点
const MAX_RETRY_COUNT = 3;
const SCRIPT_VERSION = 1.02;
const SCRIPT_KEY = "pupu";
const VERSION_CHECK_URL = "https://leafxcy.coding.net/api/user/leafxcy/project/validcode/shared-depot/validCode/git/blob/master/code.json";
const USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_1_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.46(0x18002e2c) NetType/WIFI Language/zh_CN miniProgram/wx122ef876a7132eb4";
const RETRY_WAIT_TIME = 2000;
const MAX_VERSION_CHECK_RETRY = 5;

// ==================== YYB-Go-Enhanced 网关登录常量 ====================
// PPCS_APPID: 朴朴超市小程序 appid（登录 code 由 YYB-Go-Enhanced 网关换取）
const PPCS_APPID = process.env.ppcs_appid || process.env.PPCS_APPID || "wx122ef876a7132eb4";
// 方式一：YYB_SERVER 面板环境变量，每行 {网关地址}@{账号ref} 或 {网关地址}
const YYB_SERVER = process.env.YYB_SERVER || process.env.yyb_server || "";
// 方式二（兼容旧版）：wx_server_url + ppcs_openid
const WX_SERVER_URL = process.env.wx_server_url || process.env.WX_SERVER_URL || "";
const PPCS_OPENID = process.env.ppcs_openid || process.env.PPCS_OPENID || "";

// 可选开关
const AUTO_REFRESH = (process.env.yyb_auto_refresh ?? "1") !== "0";
const SKIP_EXPIRED = (process.env.yyb_skip_expired ?? "1") !== "0";
const ENABLE_VERSION_CHECK = (process.env.ppcs_version_check ?? "0") === "1";
// 定位（默认福州，可自行改成常驻城市）
const PPCS_LNG = process.env.ppcs_lng || process.env.PPCS_LNG || "119.31";
const PPCS_LAT = process.env.ppcs_lat || process.env.PPCS_LAT || "26.06";

// getCode 重试次数（仅针对 502 / 网络错误）
const GETCODE_MAX_RETRY = 2;

// 网关 HTTP 状态码 → 人话提示（见 internal/httpapi/app.go）
const GATEWAY_ERROR_HINT = {
  400: "请求参数缺失（ref / app_id 没传）",
  404: "网关里找不到该账号，检查 ref 是否正确",
  409: "账号登录态过期，需要重新扫码或刷新",
  502: "网关调用微信失败（可重试）"
};

const PPCS_VERSION = "2026081723";
const PPCS_REFERER = `https://servicewechat.com/${PPCS_APPID}/797/page-frame.html`;
const PPCS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 "
  + "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI "
  + "MiniProgramEnv/Windows WindowsWechat/WMPF "
  + "WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541c37) XWEB/25364";

// ==================== HTTP 客户端 ====================
// 优先 got；青龙裸环境没有 got 时降级到 Node 内置 http/https
let got = null;
try {
  got = require("got");
} catch (e) {
  got = null;
}

// 降级实现：覆盖脚本用到的 request 选项子集
function nodeRequest(options) {
  return new Promise(resolve => {
    try {
      const http = require("http");
      const https = require("https");
      const method = (options.method || "GET").toUpperCase();
      const target = new URL(options.url);
      const lib = target.protocol === "https:" ? https : http;

      if (options.searchParams) {
        for (let key in options.searchParams) {
          target.searchParams.append(key, options.searchParams[key]);
        }
      }

      let body = "";
      if (options.json !== undefined && options.json !== null) {
        body = JSON.stringify(options.json);
      } else if (options.form !== undefined && options.form !== null) {
        body = new URLSearchParams(options.form).toString();
      } else if (options.body !== undefined && options.body !== null) {
        body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      }

      const headers = Object.assign({}, options.headers || {});
      if (body) {
        if (!headers["Content-Type"] && !headers["content-type"]) {
          headers["Content-Type"] = options.form ? "application/x-www-form-urlencoded" : "application/json";
        }
        headers["Content-Length"] = Buffer.byteLength(body);
      }

      const timeout = Number(options?.timeout?.request || options?.timeout || REQUEST_TIMEOUT);
      const req = lib.request(target, { method, headers, timeout }, res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => {
          let text = Buffer.concat(chunks).toString("utf-8");
          let result = text;
          if (options.decode_json !== false) {
            try {
              result = JSON.parse(text);
            } catch (e) {
              result = text;
            }
          }
          resolve({ statusCode: res.statusCode, headers: res.headers, result });
        });
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", () => resolve({ statusCode: -1, headers: null, result: null }));
      if (body) req.write(body);
      req.end();
    } catch (e) {
      resolve({ statusCode: -1, headers: null, result: null });
    }
  });
}

// ==================== 基础请求类 ====================
class BaseRequest {
  constructor(skipIndex = false) {
    this.index = skipIndex ? -1 : CommonUtils.userIdx++;
    this.name = "";
    this.valid = false;

    // 默认请求配置
    this.defaultHeaders = { "Connection": "keep-alive" };

    // 兼容不同版本的got
    if (got && typeof got.extend === 'function') {
      // 旧版got (v11及以下)
      const requestConfig = {
        retry: { limit: 0 },
        timeout: REQUEST_TIMEOUT,
        followRedirect: false,
        headers: this.defaultHeaders
      };
      this.got = got.extend(requestConfig);
      this.isOldGot = true;
    } else {
      // 新版got (v12+) 或无 got（走降级实现）
      this.got = got;
      this.isOldGot = false;
    }
  }

  // 获取日志前缀
  get_prefix(options = {}) {
    if (this.index < 0 || !CommonUtils.userCount) return "";
    let width = CommonUtils.userCount.toString().length;
    let prefix = "账号[" + CommonUtils.padStr(this.index + 1, width) + "/" + CommonUtils.userCount + "]";
    return "[" + prefix + "]";
  }

  // 日志输出
  log(message, options = {}) {
    let prefix = this.get_prefix();
    CommonUtils.log(prefix + message, options);
  }

  // 扩展got配置（兼容不同版本）
  extendGot(newConfig) {
    if (this.isOldGot) {
      this.got = this.got.extend(newConfig);
    } else {
      // 新版本got，合并headers
      if (newConfig.headers) {
        Object.assign(this.defaultHeaders, newConfig.headers);
      }
    }
  }

  // 通用请求方法
  async request(requestOptions) {
    // 无 got：走 Node 内置实现 + 简单重试
    if (!got) {
      let options = CommonUtils.copy(requestOptions);
      options.method = options?.method?.toUpperCase() || "GET";
      let last = { statusCode: -1, headers: null, result: null };
      for (let i = 0; i < MAX_RETRY_COUNT; i++) {
        if (i > 0) await CommonUtils.wait(RETRY_WAIT_TIME * i);
        options.timeout = Number(options?.timeout?.request || options?.timeout || REQUEST_TIMEOUT);
        last = await nodeRequest(options);
        if (last.statusCode > 0) break;
        this.log("⚠️ [" + (options.fn || options.url) + "]请求失败，重试第" + (i + 1) + "次");
      }
      if (options.debug_out) console.log(last);
      return last;
    }

    const REQUEST_ERROR_TYPES = ["RequestError"];
    const TIMEOUT_ERROR_TYPES = ["TimeoutError"];

    let options = CommonUtils.copy(requestOptions);
    let response = {};

    try {
      let result = null;
      let retryCount = 0;
      let functionName = options.fn || options.url;
      let validStatusCodes = options.valid_code || [200];

      // 处理form数据
      if (options.form) {
        for (let key in options.form) {
          if (typeof options.form[key] === "object") {
            options.form[key] = JSON.stringify(options.form[key]);
          }
        }
      }

      options.method = options?.method?.toUpperCase() || "GET";

      // 处理查询参数
      if (options.searchParams) {
        for (let key in options.searchParams) {
          if (typeof options.searchParams[key] === "object") {
            options.searchParams[key] = JSON.stringify(options.searchParams[key]);
          }
        }
      }

      if (options.debug_in) {
        console.log(options);
      }

      // 重试逻辑
      while (retryCount < MAX_RETRY_COUNT) {
        if (retryCount > 0) {
          await CommonUtils.wait(RETRY_WAIT_TIME * retryCount);

          let retryer = CommonUtils.get(options, "retryer", null);
          if (retryer) {
            let retryerOptions = CommonUtils.get(options, "retryer_opt", {});
            await retryer(options, retryerOptions);
          }
        }

        retryCount++;
        let error = null;

        try {
          let timeout = Number(options?.timeout?.request || options?.timeout || REQUEST_TIMEOUT);
          let isTimeout = false;
          let startTime = Date.now();

          // 构建请求Promise
          let requestPromise;
          if (this.isOldGot) {
            // 旧版got
            let gotClient = options.got_client || this.got;
            requestPromise = gotClient(options);
          } else {
            // 新版got - 需要构建完整的请求选项
            const method = (options.method || 'GET').toLowerCase();
            const requestUrl = options.url;
            const requestOpts = {
              method: options.method,
              headers: Object.assign({}, this.defaultHeaders, options.headers || {}),
              timeout: { request: timeout },
              retry: { limit: 0 },
              followRedirect: options.followRedirect !== undefined ? options.followRedirect : false,
              throwHttpErrors: false
            };

            // 添加请求体
            if (options.json) {
              requestOpts.json = options.json;
            }
            if (options.form) {
              requestOpts.form = options.form;
            }
            if (options.body) {
              requestOpts.body = options.body;
            }
            if (options.searchParams) {
              requestOpts.searchParams = options.searchParams;
            }

            // 新版got使用方法调用
            let gotInstance = this.got;

            // 处理ES6模块的default导出
            if (gotInstance.default && typeof gotInstance.default === 'function') {
              gotInstance = gotInstance.default;
            }

            if (typeof gotInstance === 'function') {
              // got本身是函数（某些版本）
              requestPromise = gotInstance(requestUrl, requestOpts);
            } else if (typeof gotInstance[method] === 'function') {
              // got有对应的方法（get, post, put等）
              requestPromise = gotInstance[method](requestUrl, requestOpts);
            } else {
              console.error('Got debug info:', {
                typeofGot: typeof this.got,
                typeofGotInstance: typeof gotInstance,
                hasMethod: !!gotInstance[method],
                method: method,
                availableMethods: Object.keys(gotInstance).filter(k => typeof gotInstance[k] === 'function')
              });
              throw new Error('Unsupported got version - method: ' + method);
            }
          }

          let timeoutHandle = setTimeout(() => {
            isTimeout = true;
            if (requestPromise.cancel) {
              requestPromise.cancel();
            }
          }, timeout);

          await requestPromise.then(
            successResponse => { result = successResponse; },
            errorResponse => {
              error = errorResponse;
              result = errorResponse.response;
            }
          ).catch(err => {
            // 捕获取消或其他错误
            error = err;
            result = err.response;
          }).finally(() => clearTimeout(timeoutHandle));

          let endTime = Date.now();
          let duration = endTime - startTime;
          let statusCode = result?.statusCode || null;

          if (isTimeout || TIMEOUT_ERROR_TYPES.includes(error?.name)) {
            let errorInfo = "";
            if (error?.code) {
              errorInfo += "(" + error.code;
              if (error?.event) {
                errorInfo += ":" + error.event;
              }
              errorInfo += ")";
            }
            this.log("⏳ [" + functionName + "]请求超时" + errorInfo + "(" + duration + "ms)，重试第" + retryCount + "次");
          } else if (REQUEST_ERROR_TYPES.includes(error?.name)) {
            this.log("⚠️ [" + functionName + "]请求错误(" + error.code + ")(" + duration + "ms)，重试第" + retryCount + "次");
          } else {
            if (statusCode) {
              if (error && !validStatusCodes.includes(statusCode)) {
                this.log("⚠️ 请求[" + functionName + "]返回[" + statusCode + "]");
              }
            } else {
              let { code = "unknown", name = "unknown" } = error || {};
              this.log("⚠️ 请求[" + functionName + "]错误[" + code + "][" + name + "]");
            }
            break;
          }
        } catch (exception) {
          this.log("⚠️ [" + functionName + "]请求错误(" + exception.message + ")，重试第" + retryCount + "次");
        }
      }

      if (result === null || result === undefined) {
        return { statusCode: -1, headers: null, result: null };
      }

      let { statusCode, headers, body } = result;
      let shouldDecodeJson = CommonUtils.get(options, "decode_json", true);

      if (body && shouldDecodeJson) {
        try {
          body = JSON.parse(body);
        } catch {}
      }

      response = { statusCode, headers, result: body };

      if (options.debug_out) {
        console.log(response);
      }
    } catch (exception) {
      console.log(exception);
    } finally {
      return response;
    }
  }
}

// ==================== 全局请求实例 ====================
let globalRequest = new BaseRequest(true);

// ==================== 网关辅助函数 ====================
// 归一化 YYB 网关地址：缺失协议时自动补 http://
// （兼容官方 YYB_SERVER=yyb-go:8000@1 这类不带协议头的面板写法）
function normalizeServerUrl(url) {
  let u = (url || "").trim().replace(/\/+$/, "");
  if (u && !/^https?:\/\//i.test(u)) {
    u = "http://" + u;
  }
  return u;
}

// 解析网关统一信封：成功 {code:0,msg:"success",data:...}，失败 {code:<httpStatus>,msg,data:null}
function parseGatewayEnvelope(res) {
  let body = res?.result;
  let status = res?.statusCode;
  if (body && typeof body === "object" && !Array.isArray(body)
      && Object.prototype.hasOwnProperty.call(body, "code")
      && Object.prototype.hasOwnProperty.call(body, "msg")) {
    return { status, code: body.code, msg: body.msg, data: body.data };
  }
  // 非信封格式（第三方/旧式网关）兜底
  return { status, code: status === 200 ? 0 : (status || -1), msg: "", data: body };
}

// 网关错误人话提示
function gatewayErrorText(env) {
  let hint = GATEWAY_ERROR_HINT[env.status] || GATEWAY_ERROR_HINT[env.code] || "";
  let msg = env.msg || (env.data && env.data.msg) || "";
  return "[" + (env.status ?? env.code) + "]" + (msg ? msg : "未知错误") + (hint ? " —— " + hint : "");
}

// 网关探活
const healthCache = {};
async function checkGatewayHealth(serverUrl) {
  if (healthCache[serverUrl] !== undefined) return healthCache[serverUrl];
  let res = await globalRequest.request({
    fn: "health",
    method: "get",
    url: serverUrl + "/health",
    timeout: 8000
  });
  let env = parseGatewayEnvelope(res);
  let ok = env.status === 200 && env.code === 0 && (!env.data || env.data.ok !== false);
  healthCache[serverUrl] = ok;
  return ok;
}

// 拉取网关全部账号：GET /accounts
async function fetchGatewayAccounts(serverUrl) {
  let res = await globalRequest.request({
    fn: "accounts",
    method: "get",
    url: serverUrl + "/accounts",
    timeout: 15000
  });
  let env = parseGatewayEnvelope(res);
  if (env.code !== 0 || !Array.isArray(env.data)) {
    CommonUtils.log("❌ 拉取网关账号列表失败 " + serverUrl + " : " + gatewayErrorText(env));
    return [];
  }
  return env.data;
}

// 刷新账号登录态：POST /accounts/refresh {ref}
async function refreshGatewayAccount(serverUrl, ref) {
  let res = await globalRequest.request({
    fn: "accounts_refresh",
    method: "post",
    url: serverUrl + "/accounts/refresh",
    json: { ref: String(ref) },
    timeout: GATEWAY_TIMEOUT
  });
  let env = parseGatewayEnvelope(res);
  if (env.code === 0 && env.data && env.data.status) {
    return env.data.status;
  }
  // 未传 ref 时返回数组，这里用不到
  return "unknown";
}

// ==================== 网关登录 ====================
// 通过 YYB 网关 /wxapp/getCode → 朴朴 silent_login 获取新 token
// 网关 getCode 返回：HTTP 200 => { code:0, msg:"success", data:{ openid, result:{ code, errMsg } } }
//                    HTTP 4xx/5xx => { code:<status>, msg:"<detail>", data:null }
async function silentLoginViaGateway(ref, logFn, index, wxServerUrl) {
  let log = logFn || CommonUtils.log;
  let serverUrl = normalizeServerUrl(wxServerUrl || WX_SERVER_URL);
  if (!serverUrl) {
    log("缺少 YYB 网关地址（yyb_server 或 wx_server_url 未配置），无法通过网关登录");
    return null;
  }
  if (!ref) {
    log("缺少账号标识（ref 为空），无法通过网关登录");
    return null;
  }

  // Step 1: getCode（502 / 网络错误重试，409 先续期再重试）
  let codeRes = null;
  let env = null;
  let refreshed = false;

  for (let attempt = 0; attempt <= GETCODE_MAX_RETRY; attempt++) {
    if (attempt > 0) await CommonUtils.wait(RETRY_WAIT_TIME * attempt);

    codeRes = await globalRequest.request({
      fn: "getCode",
      method: "post",
      url: serverUrl + "/wxapp/getCode",
      json: { app_id: PPCS_APPID, ref: String(ref) },
      timeout: GATEWAY_TIMEOUT
    });

    env = parseGatewayEnvelope(codeRes);

    if (env.code === 0) break;

    // 409：登录态过期 → 自动续期后重试一次
    if (env.status === 409 && AUTO_REFRESH && !refreshed) {
      refreshed = true;
      log("♻️ 账号登录态过期，尝试自动续期 /accounts/refresh");
      let status = await refreshGatewayAccount(serverUrl, ref);
      log("♻️ 续期结果: " + status);
      if (status === "alive") {
        attempt = -1; // 重置重试计数，重新走 getCode
        continue;
      }
      log("❌ 续期失败，请到网关控制台重新扫码");
      return null;
    }

    // 502 / 网络错误：重试
    if (env.status === 502 || env.status === -1 || env.status === null || env.status === undefined) {
      if (attempt < GETCODE_MAX_RETRY) {
        log("⚠️ getCode 调用失败，重试第" + (attempt + 1) + "次");
        continue;
      }
    }

    // 400 / 404 等：无需重试
    log("❌ getCode 失败: " + gatewayErrorText(env));
    return null;
  }

  if (!env || env.code !== 0) {
    log("❌ getCode 失败: " + gatewayErrorText(env || {}));
    return null;
  }

  // 解析 code：优先 data.result.code，兼容 data 直接是 {code, errMsg}
  let data = env.data || {};
  let wxCode = "";
  if (data.result && typeof data.result.code === "string" && data.result.code) {
    wxCode = data.result.code;
  } else if (typeof data.code === "string" && data.code) {
    wxCode = data.code;
  }

  if (!wxCode) {
    log("❌ getCode 未返回 code: " + JSON.stringify(data));
    return null;
  }

  log("🔑 获取code成功：code=" + wxCode.substring(0, 20) + "...");

  // Step 2: silent_login
  let loginRes = await globalRequest.request({
    fn: "silent_login",
    method: "post",
    url: "https://cauth.pupuapi.com/clientauth/user/society/miniapp/silent_login",
    headers: {
      "User-Agent": PPCS_UA,
      "Accept": "application/json",
      "Content-Type": "application/json",
      "pp-version": PPCS_VERSION,
      "pp-os": "0",
      "Referer": PPCS_REFERER
    },
    json: { code: wxCode }
  });

  let loginData = loginRes?.result;
  if (!loginData || loginData.errcode !== 0) {
    log("❌ silent_login 失败: " + JSON.stringify(loginData));
    return null;
  }

  let d = loginData.data;
  log("✅ 登录成功  token=" + (d.token || "").substring(0, 16) + "...");
  log("👤 用户: " + (d.nick_name || "未知"));
  return d;
}

// ==================== 朴朴用户类 ====================
class PupuUser extends BaseRequest {
  constructor(cookieString, ref, wxServerUrl, remark) {
    super();

    let parts = (cookieString || "").split("#");
    this.refresh_token = parts[0] || "";
    this.remark = remark || parts?.[1] || "";
    this.ref = ref || "";
    this.wxServerUrl = wxServerUrl || "";
    this.open_id = "";
    this.suid = "";
    this.team_id = "";
    this.team_need_help = false;
    this.team_can_help = true;
    this.team_max_help = 0;
    this.team_helped_count = 0;

    this.extendGot({
      headers: { "User-Agent": USER_AGENT }
    });
  }

  // 登录（直接走网关 silent_login）
  async user_refresh_token(options = {}) {
    return await this.silent_login();
  }

  // 网关 silent_login（getCode → silent_login → 设置 token/refresh_token/open_id/suid）
  async silent_login() {
    let success = false;

    try {
      if (this.remark) {
        this.log(">>> 开始处理：" + this.remark + "（ref=" + this.ref + "）");
      }
      let d = await silentLoginViaGateway(this.ref, (msg) => this.log(msg), this.index, this.wxServerUrl);
      if (!d) {
        return false;
      }

      this.valid = true;
      this.access_token = d.token;
      this.refresh_token = d.refresh_token;
      this.open_id = d.open_id || "";
      this.suid = d.suid || "";
      this.user_id = d.user_id;
      this.name = this.remark || d.nick_name || "";

      this.extendGot({
        headers: {
          "User-Agent": PPCS_UA,
          "pp-version": PPCS_VERSION,
          "pp-os": "0",
          "Referer": PPCS_REFERER,
          "Authorization": "Bearer " + d.token,
          "pp-userid": String(d.user_id),
          "open-id": d.open_id || "",
          "pp-suid": d.suid || ""
        }
      });

      success = true;
      await this.user_info();
    } catch (exception) {
      this.log("❌ 登录异常: " + exception.message);
    } finally {
      return success;
    }
  }

  // 获取用户信息
  async user_info(options = {}) {
    try {
      const requestConfig = {
        fn: "user_info",
        method: "get",
        url: "https://cauth.pupuapi.com/clientauth/user/info"
      };

      let { result, statusCode } = await this.request(requestConfig);
      let errorCode = CommonUtils.get(result, "errcode", statusCode);

      if (errorCode === 0) {
        let { phone, invite_code } = result?.data;
        this.phone = phone;
        this.name = this.remark || this.name || phone || "";
        this.invite_code = invite_code;
      } else {
        let errorMessage = CommonUtils.get(result, "errmsg", "");
        this.log("❌ 查询用户信息失败[" + errorCode + "]: " + errorMessage);
      }
    } catch (exception) {
      console.log(exception);
    }
  }

  // 根据城市选择附近位置
  async near_location_by_city(options = {}) {
    try {
      let requestConfig = {
        fn: "near_location_by_city",
        method: "get",
        url: "https://j1.pupuapi.com/client/store/place/near_location_by_city/v2",
        searchParams: {
          lng: PPCS_LNG + CommonUtils.randomString(4, CommonUtils.ALL_DIGIT),
          lat: PPCS_LAT + CommonUtils.randomString(4, CommonUtils.ALL_DIGIT)
        }
      };

      let { result, statusCode } = await this.request(requestConfig);
      let errorCode = CommonUtils.get(result, "errcode", statusCode);

      if (errorCode === 0) {
        let locationList = result?.data;
        this.location = CommonUtils.randomList(locationList);

        let { service_store_id, city_zip, lng_x, lat_y } = this.location;
        this.store_id = service_store_id;
        this.zip = city_zip;
        this.lng = lng_x;
        this.lat = lat_y;

        this.extendGot({
          headers: {
            "pp_storeid": service_store_id,
            "pp-cityzip": city_zip
          }
        });
      } else {
        let errorMessage = CommonUtils.get(result, "errmsg", "");
        this.log("❌ 选取随机地点失败[" + errorCode + "]: " + errorMessage);
      }
    } catch (exception) {
      console.log(exception);
    }
  }

  // 查询签到状态
  async sign_index(options = {}) {
    try {
      const requestConfig = {
        fn: "sign_index",
        method: "get",
        url: "https://j1.pupuapi.com/client/game/sign/v2/index"
      };

      let { result, statusCode } = await this.request(requestConfig);
      let errorCode = CommonUtils.get(result, "errcode", statusCode);

      if (errorCode === 0) {
        let { is_signed } = result?.data;

        if (is_signed) {
          this.log("📅 [每日签到] 今天已签到");
        } else {
          await this.do_sign();
        }
      } else {
        let errorMessage = CommonUtils.get(result, "errmsg", "");
        this.log("📅 [每日签到] 查询签到信息失败[" + errorCode + "]: " + errorMessage);
      }
    } catch (exception) {
      console.log(exception);
    }
  }

  // 执行签到
  async do_sign(options = {}) {
    try {
      const requestConfig = {
        fn: "do_sign",
        method: "post",
        url: "https://j1.pupuapi.com/client/game/sign/v2",
        searchParams: { supplement_id: "" }
      };

      let { result, statusCode } = await this.request(requestConfig);
      let errorCode = CommonUtils.get(result, "errcode", statusCode);

      if (errorCode === 0) {
        let { daily_sign_coin, coupon_list = [] } = result?.data;
        let rewards = [];

        rewards.push(daily_sign_coin + "积分");

        for (let coupon of coupon_list) {
          let conditionAmount = (coupon.condition_amount / 100).toFixed(2);
          let discountAmount = (coupon.discount_amount / 100).toFixed(2);
          rewards.push("满" + conditionAmount + "减" + discountAmount + "券");
        }

        this.log("📅 [每日签到] 签到成功: " + rewards.join(", "));
      } else {
        let errorMessage = CommonUtils.get(result, "errmsg", "");
        this.log("📅 [每日签到] 签到失败[" + errorCode + "]: " + errorMessage);
      }
    } catch (exception) {
      console.log(exception);
    }
  }

  // 获取组队码(2026-08 接口升级为 v3, 返回 data.team_id)
  async get_team_code(options = {}) {
    try {
      const requestConfig = {
        fn: "get_team_code",
        method: "post",
        url: "https://j1.pupuapi.com/client/game/coin_share/team/v3",
        json: {}
      };

      let { result, statusCode } = await this.request(requestConfig);
      let errorCode = CommonUtils.get(result, "errcode", statusCode);

      if (errorCode === 0) {
        let data = result?.data;
        // 兼容: 新版返回 {success, team_id}, 老版直接返回队伍码字符串
        this.team_id = (typeof data === "object" && data !== null) ? (data.team_id || "") : (data || "");

        if (!this.team_id) {
          this.log("🤝 [组队状态] 获取组队码失败: 未返回team_id: " + JSON.stringify(data));
          return;
        }

        await this.check_my_team();
      } else {
        let errorMessage = CommonUtils.get(result, "errmsg", "");
        this.log("🤝 [组队状态] 获取组队码失败[" + errorCode + "]: " + errorMessage);
      }
    } catch (exception) {
      console.log(exception);
    }
  }

  // 检查我的队伍
  async check_my_team(options = {}) {
    try {
      const requestConfig = {
        fn: "check_my_team",
        method: "get",
        url: "https://j1.pupuapi.com/client/game/coin_share/teams/" + this.team_id
      };

      let { result, statusCode } = await this.request(requestConfig);
      let errorCode = CommonUtils.get(result, "errcode", statusCode);

      if (errorCode === 0) {
        let { status, target_team_member_num, current_team_member_num, current_user_reward_coin } = result?.data;

        switch (status) {
          case 10: // 组队中
            this.team_need_help = true;
            this.team_max_help = target_team_member_num;
            this.team_helped_count = current_team_member_num;
            this.log("🤝 [组队状态] 组队中: " + current_team_member_num + "/" + target_team_member_num);
            break;
          case 30: // 组队完成
            this.log("🤝 [组队状态] 组队完成, 获得" + current_user_reward_coin + "积分");
            break;
          default:
            this.log("🤝 [组队状态] 状态[" + status + "]");
            this.log("🤝 [组队状态] " + JSON.stringify(result?.data));
        }
      } else {
        let errorMessage = CommonUtils.get(result, "errmsg", "");
        this.log("🤝 [组队状态] 查询组队信息失败[" + errorCode + "]: " + errorMessage);
      }
    } catch (exception) {
      console.log(exception);
    }
  }

  // 加入队伍
  async join_team(targetUser, options = {}) {
    try {
      const requestConfig = {
        fn: "join_team",
        method: "post",
        url: "https://j1.pupuapi.com/client/game/coin_share/teams/" + targetUser.team_id + "/join"
      };

      let { result, statusCode } = await this.request(requestConfig);
      let errorCode = CommonUtils.get(result, "errcode", statusCode);

      if (errorCode === 0) {
        this.team_can_help = false;
        targetUser.team_helped_count += 1;

        let userCountLength = CommonUtils.userCount.toString().length;
        let targetPrefix = "账号[" + CommonUtils.padStr(targetUser.index + 1, userCountLength) + "]";

        if (targetUser.name) {
          targetPrefix += "[" + targetUser.name + "]";
        }

        this.log("👥 [组队瓜分朴分活动] 加入" + targetPrefix + "队伍: " + targetUser.team_helped_count + "/" + targetUser.team_max_help);

        if (targetUser.team_helped_count >= targetUser.team_max_help) {
          targetUser.team_need_help = false;
          targetUser.log("👥 [组队瓜分朴分活动] 组队已满");
        }
      } else {
        let errorMessage = CommonUtils.get(result, "errmsg", "");

        let userCountLength = CommonUtils.userCount.toString().length;
        let targetPrefix = "账号[" + CommonUtils.padStr(targetUser.index + 1, userCountLength) + "]";

        if (targetUser.name) {
          targetPrefix += "[" + targetUser.name + "]";
        }

        this.log("👥 [组队瓜分朴分活动] 加入" + targetPrefix + "队伍失败[" + errorCode + "]: " + errorMessage);

        switch (errorCode) {
          case 100007: // 队伍已满
            targetUser.team_need_help = false;
            break;
          case 100008: // 无法加入自己的队伍
            break;
          case 100009: // 今日已助力
            this.team_can_help = false;
            break;
        }
      }
    } catch (exception) {
      console.log(exception);
    }
  }

  // 查询朴分
  async query_coin(options = {}) {
    try {
      const requestConfig = {
        fn: "query_coin",
        method: "get",
        url: "https://j1.pupuapi.com/client/coin"
      };

      let { result, statusCode } = await this.request(requestConfig);
      let errorCode = CommonUtils.get(result, "errcode", statusCode);

      if (errorCode === 0) {
        let { balance, expiring_coin, expire_time } = result?.data;

        let diff = balance - (this.coin_before ?? balance);
        let diffStr = "（本次 " + (diff > 0 ? "+" : "") + diff + "）";
        this.log("💰 总朴分: " + balance + diffStr);

        if (expiring_coin && expire_time) {
          let expireDate = CommonUtils.time("yyyy-MM-dd", expire_time);
          this.log("⏰ 朴分到期提醒：" + expiring_coin + "朴分将于" + expireDate + "过期，请尽快使用");
        }
      } else {
        let errorMessage = CommonUtils.get(result, "errmsg", "");
        this.log("❌ 查询朴分失败[" + errorCode + "]: " + errorMessage);
      }
    } catch (exception) {
      console.log(exception);
    }
  }

  // 用户任务
  async userTask(options = {}) {
    await this.user_info();
    await this.near_location_by_city();
    this.log("🎯 开始执行日常任务");
    // 查询执行前朴分
    await this._query_coin_before();
    await this.sign_index();
    await this.get_team_code();
  }

  // 查询执行前朴分
  async _query_coin_before() {
    try {
      const requestConfig = {
        fn: "query_coin_before",
        method: "get",
        url: "https://j1.pupuapi.com/client/coin"
      };
      let { result, statusCode } = await this.request(requestConfig);
      let errorCode = CommonUtils.get(result, "errcode", statusCode);
      if (errorCode === 0) {
        let balance = result?.data?.balance;
        this.coin_before = balance;
        this.log("💰 当前朴分：" + balance);
      }
    } catch (exception) {
      console.log(exception);
    }
  }

  // 查询执行后朴分（延迟几秒等积分同步）
  async _query_coin_after() {
    try {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const requestConfig = {
        fn: "query_coin_after",
        method: "get",
        url: "https://j1.pupuapi.com/client/coin"
      };
      let { result, statusCode } = await this.request(requestConfig);
      let errorCode = CommonUtils.get(result, "errcode", statusCode);
      if (errorCode === 0) {
        let balance = result?.data?.balance;
        this.log("💰 执行后朴分：" + balance);
      }
    } catch (exception) {
      console.log(exception);
    }
  }
}

// ==================== 账号加载 ====================
// 优先级：
//   1) YYB_SERVER（或 yyb_server）：
//        {网关地址}@{账号ref}   指定账号
//        {网关地址}             不带 @ → 自动拉取该网关全部账号
//        {网关地址}@*           同上
//   2) 旧格式 wx_server_url + ppcs_openid
//
// 每条之间用 &、英文逗号、中文逗号或换行分隔
function splitMulti(value) {
  return (value || "").split(/[,，&\n]/).map(s => s.trim()).filter(s => s);
}

// 从网关账号对象提取展示名
function accountLabel(acc) {
  let nick = acc.alias || acc.nickname || "";
  if (!nick) {
    nick = "openid=" + String(acc.openid || "").substring(0, 8);
  }
  return "#" + acc.id + " " + nick;
}

async function loadAccounts() {
  let entries = [];   // { wxServerUrl, ref, remark }
  let serverLine = YYB_SERVER.trim();

  if (serverLine) {
    for (let item of splitMulti(serverLine)) {
      let at = item.lastIndexOf("@");
      let host, ref;
      if (at === -1) {
        host = item;
        ref = "*";     // 不带 @：自动拉取全部账号
      } else {
        host = item.substring(0, at).trim();
        ref = item.substring(at + 1).trim();
      }
      if (!host) {
        CommonUtils.log("⚠️ YYB_SERVER 格式错误（网关地址为空）: " + item);
        continue;
      }
      host = normalizeServerUrl(host);
      if (!ref) ref = "*";

      if (ref === "*") {
        // 自动发现：先探活，再拉账号列表
        if (!(await checkGatewayHealth(host))) {
          CommonUtils.log("❌ 网关不可达，跳过: " + host);
          continue;
        }
        let accounts = await fetchGatewayAccounts(host);
        if (accounts.length === 0) {
          CommonUtils.log("⚠️ 网关没有可用账号: " + host);
          continue;
        }
        for (let acc of accounts) {
          let status = acc.status || "unknown";
          if (status !== "alive" && AUTO_REFRESH) {
            status = await refreshGatewayAccount(host, acc.id);
            CommonUtils.log("♻️ 账号 " + accountLabel(acc) + " 续期结果: " + status);
          }
          if (status !== "alive") {
            if (SKIP_EXPIRED) {
              CommonUtils.log("⚠️ 跳过非存活账号: " + accountLabel(acc) + " (status=" + status + ")");
              continue;
            }
            CommonUtils.log("⚠️ 账号可能已失效: " + accountLabel(acc) + " (status=" + status + ")");
          }
          // 用 id 当 ref，最稳（UIN 可能为空，openid 也不会变）
          entries.push({ wxServerUrl: host, ref: String(acc.id), remark: accountLabel(acc) });
        }
      } else {
        entries.push({ wxServerUrl: host, ref: ref, remark: "" });
      }
    }
  } else {
    if (!PPCS_OPENID || !WX_SERVER_URL) {
      CommonUtils.log("❌ 未配置 YYB 网关账号：请设置 yyb_server（推荐）或 wx_server_url + ppcs_openid");
      return false;
    }
    let wxServerUrl = normalizeServerUrl(WX_SERVER_URL);
    for (let ref of splitMulti(PPCS_OPENID)) {
      entries.push({ wxServerUrl: wxServerUrl, ref: ref, remark: "" });
    }
  }

  if (entries.length === 0) {
    CommonUtils.log("❌ 没有解析到有效的 YYB 网关账号");
    return false;
  }

  // 去重（同网关 + 同 ref 只跑一次）
  let seen = new Set();
  for (let e of entries) {
    let key = e.wxServerUrl + "@" + e.ref;
    if (seen.has(key)) continue;
    seen.add(key);
    CommonUtils.userList.push(new PupuUser("", e.ref, e.wxServerUrl, e.remark));
  }

  CommonUtils.userCount = CommonUtils.userList.length;
  return true;
}

// ==================== 主流程 ====================
(async () => {
  if (ENABLE_VERSION_CHECK) {
    await checkVersion();
  }

  if (!await loadAccounts()) return;

  console.log("=".repeat(30));
  console.log("🚀 朴朴超市签到");
  console.log("📱 共配置 " + CommonUtils.userCount + " 个账号");
  console.log("🔌 当前小程序 appid: " + PPCS_APPID);
  console.log("=".repeat(30));

  let validUsers = [];

  // 逐个账号：登录 → 任务 → 执行后朴分 → 总朴分
  for (let user of CommonUtils.userList) {
    try {
      let loginSuccess = await user.user_refresh_token();
      if (!loginSuccess) {
        user.log("❌ 登录失败，跳过");
        continue;
      }
      validUsers.push(user);
      await user.userTask();
      await user._query_coin_after();
      await user.query_coin();
    } catch (e) {
      user.log("❌ 账号执行异常: " + (e?.message || e));
    }
    await CommonUtils.wait(1000);
  }

  if (validUsers.length === 0) {
    CommonUtils.log("❌ 没有有效的账号，程序结束");
    return;
  }

  // 互相助力
  if (!validUsers.some(u => u.team_need_help)) {
    CommonUtils.log(">>> [组队瓜分朴分活动] 没有账号处于组队中状态，跳过互相助力");
  } else {
    CommonUtils.log(">>> [组队瓜分朴分活动] 开始互相组队助力");
    for (let needHelpUser of validUsers.filter(u => u.team_need_help)) {
      for (let helperUser of validUsers.filter(u => u.team_can_help && u.index !== needHelpUser.index)) {
        if (!needHelpUser.team_need_help) break;
        await helperUser.join_team(needHelpUser);
      }
    }
  }
})()
  .catch(error => CommonUtils.log(error))
  .finally(() => CommonUtils.exitNow());

// ==================== 版本检查 ====================
async function checkVersion(retryCount = 0) {
  let success = false;

  try {
    const requestConfig = {
      fn: "auth",
      method: "get",
      url: VERSION_CHECK_URL,
      timeout: 10000
    };

    let { statusCode, result } = await globalRequest.request(requestConfig);

    if (statusCode !== 200) {
      if (retryCount < MAX_VERSION_CHECK_RETRY) {
        success = await checkVersion(retryCount + 1);
      }
      return success;
    }

    if (result?.code === 0) {
      result = JSON.parse(result.data.file.data);

      if (result?.commonNotify && result.commonNotify.length > 0) {
        CommonUtils.log(result.commonNotify.join("\n") + "\n");
      }

      if (result?.commonMsg && result.commonMsg.length > 0) {
        CommonUtils.log(result.commonMsg.join("\n") + "\n");
      }

      if (result[SCRIPT_KEY]) {
        let scriptInfo = result[SCRIPT_KEY];

        if (scriptInfo.status === 0) {
          if (SCRIPT_VERSION >= scriptInfo.version) {
            success = true;
            CommonUtils.log(scriptInfo.msg[scriptInfo.status]);
            CommonUtils.log(scriptInfo.updateMsg);
            CommonUtils.log("📋 当前脚本版本：" + SCRIPT_VERSION + "，最新版本：" + scriptInfo.latestVersion);
          } else {
            CommonUtils.log(scriptInfo.versionMsg);
          }
        } else {
          CommonUtils.log(scriptInfo.msg[scriptInfo.status]);
        }
      } else {
        CommonUtils.log(result.errorMsg);
      }
    } else if (retryCount < MAX_VERSION_CHECK_RETRY) {
      success = await checkVersion(retryCount + 1);
    }
  } catch (exception) {
    CommonUtils.log(exception);
  } finally {
    return success;
  }
}

// ==================== 通用工具类 ====================
function createCommonUtils(scriptName) {
  return new class {
    constructor(name) {
      this.name = name;
      this.startTime = Date.now();
      this.userIdx = 0;
      this.userList = [];
      this.userCount = 0;

      this.default_timestamp_len = 13;
      this.default_wait_interval = 1000;
      this.default_wait_limit = 3600000;
      this.default_wait_ahead = 0;

      this.ALL_DIGIT = "0123456789";
      this.ALL_ALPHABET = "qwertyuiopasdfghjklzxcvbnm";
      this.ALL_CHAR = this.ALL_DIGIT + this.ALL_ALPHABET + this.ALL_ALPHABET.toUpperCase();
    }

    // 日志输出
    log(message, options = {}) {
      const defaultOptions = { console: true };
      Object.assign(defaultOptions, options);

      if (defaultOptions.time) {
        let timeFormat = defaultOptions.fmt || "hh:mm:ss";
        message = "[" + this.time(timeFormat) + "]" + message;
      }

      if (defaultOptions.console) {
        console.log(message);
      }
    }

    // 获取对象属性
    get(obj, key, defaultValue = "") {
      let value = defaultValue;
      if (obj?.hasOwnProperty(key)) {
        value = obj[key];
      }
      return value;
    }

    // 弹出对象属性
    pop(obj, key, defaultValue = "") {
      let value = defaultValue;
      if (obj?.hasOwnProperty(key)) {
        value = obj[key];
        delete obj[key];
      }
      return value;
    }

    // 复制对象
    copy(obj) {
      return Object.assign({}, obj);
    }

    // 从环境变量读取
    read_env(UserClass) {
      let envValues = ckNames.map(name => process.env[name]);

      for (let envValue of envValues.filter(v => !!v)) {
        for (let cookie of envValue.split(envSplitor).filter(c => !!c)) {
          this.userList.push(new UserClass(cookie));
        }
      }

      this.userCount = this.userList.length;

      if (!this.userCount) {
        this.log("❌ 未找到变量，请检查变量" + ckNames.map(n => "[" + n + "]").join("或"));
        return false;
      }

      this.log("📊 共找到 " + this.userCount + " 个账号");
      return true;
    }

    // 时间格式化
    time(format, timestamp = null) {
      let date = timestamp ? new Date(timestamp) : new Date();
      let dateObj = {
        "M+": date.getMonth() + 1,
        "d+": date.getDate(),
        "h+": date.getHours(),
        "m+": date.getMinutes(),
        "s+": date.getSeconds(),
        "q+": Math.floor((date.getMonth() + 3) / 3),
        "S": this.padStr(date.getMilliseconds(), 3)
      };

      if (/(y+)/.test(format)) {
        format = format.replace(RegExp.$1, (date.getFullYear() + "").substr(4 - RegExp.$1.length));
      }

      for (let key in dateObj) {
        if (new RegExp("(" + key + ")").test(format)) {
          format = format.replace(
            RegExp.$1,
            RegExp.$1.length === 1 ? dateObj[key] : ("00" + dateObj[key]).substr(("" + dateObj[key]).length)
          );
        }
      }

      return format;
    }

    // 字符串填充
    padStr(str, length, options = {}) {
      let padding = options.padding || "0";
      let mode = options.mode || "l";
      let result = String(str);
      let padLength = length > result.length ? length - result.length : 0;
      let padString = "";

      for (let i = 0; i < padLength; i++) {
        padString += padding;
      }

      if (mode === "r") {
        result = result + padString;
      } else {
        result = padString + result;
      }

      return result;
    }

    // JSON转字符串
    json2str(obj, separator, encode = false) {
      let pairs = [];

      for (let key of Object.keys(obj).sort()) {
        let value = obj[key];
        if (value && encode) {
          value = encodeURIComponent(value);
        }
        pairs.push(key + "=" + value);
      }

      return pairs.join(separator);
    }

    // 字符串转JSON
    str2json(str, decode = false) {
      let obj = {};

      for (let pair of str.split("&")) {
        if (!pair) continue;

        let equalIndex = pair.indexOf("=");
        if (equalIndex === -1) continue;

        let key = pair.substr(0, equalIndex);
        let value = pair.substr(equalIndex + 1);

        if (decode) {
          value = decodeURIComponent(value);
        }

        obj[key] = value;
      }

      return obj;
    }

    // 随机模式
    randomPattern(pattern, charset = "abcdef0123456789") {
      let result = "";

      for (let char of pattern) {
        if (char === "x") {
          result += charset.charAt(Math.floor(Math.random() * charset.length));
        } else if (char === "X") {
          result += charset.charAt(Math.floor(Math.random() * charset.length)).toUpperCase();
        } else {
          result += char;
        }
      }

      return result;
    }

    // 随机UUID
    randomUuid() {
      return this.randomPattern("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx");
    }

    // 随机字符串
    randomString(length, charset = "abcdef0123456789") {
      let result = "";

      for (let i = 0; i < length; i++) {
        result += charset.charAt(Math.floor(Math.random() * charset.length));
      }

      return result;
    }

    // 随机列表元素
    randomList(list) {
      let randomIndex = Math.floor(Math.random() * list.length);
      return list[randomIndex];
    }

    // 等待
    wait(milliseconds) {
      return new Promise(resolve => setTimeout(resolve, milliseconds));
    }

    // 退出
    async exitNow() {
      let endTime = Date.now();
      let duration = (endTime - this.startTime) / 1000;

      let validCount = CommonUtils.userList.filter(u => u.valid).length;
      console.log("======🎉 完成 " + validCount + " / 共 " + CommonUtils.userCount + " 账号，耗时 " + duration.toFixed(1) + "s======");

      process.exit(0);
    }

    // 标准化时间戳
    normalize_time(timestamp, options = {}) {
      let targetLength = options.len || this.default_timestamp_len;
      timestamp = timestamp.toString();
      let currentLength = timestamp.length;

      while (currentLength < targetLength) {
        timestamp += "0";
        currentLength++;
      }

      if (currentLength > targetLength) {
        timestamp = timestamp.slice(0, 13);
      }

      return parseInt(timestamp);
    }

    // 等待到指定时间
    async wait_until(targetTime, options = {}) {
      let logger = options.logger || this;
      let interval = options.interval || this.default_wait_interval;
      let limit = options.limit || this.default_wait_limit;
      let ahead = options.ahead || this.default_wait_ahead;

      if (typeof targetTime === "string" && targetTime.includes(":")) {
        if (targetTime.includes("-")) {
          targetTime = new Date(targetTime).getTime();
        } else {
          let today = this.time("yyyy-MM-dd ");
          targetTime = new Date(today + targetTime).getTime();
        }
      }

      let normalizedTime = this.normalize_time(targetTime) - ahead;
      let timeString = this.time("hh:mm:ss.S", normalizedTime);
      let now = Date.now();

      if (now > normalizedTime) {
        normalizedTime += 86400000; // 加一天
      }

      let waitTime = normalizedTime - now;

      if (waitTime > limit) {
        logger.log("离目标时间[" + timeString + "]大于" + limit / 1000 + "秒,不等待", { time: true });
      } else {
        logger.log("离目标时间[" + timeString + "]还有" + waitTime / 1000 + "秒,开始等待", { time: true });

        while (waitTime > 0) {
          let sleepTime = Math.min(waitTime, interval);
          await this.wait(sleepTime);
          now = Date.now();
          waitTime = normalizedTime - now;
        }

        logger.log("已完成等待", { time: true });
      }
    }

    // 等待间隔
    async wait_gap_interval(lastTime, interval) {
      let elapsed = Date.now() - lastTime;
      if (elapsed < interval) {
        await this.wait(interval - elapsed);
      }
    }
  }(scriptName);
}
