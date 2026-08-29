//朴朴超市签到（Code 版）
//配置: YYB_SERVER=yyb-go地址@账号ID或OpenID, 每行一个或逗号分隔
//     YYB_API_KEY=可选(YYB Go 开了鉴权才需要)
//旧版兼容: wx_server_url + ppcs_openid (YYB_SERVER 为空时生效)
const got=require("got");
const APPID="wx122ef876a7132eb4";
const VER="2026081723";
const REF="https://servicewechat.com/"+APPID+"/797/page-frame.html";
const UA="Mozilla/5.0 (iPhone; CPU iPhone OS 16_1_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.46 NetType/WIFI Language/zh_CN miniProgram/wx122ef876a7132eb4";
const UAW="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) XWEB/25364";
const TMO=20000
const RTN=3
const GAP=2000
function env(k){let v=process.env[k];if(!v){v="";}return String(v).trim();}
const YYB=env("YYB_SERVER");
const APIKEY=env("YYB_API_KEY");
const WXURL=env("wx_server_url");
const PPOPENID=env("ppcs_openid");
const AH=(APIKEY)?({"X-API-Key":APIKEY}):({});
let GBO=null
//通用工具
const CU=(()=>{
  const U={
    idx:0,
    list:[],
    cnt:0,
    log(m){console.log(m);},
    get(o,k,d){if(o&&o.hasOwnProperty(k)){return o[k];}return d;},
    rs(n){let s="";for(let i=0;i<n;i++){s+="0123456789".charAt(Math.floor(Math.random()*10));}return s;},
    pick(a){return a[Math.floor(Math.random()*a.length)];},
    pad(x){if(x<10){return"0"+x;}return String(x);},
    date(ts){let d=ts?new Date(ts):new Date();return d.getFullYear()+"-"+CU.pad(d.getMonth()+1)+"-"+CU.pad(d.getDate());},
    wait(ms){return new Promise(r=>setTimeout(r,ms));},
    exit(){let v=0;for(let u of this.list){if(u.valid){v++;}}console.log("完成 "+v+"/"+this.cnt+" 个账号");process.exit(0);}
  };
  return U;
})();
//基础请求类（兼容新旧 got）
class BReq{
  constructor(skip){
    this.index=skip?(-1):(CU.idx++);
    this.valid=false;
    this.hdrs={"Connection":"keep-alive"};
    if(typeof got.extend==="function"){
      this.g=got.extend({retry:{limit:0},timeout:TMO,followRedirect:false,headers:this.hdrs});
    }else{
      this.g=got;
    }
  }
  log(m){CU.log(m);}
  ext(h){if(h){Object.assign(this.hdrs,h);}}
  async rq(o){
    let x=null;
    let n=0;
    let fn=o.fn||o.url;
    while(n<RTN){
      if(n>0){await CU.wait(GAP*n);}
      n++;
      try{
        let t=TMO;
        let g=this.g;
        if(g&&g.default&&typeof g.default==="function"){g=g.default;}
        let m=(o.method||"GET").toLowerCase();
        let p={method:o.method,headers:Object.assign({},this.hdrs,o.headers||{}),timeout:{request:t},retry:{limit:0},followRedirect:false,throwHttpErrors:false};
        if(o.json){p.json=o.json;}
        if(o.searchParams){p.searchParams=o.searchParams;}
        if(typeof g==="function"){x=await g(p);}
        else if(g[m]&&typeof g[m]==="function"){x=await g[m](o.url,p);}
        else{throw new Error("unsupported got");}
        break;
      }catch(e){this.log("请求错误["+fn+"]："+e.message);}
    }
    if(!x){return{statusCode:-1,headers:null,result:null};}
    let b=x.body;
    if(b&&typeof b==="string"){try{b=JSON.parse(b);}catch(e){b=null;}}
    return{statusCode:x.statusCode,headers:x.headers,result:b};
  }}
//YYB 地址解析 + 网关登录
function nsv(s){let t=String(s).trim();if(!t){return"";}if(!t.startsWith("http://")&&!t.startsWith("https://")){t="http://"+t;}return t.replace(/\/+$/,"");}
function pent(l){let v=String(l).trim();if(!v||v.indexOf("@")<0){return null;}let i=v.indexOf("@");let s=nsv(v.slice(0,i));let r=v.slice(i+1).trim();if(!s||!r){return null;}return{server:s,ref:r};}
async function viaLogin(server,ref,log,idx,us){
  if(!server){log("缺少 YYB 服务地址");return null;}
  if(!ref){log("缺少账号标识");return null;}
  let short=ref;
  if(ref.length>10){short=ref.slice(0,6)+"..."+ref.slice(-4);}
  log(">>> 账号 "+(idx+1)+"/"+CU.cnt+" : "+short);
  let xs=server.replace(/\/+$/,"");
  let x=await GBO.rq({fn:"getCode",method:"post",url:xs+"/wxapp/getCode",headers:Object.assign({},AH),json:{app_id:APPID,ref:ref}});
  let cd=x.result;

  if(!cd||cd.code!==0){log("❌ getCode 失败");return null;}
  let code=null;
  if(cd.data&&cd.data.result){code=cd.data.result.code;}
  if(!code){log("❌ getCode 没拿到 code");return null;}
  log("🔑 code 已获取："+String(code).substring(0,12)+"...");
  let l=await GBO.rq({fn:"silent_login",method:"post",url:"https://cauth.pupuapi.com/clientauth/user/society/miniapp/silent_login",headers:{"User-Agent":UA,"Accept":"application/json","Content-Type":"application/json","pp-version":VER,"pp-os":"0","Referer":REF},json:{code:code}});
  let ld=l.result;
  if(!ld||ld.errcode!==0){log("❌ silent_login 失败");return null;}
  let d=ld.data;
  log("✅ 登录成功，用户："+String(d.nick_name);)
  return d;
}
//===== 朴朴用户类 =====
class Pupu extends BReq{
  constructor(ck,ref,server,rm,nn){
    super();
    this.ref=ref?ref:"";
    this.server=server?server:"";
    this.nickname=nn?nn:"";
    this.remark=rm?rm:"";
    this.open_id="";this.suid="";this.team_id="";
    this.coin_before=0;
    this.team_need_help=false;this.team_can_help=true;
    this.team_max_help=0;this.team_helped_count=0;
    this.ext({"User-Agent":UAW});
  }
  async silent_login(){
    let ok=false;
    try{
      let d=await viaLogin(this.server,this.ref,(m)=>this.log(m),this.index,this);
      if(!d){return false;}
      this.valid=true;
      this.access_token=d.token?d.token:"";
      this.refresh_token=d.refresh_token?d.refresh_token:"";
      this.open_id=d.open_id?d.open_id:"";
      this.suid=d.suid?d.suid:"";
      this.user_id=d.user_id;
      let nm=this.remark?this.remark:(this.nickname?this.nickname:(d.nick_name?d.nick_name:""));
      this.name=nm;
      this.ext({"User-Agent":UA,"pp-version":VER,"pp-os":"0","Referer":REF,"Authorization":"Bearer "+d.token,"pp-userid":String(d.user_id),"open-id":d.open_id,"pp-suid":d.suid});
      ok=true;
      await this.user_info();
    }catch(e){this.log("登录异常："+e.message);}
    finally{return ok;}
  }
  async user_refresh_token(){return await this.silent_login();}
  async user_info(){
    try{
      let x=await this.rq({fn:"user_info",method:"get",url:"https://cauth.pupuapi.com/clientauth/user/info"});
      let ec=CU.get(x.result,"errcode",x.statusCode);
      if(ec==0){
        this.phone=x.result.data.phone;
      }else{this.log("查询用户信息失败["+ec+"]");}
    }catch(e){this.log(e.message);}
  }
  async near(){
    try{
      let x=await this.rq({fn:"near",method:"get",url:"https://j1.pupuapi.com/client/store/place/near_location_by_city/v2",searchParams:{lng:"119"+CU.rs(5),lat:"26"+CU.rs(5)}});
      let ec=CU.get(x.result,"errcode",x.statusCode);
      if(ec==0){
        let loc=CU.pick(x.result.data;
        this.store_id=loc.service_store_id;
        this.zip=loc.city_zip;
        this.ext({"pp_storeid":loc.service_store_id,"pp-cityzip":loc.city_zip});
      }else{this.log("选取地点失败["+ec+"]");}
    }catch(e){this.log(e.message);}
  }
async sign(){
    try{
      let x=await this.rq({fn:"sign_index",method:"get",url:"https://j1.pupuapi.com/client/game/sign/v2/index"});
      let ec=CU.get(x.result,"errcode",x.statusCode);
      if(ec==0){
        if(x.result.data.is_signed){this.log("📅 [签到] 今天已签到");}
        else{await this.dos();}
      }else{this.log("📅 [签到] 查询失败["+ec+"]");}
    }catch(e){this.log(e.message);}
  }
  async dos(){
    try{
      let x=await this.rq({fn:"do_sign",method:"post",url:"https://j1.pupuapi.com/client/game/sign/v2"});
      let ec=CU.get(x.result,"errcode",x.statusCode);
      if(ec==0){
        let dd=x.result.data?x.result.data:{};
        let rw=[String(dd.daily_sign_coin)+"积分"];
        let cs=dd.coupon_list?dd.coupon_list:[];
        for(let c of cs){
          let ca=(c.condition_amount/100).toFixed(2);
          let da=(c.discount_amount/100).toFixed(2;
          rw.push("满"+ca+"减"+da+"券");
        }
        this.log("📅 [签到] 成功："+rw.join("，");
      }else{this.log("📅 [签到] 失败["+ec+"]");}
    }catch(e){this.log(e.message);}
  }
  async gteam(){
    try{
      let x=await this.rq({fn:"get_team_code",method:"post",url:"https://j1.pupuapi.com/client/game/coin_share/team/v3",json:{}});
      let ec=CU.get(x.result,"errcode",x.statusCode);
      if(ec==0){
        let dd=x.result.data;
        if(dd&&typeof dd==="object"){this.team_id=dd.team_id?dd.team_id:"";}
        else{this.team_id=dd?dd:"";}
        if(!this.team_id){this.log("🤝 [组队] 没拿到组队码");return;}
        await this.cteam();
      }else{this.log("🤝 [组队] 获取组队码失败["+ec+"]");}
    }catch(e){this.log(e.message);;}
  }
  async cteam(){
    try{
      let x=await this.rq({fn:"check_team",method:"get",url:"https://j1.pupuapi.com/client/game/coin_share/teams/"+this.team_id});
      let ec=CU.get(x.result,"errcode",x.statusCode);
      if(ec==0){
        let dd=x.result.data?x.result.data:{};
        if(dd.status==10){
          this.team_need_help=true;
          this.team_max_help=dd.target_team_member_num?dd.target_team_member_num:0;
          this.team_helped_count=dd.current_team_member_num?dd.current_team_member_num:0;
          this.log("🤝 [组队] 组队中："+this.team_helped_count+"/"+this.team_max_help);
        }else if(dd.status==30){
          this.log("🤝 [组队] 完成，得"+String(dd.current_user_reward_coin)+"积分");}
        else{this.log("🤝 [组队] 状态["+dd.status+"]");}
      }else{this.log("🤝 [组队] 查询失败["+ec+"]");}
    }catch(e){this.log(e.message;}}
  }
async join(t){
    try{
      let x=await this.rq({fn:"join_team",method:"post",url:"https://j1.pupuapi.com/client/game/coin_share/teams/"+t.team_id+"/join"});
      let ec=CU.get(x.result,"errcode",x.statusCode);
      if(ec==0){
        this.team_can_help=false;
        t.team_helped_count=(t.team_helped_count?t.team_helped_count:0)+1;
        let tp="账号["+(t.index+1)+"]";
        if(t.name){tp+="["+t.name+"]";}
        this.log("👥 加入"+tp+"队伍："+t.team_helped_count+"/"+t.team_max_help);
        if(t.team_helped_count>=t.team_max_help){t.team_need_help=false;t.log("👥 组队已满");}
      }else{
        this.log("👥 加入失败["+ec+"]");
        if(ec==100007){t.team_need_help=false;}
        if(ec==100009){this.team_can_help=false;}
      }
    }catch(e){this.log(e.message);}
  }
  async coin(){
    try{
      let x=await this.rq({fn:"coin",method:"get",url:"https://j1.pupuapi.com/client/coin"});
      let ec=CU.get(x.result,"errcode",x.statusCode);
      if(ec==0){
        let dd=x.result.data?x.result.data:{};
        let df=dd.balance-this.coin_before;
        let tag=df>0?"+"+df:df;
        this.log("💰 总朴分："+dd.balance+"（本次 "+tag+"）");
        if(dd.expiring_coin&&dd.expire_time){
          let ed=CU.date(dd.expire_time;
          this.log("⏰ "+String(dd.expiring_coin)+"朴分 "+ed+" 过期");
        }
      }else{this.log("❌ 查询朴分失败["+ec+"]");}
    }catch(e){this.log(e.message);;}
  }
  async cbefore(){
    try{
      let x=await this.rq({fn:"coin_before",method:"get",url:"https://j1.pupuapi.com/client/coin"});
      let ec=CU.get(x.result,"errcode",x.statusCode);
      if(ec==0){
        let dd=x.result.data?x.result.data:{};
        this.coin_before=dd.balance?dd.balance:0;
        this.log("💰 当前朴分："+this.coin_before);
      }
    }catch(e){this.log(e.message;}}
  }
  async cafter(){
    try{
      await CU.wait(3000;
      let x=await this.rq({fn:"coin_after",method:"get",url:"https://j1.pupuapi.com/client/coin"});
      let ec=CU.get(x.result,"errcode",x.statusCode);
      if(ec==0){this.log("💰 执行后朴分："+x.result.data.balance;)
    }catch(e){this.log(e.message;}}
  }
async task(){
    await this.user_info();
    await this.near();
    this.log("🎯 开始日常任务");
    await this.cbefore();
    await this.sign();
    await this.gteam();
  }
}
//===== 账号加载 =====
function mkTargets(){
  let arr=[];
  let lines=YYB?YYB.split(/[\r\n,,]+/):[];
  for(let line of lines){
    let e=pent(line);
    if(!e){
      if(line.trim()){CU.log("⚠️ YYB_SERVER 忽略行："+line.trim();}
      continue;
    }
    arr.push({server:e.server,ref:e.ref,remark:"",nickname:"",index:arr.length+1});
  }
  return arr;
}
async function mkLabels(arr){
  let g={};
  for(let t of arr){
    if(!g[t.server]){g[t.server]=[];}
    g[t.server].push(t;
  }
  for(let s of Object.keys(g)){
    try{
      let x=await GBO.rq({fn:"accounts",method:"get",url:s+"/accounts",headers:Object.assign({},AH),timeout:10000});
      let p=x.result;
      if(!p||typeof p!=="object"){continue;}
      let it=p.data;
      if(!Array.isArray(it)){
        if(it&&typeof it==="object"){it=it.accounts?it.accounts:(it.items?it.items:(it.list?it.list:[]));}
        else{it=[];}
      }
      if(!Array.isArray(it)){continue;}
      let ids=[];
      for(let v of it){
        if(!v||typeof v!=="object"){continue;}
        ids.push(String(v.id? v.id:""),String(v.openid?v.openid:""),String(v.uin?v.uin:""),v)
      }
      for(let t of g[s]){
        for(let it2 of ids){
          if(it2[0]===t.ref||it2[1]===t.ref||it2[2]===t.ref){
            let ob=it2[3];
            t.remark=ob.remark?String(ob.remark):"";
            t.nickname=ob.nickname?String(ob.nickname):"";
            break;
          }
        }
      }
    }catch(e){CU.log("⚠️ 读取备注失败["+s+"]："+e.message;}
  }
}
async function load(){
  let arr=[];
  if(YYB){
    arr=mkTargets();
    if(!arr.length){CU.log("❌ YYB_SERVER 未读到有效账号（格式：地址@账号ID）");return false;}
    await mkLabels(arr);
    for(let t of arr){
      CU.list.push(new Pupu("",t.ref,t.server,t.remark,t.nickname);
    }
  }else if(WXURL&&PPOPENID){
    let rs=PPOPENID.split(/[,，&\r\n]+/).map(r=>r.trim()).filter(r=>r);
    let s=WXURL.replace(/\/+$/,"");
    for(let r of rs){CU.list.push(new Pupu("",r,s;;}
  }else{
    CU.log("❌ 未配置 YYB_SERVER（格式：地址@账号ID或OpenID）");
    return false;
  }
  CU.cnt=CU.list.length;
  return true;
}
//===== 主流程 =====
(async()=>{
  GBO=new BReq(true);
  if(!(await load())){return;}
  console.log("🚀 朴朴超市签到（YYB Go 版）");
  console.log("📱 共配置 "+CU.cnt+" 个账号");
  let vs=[];
  for(let u of CU.list){
    u.log("🌍 来源："+u.server);
    let ok=await u.silent_login();
    if(!ok){u.log("❌ 登录失败，跳过");continue;}
    vs.push(u;
    await u.task();
    await u.cafter();
    await u.coin();
  }
  if(!vs.length){CU.log("❌ 没有有效账号");return;}
  let need=vs.filter(u=>u.team_need_help);
  if(!need.length){CU.log(">>> 无组队中账号，跳过助力");}
  else{
    CU.log(">>> 开始互相组队助力");
    for(let h of need){
      for(let p of vs.filter(u=>u.team_can_help&&u.index!==h.index)){
        if(!h.team_need_help){break;}
        await p.join(h);
      }
    }
  }
})()
  .catch(e=>console.log(e))
  .finally(()=>CU.exit());