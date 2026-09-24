FROM golang:1.23-alpine AS builder

# 国内镜像加速；modernc.org/sqlite 是纯 Go 实现，关掉 cgo 也能编
ENV GOPROXY=https://goproxy.cn,direct \
    CGO_ENABLED=0 \
    GOOS=linux

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -trimpath -ldflags "-s -w" -o /out/yyb-go ./cmd/yyb-go

FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata \
 && ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
 && echo "Asia/Shanghai" > /etc/timezone

WORKDIR /app
COPY --from=builder /out/yyb-go /app/yyb-go
COPY resource /app/resource

ENV TZ=Asia/Shanghai
EXPOSE 8000

CMD ["/app/yyb-go", "-host", "0.0.0.0", "-port", "8000", "-resource-root", "/app/resource"]
