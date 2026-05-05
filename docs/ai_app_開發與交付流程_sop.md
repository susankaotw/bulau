# AI App 開發與交付流程 SOP

## 一、核心開發流程

```txt
AI 寫功能
↓
Docker 固定環境
↓
瀏覽器測試 Web / API
↓
Capacitor 打包 APK
↓
手機實機測試
↓
正式部署 / 上架
```

這是目前 AI 時代最穩定、最有效率的產品交付方式。

目標不是「把程式寫出來」，
而是：

**把產品真正交付出去。**

---

# 二、第一階段：AI 協助開發功能

## 使用工具

- ChatGPT
- Cursor
- Codex
- Claude（可選）

## 目標

快速完成：

- 前端畫面
- API 串接
- CRUD 功能
- LINE Bot 邏輯
- OpenAI API 串接
- Notion / Google Sheet 串接
- Prompt 設計
- Debug 修正

## 原則

AI 負責：

```txt
快速產出 + 加速開發
```

人負責：

```txt
架構判斷 + 邏輯驗證 + 商業決策
```

不要讓 AI 決定架構。

---

# 三、第二階段：Docker 固定環境

## 目的

避免：

```txt
我電腦可以跑
你電腦不能跑
```

## Docker 負責

- Node.js 版本統一
- npm 套件安裝
- API 執行環境
- 前端開發環境
- .env 環境變數
- Port 管理
- 本機部署測試

## 核心檔案

```txt
Dockerfile
docker-compose.yml
.dockerignore
.env
package.json
```

## 啟動指令

```bash
docker compose up
```

成功標準：

```txt
http://localhost:3001 可正常開啟
```

---

# 四、第三階段：瀏覽器測試 API / Web

## 電腦測試

確認：

- 畫面正常
- API 正常回應
- 資料庫正常
- Notion 正常連線
- OpenAI 正常回覆

## 手機測試（同 Wi-Fi）

使用：

```txt
http://電腦IP:3001
```

例如：

```txt
http://192.168.1.100:3001
```

確認：

- 手機可正常開啟
- API 可正常呼叫
- 網路可正常通訊

注意：

```txt
127.0.0.1 = 手機自己
不是你的電腦
```

這是最常見錯誤。

---

# 五、第四階段：Capacitor 打包 APK

## 目的

把 Web App 變成 Android APP

## 使用工具

- Capacitor
- Android Studio

## 功能

- 包裝成 APK
- 安裝到手機
- 使用原生功能
- 權限管理
- 推播通知
- 相機 / 麥克風 / 檔案權限

## 核心設定

```json
capacitor.config.json
```

例如：

```json
{
  "appId": "com.bulau.aiassistant",
  "appName": "不老 AI 助理",
  "webDir": "www"
}
```

---

# 六、第五階段：手機實機測試

## 重點確認

- APP 是否正常開啟
- API 是否正常連線
- 網路安全設定
- cleartext HTTP 是否允許
- localhost 是否寫錯
- 權限是否正常
- Android 相容性

## 常見錯誤

```txt
ERR_CONNECTION_REFUSED
```

通常原因：

- port 沒開
- IP 錯誤
- Docker 沒啟動
- 防火牆阻擋
- Android cleartext 被擋

---

# 七、最終階段：正式部署

可選：

- Vercel
- Render
- Railway
- VPS
- 自架 Docker Server

正式網址：

```txt
https://your-domain.com
```

之後：

- 正式上架
- 團隊使用
- 客戶交付
- SaaS 化
- 商業化

---

# 八、核心思維

不要只會：

```txt
寫功能
```

而是要做到：

```txt
可交付
可維護
可擴展
可商業化
```

這才是：

# AI 系統架構師

真正的價值。

