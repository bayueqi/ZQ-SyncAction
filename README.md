# 🤖 ZQ-SyncAction
一款部署在 **Cloudflare Workers** 上的轻量脚本，专门解决 GitHub Action 定时任务因**60天无活动**被自动暂停的问题，同时支持**上游仓库自动同步**功能，全程利用免费资源，无需额外服务器。

## ✨ 核心特性

### 🛡 保活功能
- 🛡 **真实心跳提交**：通过 Contents API 更新 `.syncaction` 时间戳文件，产生真实 commit。GitHub 只认 commit / issue / PR 才算仓库活动，单纯触发 Workflow 不会重置 60 天计时器
- 🔁 **自动恢复**：Workflow 已被停用时自动调用 enable 接口重新启用再触发
- ⏱ **提交节流**：同一仓库 20 天内不重复提交，不刷屏提交历史
- 👥 **多用户管理**：支持添加多个 GitHub 用户，每个用户可独立配置 Token
- 📦 **多仓库管理**：每个用户可添加多个仓库，配置 Workflow、分支

### 🔄 上游同步功能
- 🔄 **直接同步**：通过 GitHub API 直接同步上游仓库分支到目标仓库，无需 GitHub Actions
- ⚡ **智能对比**：自动对比上游和目标的 commit SHA，仅在有更新时同步
- 📋 **多任务管理**：支持配置多个同步任务，统一管理
- ⏰ **定时自动同步**：配合 Cron 触发器，定时自动执行同步
- 📊 **详细报告**：同步结果包含已同步、跳过、失败数量统计

### 🌟 通用特性
- 📱 **Telegram 实时通知**：推送脚本运行报告、执行结果，状态一手掌握
- 💰 **零成本运行**：完全消耗 Cloudflare 免费额度（每日10万次请求），无任何费用支出
- 🌐 **友好前端界面**：直观的蓝白色管理界面，支持密码保护、模块化功能管理
- 🔒 **密码保护**：首次访问设置密码，确保配置安全

---

## 🛠 第一步：准备 GitHub 个人访问令牌（Token）
脚本需通过该 Token 获取操作仓库的权限，步骤如下：
1. 登录 GitHub，点击头像 → **Settings**
2. 左侧菜单栏最下方 → **Developer settings**
3. 选择 **Personal access tokens** → **Tokens (classic)**
4. 点击 **Generate new token (classic)**
5. **Note**：自定义名称（例：`SyncAction`），便于识别
6. **Expiration**：建议选择 **No expiration**（永不过期），避免后续重复配置
7. **Select scopes**（权限勾选，二选一）：
   - 公开仓库：勾选 `public_repo` + `workflow`
   - 私有仓库：勾选 `repo`（包含所有仓库权限） + `workflow`
8. 点击 **Generate token**，复制生成的**ghp_开头**字符串，妥善保存（仅显示一次）

---

## ☁️ 第二步：部署 Cloudflare Worker

### 1. 创建并编写 Worker 代码
1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 左侧菜单 → **Workers & Pages**
3. 点击 **Create Application** → **Create Worker** → 先点击**Deploy**创建默认Worker
4. 进入 Worker 编辑页，点击 **Edit code**
5. 将 `_worker.js` 代码**全量复制**，覆盖编辑器中的默认代码
6. 点击右上角 **Deploy** 保存代码

### 2. 创建 KV 存储
为实现配置持久化，需通过 KV 存储持久化配置，步骤如下：
1. 回到 Cloudflare 主面板，左侧菜单 → **Storage & Databases** → **KV**
2. 点击 **Create Namespace**
3. 自定义命名空间名称（例：`SyncAction`），点击 **Add** 完成创建

### 3. 配置 Worker 绑定（关键步骤）
回到你的 Worker 页面，点击 **Settings** → **Variables**，配置 KV 绑定：

#### A. 绑定 KV 命名空间（必须配置）
1. 找到 **KV Namespace Bindings** 区域，点击 **Add Binding**
2. **Variable name**：**必须填写 `SyncAction`**（注意大小写！）
3. **KV Namespace**：选择上一步创建的 KV 命名空间（例：`SyncAction`）
4. 点击 **Deploy** 保存绑定

---

## ⏰ 第三步：设置 Worker 定时触发器（Triggers）
1. 回到 Worker 页面，点击 **Triggers** 选项卡
2. 找到 **Cron Triggers** 区域，点击 **Add Cron Trigger**
3. **Cron Expression**：根据需要设置频率
   - 保活任务：建议每两周或每月一次（心跳自带 20 天节流，跑勤了也不会多提交）
   - 同步任务：建议每天一次（按需调整）

   > 注意：Worker 定时触发时会同时执行保活和同步两个任务

4. 点击 **Add Trigger** 完成配置

---

## 🚀 第四步：访问前端界面
1. 复制 Worker 访问 URL（在 Worker 页面的 **Overview** 标签页）
2. 在浏览器中访问该 URL
3. 首次访问会提示设置密码，输入你想要的密码
4. 进入管理界面后，配置以下内容：

### ⚙️ 基础配置
- **Telegram Bot Token (TG_TOKEN)**：Telegram 机器人 Token
- **Telegram 聊天ID (TG_ID)**：接收通知的聊天 ID

### 🛡 保活功能
1. 点击「+ 添加用户」
2. 填写 **GitHub 用户名** 和 **GitHub Token**
3. 每个用户下点击「+ 添加仓库」，配置：
   - **仓库名称**：仓库名
   - **Workflow 文件名**：要触发的 workflow 文件名（默认 `main.yml`）
   - **分支名称**：分支名（默认 `main`）
4. 点击「🚀 执行保活」可手动测试

### 🔄 上游同步
1. 点击「+ 添加用户」
2. 填写 **GitHub 用户名**（目标仓库的所有者）和 **GitHub Token**（有写入权限）
3. 每个用户下点击「+ 添加仓库」，配置：
   - **上游仓库**：填 `owner/repo`（例：`ZQ-ZQ/ZQ-Blog`，粘贴完整链接也能识别）
   - **分支**：要同步的分支名（默认 `main`）
   - **目标仓库**：你的仓库名
4. 点击「🔄 立即同步」可手动测试

5. 点击「💾 保存配置」保存所有设置




---

## ⚠️ 注意事项
1. **Token 安全**：请妥善保管 GitHub Token，不要泄露给他人
2. **权限要求**：
   - 保活功能：Token 需要有 `workflow` 权限和仓库内容读写权限（classic 勾 `repo` 或 `public_repo` + `workflow`）
   - 同步功能：Token 需要有仓库写入权限
3. **心跳文件**：保活会在仓库根目录生成 `.syncaction`，内容只有更新时间戳，不要删除
4. **分支保护**：如果目标分支开启了 "Require pull request before merging"，心跳提交会被 409 拒绝，需要放开或用不受保护的分支
5. **同步频率**：合理设置同步频率，避免滥用 GitHub 资源
6. **强制同步**：同步功能是强制覆盖目标分支，请确保你了解后果
7. **配置结构**：保活配置在 `users` 中，同步配置在 `syncUsers` 中，两者都是「用户 → 仓库」层级结构，相互独立
