FROM node:22-alpine

# 面板本身只用 Node；python3 是留给挂载进来的美团专家包用的（面板只借它的
# cliguard.js 做签名，理论上不需要 python3，保留是为了专家包内脚本仍可手动执行）。
# tzdata 保证容器内时间是北京时间
RUN apk add --no-cache python3 ca-certificates tzdata \
 && ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
 && echo "Asia/Shanghai" > /etc/timezone

WORKDIR /app
COPY . .

ENV NODE_ENV=production \
    PORT=5180 \
    TZ=Asia/Shanghai

EXPOSE 5180

CMD ["node", "server.js"]
