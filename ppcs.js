/*
------------------------------------------
@Author: anonymous
@Date: 2026.08.20
@Description: 朴朴超市
cron: 9 8 * * *
------------------------------------------
⚠️【免责声明】
------------------------------------------
1、此脚本仅用于学习研究，不保证其合法性、准确性、有效性，请根据情况自行判断，本人对此不承担任何保证责任。
2、由于此脚本仅用于学习研究，您必须在下载后 24 小时内将所有内容从您的计算机或手机或任何存储设备中完全删除，若违反规定引起任何事件本人对此均不负责。
3、请勿将此脚本用于任何商业或非法目的，若违反规定请自行对此负责。
4、此脚本涉及应用与本人无关，本人对因此引起的任何隐私泄漏或其他后果不承担任何责任。
5、本人对任何脚本引发的问题概不负责，包括但不限于由脚本错误引起的任何损失和损害。
6、如果任何单位或个人认为此脚本可能涉嫌侵犯其权利，应及时通知并提供身份证明，所有权证明，我们将在收到认证文件确认后删除此脚本。
7、所有直接或间接使用、查看此脚本的人均应该仔细阅读此声明。本人保留随时更改或补充此声明的权利。一旦您使用或复制了此脚本，即视为您已接受此免责声明。
*/

// ==================== 常量定义 ====================
const CommonUtils = createCommonUtils("朴朴超市");
const fs = require("fs");
const got = require("got");
const PROJECT_NAME = "pupu";
const COOKIE_FILE = PROJECT_NAME + "Cookie.txt";
const REQUEST_TIMEOUT = 20000;
const MAX_RETRY_COUNT = 3;
const SCRIPT_VERSION = 1.01;
const SCRIPT_KEY = "pupu";
const VERSION_CHECK_URL = "https://leafxcy.coding.net/api/user/leafxcy/project/validcode/shared-depot/validCode/git/blob/master/code.json";
const USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_1_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.46(0x18002e2c) NetType/WIFI Language/zh_CN miniProgram/wx122ef876a7132eb4";
const RETRY_WAIT_TIME = 2000;
const MAX_VERSION_CHECK_RETRY = 5;

// ==================== 基础请求类 ====================
class BaseRequest {
  constructor() {
    this.index = CommonUtils.userIdx++;
    this.name = "";
    this.valid = false;
    
    // 默认请求配置
    this.defaultHeaders = { "Connection": "keep-alive" };
    
    // 兼容不同版本的got
    if (typeof got.extend === 'function') {
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
      // 新版got (v12+)
      this.got = got;
      this.isOldGot = false;
      
      // 调试信息
      if (this.index === 1) {
        console.log('Got version info:');
        console.log('- typeof got:', typeof got);
        console.log('- typeof got.get:', typeof got.get);
        console.log('- typeof got.post:', typeof got.post);
        console.log('- typeof got.put:', typeof got.put);
        console.log('- got.default exists:', !!got.default);
        console.log('- typeof got.default:', typeof got.default);
      }
    }
  }

  // 获取日志前缀
  get_prefix(options = {}) {
    let prefix = "";
    const userCountLength = CommonUtils.userCount.toString().length;
    
    if (this.index) {
      prefix += "账号[" + CommonUtils.padStr(this.index, userCountLength) + "]";
    }
    
    if (this.phone) {
      let maskedPhone = this.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
      prefix += "[朴朴:" + maskedPhone + "]";
    } else if (this.name) {
      prefix += "[" + this.name + "]";
    }
    
    return prefix;
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
            this.log("[" + functionName + "]请求超时" + errorInfo + "(" + duration + "ms)，重试第" + retryCount + "次");
          } else if (REQUEST_ERROR_TYPES.includes(error?.name)) {
            this.log("[" + functionName + "]请求错误(" + error.code + ")(" + duration + "ms)，重试第" + retryCount + "次");
          } else {
            if (statusCode) {
              if (error && !validStatusCodes.includes(statusCode)) {
                this.log("请求[" + functionName + "]返回[" + statusCode + "]");
              }
            } else {
              let { code = "unknown", name = "unknown" } = error || {};
              this.log("请求[" + functionName + "]错误[" + code + "][" + name + "]");
            }
            break;
          }
        } catch (exception) {
          this.log("[" + functionName + "]请求错误(" + exception.message + ")，重试第" + retryCount + "次");
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
let globalRequest = new BaseRequest();

// ==================== 朴朴用户类 ====================
class PupuUser extends BaseRequest {
  constructor(cookieString) {
    super();
    
    let parts = cookieString.split("#");
    this.refresh_token = parts[0];
    this.remark = parts?.[1] || "";
    this.team_id = "";
    this.team_need_help = false;
    this.team_can_help = true;
    this.team_max_help = 0;
    this.team_helped_count = 0;
    
    this.extendGot({
      headers: { "User-Agent": USER_AGENT }
    });
  }

  // 刷新token
  async user_refresh_token(options = {}) {
    let success = false;
    
    try {
      const requestConfig = {
        fn: "user_refresh_token",
        method: "put",
        url: "https://cauth.pupuapi.com/clientauth/user/refresh_token",
        json: { refresh_token: this.refresh_token }
      };
      
      let { result, statusCode } = await this.request(requestConfig);
      let errorCode = CommonUtils.get(result, "errcode", statusCode);
      
      if (errorCode === 0) {
        this.valid = true;
        let { access_token, refresh_token, user_id, nick_name } = result?.data;
        
        this.access_token = access_token;
        this.refresh_token = refresh_token;
        this.user_id = user_id;
        this.name = this.remark || nick_name;
        
        this.extendGot({
          headers: {
            "Authorization": "Bearer " + access_token,
            "pp-userid": user_id
          }
        });
        
        success = true;
        await this.user_info();
        saveCookieFile();
      } else {
        let errorMessage = CommonUtils.get(result, "errmsg", "");
        this.log("刷新token失败[" + errorCode + "]: " + errorMessage);
        
        if (errorCode === 200208) {
          this.valid = false;
          this.need_remove = true;
        }
      }
    } catch (exception) {
      console.log(exception);
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
        this.name = this.remark || phone || this.name;
        this.invite_code = invite_code;
        this.log("登录成功");
      } else {
        let errorMessage = CommonUtils.get(result, "errmsg", "");
        this.log("查询用户信息失败[" + errorCode + "]: " + errorMessage);
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
          lng: "119.31" + CommonUtils.randomString(4, CommonUtils.ALL_DIGIT),
          lat: "26.06" + CommonUtils.randomString(4, CommonUtils.ALL_DIGIT)
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
        this.log("选取随机地点失败[" + errorCode + "]: " + errorMessage);
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
          this.log("今天已签到");
        } else {
          await this.do_sign();
        }
      } else {
        let errorMessage = CommonUtils.get(result, "errmsg", "");
        this.log("查询签到信息失败[" + errorCode + "]: " + errorMessage);
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
        
        this.log("签到成功: " + rewards.join(", "));
      } else {
        let errorMessage = CommonUtils.get(result, "errmsg", "");
        this.log("签到失败[" + errorCode + "]: " + errorMessage);
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
          this.log("获取组队码失败: 未返回team_id: " + JSON.stringify(data));
          return;
        }

        await this.check_my_team();
      } else {
        let errorMessage = CommonUtils.get(result, "errmsg", "");
        this.log("获取组队码失败[" + errorCode + "]: " + errorMessage);
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
            this.log("组队未完成: " + current_team_member_num + "/" + target_team_member_num);
            break;
          case 30: // 组队完成
            this.log("已组队成功, 获得了" + current_user_reward_coin + "积分");
            break;
          default:
            this.log("组队状态[" + status + "]");
            this.log(": " + JSON.stringify(result?.data));
        }
      } else {
        let errorMessage = CommonUtils.get(result, "errmsg", "");
        this.log("查询组队信息失败[" + errorCode + "]: " + errorMessage);
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
        let maskedPhone = targetUser.phone ? targetUser.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : '';
        let targetPrefix = "账号[" + CommonUtils.padStr(targetUser.index, userCountLength) + "]";
        
        if (maskedPhone) {
          targetPrefix += "[朴朴:" + maskedPhone + "]";
        } else if (targetUser.name) {
          targetPrefix += "[" + targetUser.name + "]";
        }
        
        this.log("加入" + targetPrefix + "队伍成功: " + targetUser.team_helped_count + "/" + targetUser.team_max_help);
        
        if (targetUser.team_helped_count >= targetUser.team_max_help) {
          targetUser.team_need_help = false;
          targetUser.log("组队已满");
        }
      } else {
        let errorMessage = CommonUtils.get(result, "errmsg", "");
        
        let userCountLength = CommonUtils.userCount.toString().length;
        let maskedPhone = targetUser.phone ? targetUser.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : '';
        let targetPrefix = "账号[" + CommonUtils.padStr(targetUser.index, userCountLength) + "]";
        
        if (maskedPhone) {
          targetPrefix += "[朴朴:" + maskedPhone + "]";
        } else if (targetUser.name) {
          targetPrefix += "[" + targetUser.name + "]";
        }
        
        this.log("加入" + targetPrefix + "队伍失败[" + errorCode + "]: " + errorMessage);
        
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
        
        this.log("朴分: " + balance, { notify: true });
        
        if (expiring_coin && expire_time) {
          let expireDate = CommonUtils.time("yyyy-MM-dd", expire_time);
          this.log("有" + expiring_coin + "朴分将于" + expireDate + "过期", { notify: true });
        }
      } else {
        let errorMessage = CommonUtils.get(result, "errmsg", "");
        this.log("查询朴分失败[" + errorCode + "]: " + errorMessage, { notify: true });
      }
    } catch (exception) {
      console.log(exception);
    }
  }

  // 用户任务
  async userTask(options = {}) {
    await this.user_info();
    await this.near_location_by_city();
    await this.sign_index();
    await this.get_team_code();
  }
}

// ==================== Cookie文件操作 ====================
// 读取Cookie文件
function readCookieFile() {
  if (fs.existsSync("./" + COOKIE_FILE)) {
    let fileContent = fs.readFileSync("./" + COOKIE_FILE, { flag: "r", encoding: "utf-8" });
    let lines = fileContent?.replace(/\r/g, "")?.split("\n")?.filter(line => line) || [];
    
    for (let line of lines) {
      CommonUtils.userList.push(new PupuUser(line));
    }
  } else {
    fs.writeFileSync("./" + COOKIE_FILE, "", { flag: "w", encoding: "utf-8" });
    CommonUtils.log("CK文件[" + COOKIE_FILE + "]不存在, 默认为你新建一个, 如有需要请填入ck");
  }
  
  CommonUtils.userCount = CommonUtils.userList.length;
  
  if (!CommonUtils.userCount) {
    CommonUtils.log("未找到变量，请检查文件[" + COOKIE_FILE + "]", { notify: true });
    return false;
  }
  
  CommonUtils.log("共找到" + CommonUtils.userCount + "个账号");
  return true;
}

// 保存Cookie文件
function saveCookieFile() {
  let validCookies = [];
  
  for (let user of CommonUtils.userList) {
    if (user.valid) {
      let remark = user.remark || user.mobile || user.name || "";
      let cookie = user.refresh_token + "#" + remark;
      validCookies.push(cookie);
    }
  }
  
  if (validCookies.length) {
    fs.writeFileSync("./" + COOKIE_FILE, validCookies.join("\n"), { flag: "w", encoding: "utf-8" });
  } else {
    fs.writeFileSync("./" + COOKIE_FILE, "", { flag: "w", encoding: "utf-8" });
  }
}

// ==================== 主流程 ====================
(async () => {
  if (!readCookieFile()) return;
  
  CommonUtils.log("------------------- 登录 -------------------");
  let invalidUsers = [];
  
  for (let user of CommonUtils.userList) {
    let loginSuccess = await user.user_refresh_token();
    if (!loginSuccess) {
      invalidUsers.push(user);
    }
  }
  
  // 清理失效账号
  if (invalidUsers.length > 0) {
    CommonUtils.log("\n------------------- 清理失效账号 -------------------");
    
    for (let invalidUser of invalidUsers) {
      let index = CommonUtils.userList.indexOf(invalidUser);
      if (index > -1) {
        CommonUtils.userList.splice(index, 1);
        invalidUser.log("账号已失效，已从列表中删除");
      }
    }
    
    saveCookieFile();
    CommonUtils.log("已清理" + invalidUsers.length + "个失效账号，cookie文件已更新");
  }
  
  let validUsers = CommonUtils.userList.filter(user => user.valid);
  
  if (validUsers.length === 0) {
    CommonUtils.log("没有有效的账号，程序结束");
    return;
  }
  
  // 签到组队
  CommonUtils.log("\n------------------- 签到组队 -------------------");
  for (let user of validUsers) {
    await user.userTask();
  }
  
  // 助力
  CommonUtils.log("\n------------------- 助力 -------------------");
  for (let needHelpUser of validUsers.filter(u => u.team_need_help)) {
    for (let helperUser of validUsers.filter(u => u.team_can_help && u.index !== needHelpUser.index)) {
      if (!needHelpUser.team_need_help) break;
      await helperUser.join_team(needHelpUser);
    }
  }
  
  // 查询
  CommonUtils.log("\n------------------- 查询 -------------------");
  for (let user of validUsers) {
    await user.query_coin();
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
      timeout: 20000
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
        CommonUtils.log(result.commonNotify.join("\n") + "\n", { notify: true });
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
            CommonUtils.log("现在运行的脚本版本是：" + SCRIPT_VERSION + "，最新脚本版本：" + scriptInfo.latestVersion);
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
      this.log("[" + this.name + "]开始运行", { time: true });
      
      this.notifyStr = [];
      this.notifyFlag = true;
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
      
      if (defaultOptions.notify) {
        this.notifyStr.push(message);
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
        this.log("未找到变量，请检查变量" + ckNames.map(n => "[" + n + "]").join("或"), { notify: true });
        return false;
      }
      
      this.log("共找到" + this.userCount + "个账号");
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

    // 显示消息
    async showmsg() {
      if (!this.notifyFlag) return;
      if (!this.notifyStr.length) return;
      
      try {
        const sendNotify = require("./sendNotify");
        this.log("\n============== 推送 ==============");
        await sendNotify.sendNotify(this.name, this.notifyStr.join("\n"));
      } catch {
        this.log("\n=================================");
        this.log("读取推送依赖[sendNotify.js]失败, 请检查同目录下是否有依赖");
      }
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
      await this.showmsg();
      
      let endTime = Date.now();
      let duration = (endTime - this.startTime) / 1000;
      
      this.log("");
      this.log("[" + this.name + "]运行结束，共运行了" + duration + "秒", { time: true });
      
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