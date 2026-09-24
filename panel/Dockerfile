FROM node:22-alpine

# run.js 依赖 python3（auth.py）；tzdata 保证容器内时间是北京时间
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
