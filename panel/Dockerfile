FROM node:22-alpine

# 面板本身只用 Node；python3 是留给挂载进来的美团专家包用的（面板只借它的
# cliguard.js 做签名，理论上不需要 python3，保留是为了专家包内脚本仍可手动执行）。
# tzdata 保证容器内时间是北京时间
#
# chromium + puppeteer-core：京东扫码登录专用。京东换 pt_key 需要 __jda / eid
# 这两个设备指纹，它们由页面 JS SDK 执行后生成，纯 HTTP 请求造不出来，
# 所以只能开个无头浏览器把登录页跑起来。
RUN apk add --no-cache python3 ca-certificates tzdata chromium \
 && ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
 && echo "Asia/Shanghai" > /etc/timezone

WORKDIR /app
COPY . .

RUN npm install puppeteer-core --no-audit --no-fund --omit=dev \
 && npm cache clean --force

ENV NODE_ENV=production \
    PORT=5180 \
    TZ=Asia/Shanghai \
    CHROME_PATH=/usr/bin/chromium-browser

EXPOSE 5180

CMD ["node", "server.js"]
