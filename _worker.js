export default {
  async scheduled(event, env, ctx) {
    const config = await this.loadConfig(env);
    if (!config) {
      console.log("❌ 未找到配置，跳过运行");
      return;
    }
    // 执行保活任务
    await this.runKeepAlive(config, env);
    // 执行同步任务
    await this.runSyncRepos(config, env);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    if (path === "/api/login" && request.method === "POST") {
      return await this.handleLogin(request, env);
    }
    
    if (path === "/api/config" && request.method === "GET") {
      return await this.getConfig(request, env);
    }
    
    if (path === "/api/config" && request.method === "PUT") {
      return await this.saveConfig(request, env);
    }
    
    if (path === "/api/run" && request.method === "POST") {
      return await this.handleRun(request, env);
    }
    
    if (path === "/api/sync/run" && request.method === "POST") {
      return await this.handleSyncRun(request, env);
    }
    
    return new Response(this.getHTML(), {
      headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  },

  async loadConfig(env) {
    if (!env.SyncAction) return null;
    const configStr = await env.SyncAction.get("config");
    if (!configStr) return null;
    try {
      return JSON.parse(configStr);
    } catch (e) {
      return null;
    }
  },

  async saveConfigToKV(env, config) {
    if (!env.SyncAction) return false;
    await env.SyncAction.put("config", JSON.stringify(config));
    return true;
  },

  async verifyPassword(request, env) {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
    
    const token = authHeader.slice(7);
    const config = await this.loadConfig(env);
    if (!config || !config.password) return false;
    
    return token === config.password;
  },

  async handleLogin(request, env) {
    const body = await request.json();
    const { password } = body;
    
    const config = await this.loadConfig(env);
    
    if (!config) {
      if (!env.SyncAction) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: "未绑定 KV 命名空间：请在 Worker 的 Settings → Variables 添加变量 SyncAction 并绑定 KV" 
        }), {
          headers: { "Content-Type": "application/json" },
          status: 500
        });
      }
      
      const newConfig = {
        password: password,
        tgToken: "",
        tgId: "",
        users: [],
        syncUsers: []
      };
      const saved = await this.saveConfigToKV(env, newConfig);
      if (!saved) {
        return new Response(JSON.stringify({ success: false, message: "配置写入 KV 失败" }), {
          headers: { "Content-Type": "application/json" },
          status: 500
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    
    if (config.password === password) {
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    
    return new Response(JSON.stringify({ success: false, message: "密码错误" }), {
      headers: { "Content-Type": "application/json" },
      status: 401
    });
  },

  async getConfig(request, env) {
    const isValid = await this.verifyPassword(request, env);
    if (!isValid) {
      return new Response(JSON.stringify({ success: false, message: "未授权" }), {
        headers: { "Content-Type": "application/json" },
        status: 401
      });
    }
    
    const config = await this.loadConfig(env);
    if (config) delete config.password;
    return new Response(JSON.stringify({ success: true, config }), {
      headers: { "Content-Type": "application/json" }
    });
  },

  async saveConfig(request, env) {
    const isValid = await this.verifyPassword(request, env);
    if (!isValid) {
      return new Response(JSON.stringify({ success: false, message: "未授权" }), {
        headers: { "Content-Type": "application/json" },
        status: 401
      });
    }
    
    const body = await request.json();
    const currentConfig = await this.loadConfig(env);
    const newConfig = {
      ...currentConfig,
      tgToken: body.tgToken,
      tgId: body.tgId,
      users: body.users || [],
      syncUsers: body.syncUsers || []
    };
    
    const saved = await this.saveConfigToKV(env, newConfig);
    if (!saved) {
      return new Response(JSON.stringify({ success: false, message: "KV 未绑定，配置无法保存" }), {
        headers: { "Content-Type": "application/json" },
        status: 500
      });
    }
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" }
    });
  },

  async handleRun(request, env) {
    const isValid = await this.verifyPassword(request, env);
    if (!isValid) {
      return new Response(JSON.stringify({ success: false, message: "未授权" }), {
        headers: { "Content-Type": "application/json" },
        status: 401
      });
    }
    
    const config = await this.loadConfig(env);
    if (!config) {
      return new Response(JSON.stringify({ success: false, message: "未配置" }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    
    const result = await this.runKeepAlive(config, env);
    return new Response(JSON.stringify({ success: true, result }), {
      headers: { "Content-Type": "application/json" }
    });
  },

  async runKeepAlive(config, env) {
    const report = [];
    let successCount = 0;
    let totalCount = 0;
    
    for (const user of config.users || []) {
      if (!user.token || !user.name) continue;
      
      for (const repo of user.repos || []) {
        if (!repo.name) continue;
        totalCount++;
        try {
          const workflow = repo.workflow || "main.yml";
          const ref = repo.ref || "main";

          // GitHub 只认 commit 算仓库活动，先写心跳重置 60 天计时器
          const beat = await this.heartbeatCommit(user.name, repo.name, ref, user.token);
          // 任务本身靠 dispatch 驱动，schedule 被停用也不影响
          const run = await this.dispatchWorkflow(user.name, repo.name, workflow, ref, user.token);

          const status = beat.ok ? (run.ok ? "✅" : "⚠️") : "❌";
          report.push(`${status} ${user.name}/${repo.name}: ${beat.message}；${run.message}`);
          if (beat.ok) successCount++;
        } catch (err) {
          report.push(`❌ ${user.name}/${repo.name}: 错误 - ${err.message}`);
        }
      }
    }
    
    if (totalCount > 0 && config.tgToken && config.tgId) {
      const message = [
        `🤖 <b>GitHub 保活任务报告</b>`,
        `-----------------------------`,
        ...report,
        `-----------------------------`,
        `📊 <b>统计:</b> 成功 ${successCount} / 总计 ${totalCount}`
      ].join("\n");

      await this.sendTelegramMessage(config.tgToken, config.tgId, message);
    }
    
    return { report, successCount, totalCount };
  },

  // 心跳提交：只有真实 commit 才会重置 GitHub 的 60 天空闲计时器，默认 20 天内不重复提交
  async heartbeatCommit(owner, repo, ref, token, maxAgeDays = 20) {
    const api = `https://api.github.com/repos/${owner}/${repo}/contents/.syncaction`;
    const headers = {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "CF-Worker-ZQ-SyncAction"
    };

    let sha = null;
    let lastBeat = 0;
    const getRes = await fetch(`${api}?ref=${encodeURIComponent(ref)}`, { headers });

    if (getRes.ok) {
      const data = await getRes.json();
      sha = data.sha;
      try {
        const prev = JSON.parse(atob((data.content || "").replace(/\s/g, "")));
        lastBeat = Date.parse(prev.updated_at) || 0;
      } catch (e) {}
    } else if (getRes.status !== 404) {
      return { ok: false, message: `读取心跳文件失败 (${getRes.status})` };
    }

    const idleDays = Math.floor((Date.now() - lastBeat) / 86400000);
    if (lastBeat && idleDays < maxAgeDays) {
      return { ok: true, message: `心跳 ${idleDays} 天前，无需重置` };
    }

    const now = new Date().toISOString();
    const body = {
      message: `chore: syncaction ${now.slice(0, 10)}`,
      content: btoa(JSON.stringify({ updated_at: now })),
      branch: ref
    };
    if (sha) body.sha = sha;

    const putRes = await fetch(api, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (putRes.ok) return { ok: true, message: `已提交心跳 ${now.slice(0, 10)}` };
    if (putRes.status === 409) return { ok: false, message: "分支受保护，提交被拒" };
    return { ok: false, message: `心跳提交失败 (${putRes.status})` };
  },

  // 触发 workflow，被停用时先 enable 再重试一次
  async dispatchWorkflow(owner, repo, workflow, ref, token) {
    const base = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}`;
    const headers = {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "CF-Worker-ZQ-SyncAction"
    };

    const dispatch = () => fetch(`${base}/dispatches`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ref })
    });

    let res = await dispatch();
    if (res.status === 204) return { ok: true, message: "已触发 workflow" };

    if (res.status === 403 || res.status === 404) {
      const enable = await fetch(`${base}/enable`, { method: "PUT", headers });
      if (enable.ok) {
        res = await dispatch();
        if (res.status === 204) return { ok: true, message: "已重新启用并触发" };
        return { ok: false, message: `启用后触发仍失败 (${res.status})` };
      }
      return { ok: false, message: `workflow 不可用 (${res.status})，检查是否缺少 workflow_dispatch` };
    }

    return { ok: false, message: `触发失败 (${res.status})` };
  },

  async handleSyncRun(request, env) {
    const isValid = await this.verifyPassword(request, env);
    if (!isValid) {
      return new Response(JSON.stringify({ success: false, message: "未授权" }), {
        headers: { "Content-Type": "application/json" },
        status: 401
      });
    }
    
    const config = await this.loadConfig(env);
    if (!config) {
      return new Response(JSON.stringify({ success: false, message: "未配置" }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    
    const result = await this.runSyncRepos(config, env);
    return new Response(JSON.stringify({ success: true, result }), {
      headers: { "Content-Type": "application/json" }
    });
  },

  // ========== 核心同步逻辑（对应 yml 中的 git 操作）==========
  async runSyncRepos(config, env) {
    const report = [];
    let syncedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let totalCount = 0;
    
    for (const user of config.syncUsers || []) {
      if (!user.token || !user.name) continue;
      
      for (const repo of user.repos || []) {
        if (!repo.name) continue;
        totalCount++;
        
        const upstreamUser = repo.upstreamUser;
        const upstreamRepo = repo.upstreamRepo;
        const targetUser = user.name;
        const targetRepo = repo.name;
        const branch = repo.branch || "main";
        const token = user.token;
        
        const upstreamFull = `${upstreamUser}/${upstreamRepo}`;
        const targetFull = `${targetUser}/${targetRepo}`;
        
        if (!upstreamUser || !upstreamRepo) {
          report.push(`❌ ${targetFull}: 上游仓库信息不完整`);
          failedCount++;
          continue;
        }
        
        try {
          // 1. 获取上游仓库分支的最新 SHA（对应 yml 里的 git ls-remote UPSTREAM_REPO）
          const upstreamSha = await this.getBranchSha(upstreamFull, branch, token);
          if (!upstreamSha) {
            report.push(`❌ ${targetFull}: 上游仓库 ${upstreamFull} 的 ${branch} 分支不存在`);
            failedCount++;
            continue;
          }
          
          // 2. 获取目标仓库分支的最新 SHA（对应 yml 里的 git ls-remote TARGET_URL）
          const targetSha = await this.getBranchSha(targetFull, branch, token);
          
          // 3. 对比 SHA，判断是否需要同步
          if (upstreamSha === targetSha) {
            report.push(`⏭️ ${targetFull}: 已是最新，无需同步`);
            skippedCount++;
            continue;
          }
          
          // 4. 强制更新目标仓库的分支引用（对应 yml 里的 git push --force）
          const syncResult = await this.forceUpdateBranch(targetFull, branch, upstreamSha, token);
          if (syncResult.success) {
            report.push(`✅ ${targetFull}: 同步完成 ${targetSha.substring(0, 7)} → ${upstreamSha.substring(0, 7)}`);
            syncedCount++;
          } else {
            report.push(`❌ ${targetFull}: 同步失败 - ${syncResult.message}`);
            failedCount++;
          }
        } catch (err) {
          report.push(`❌ ${targetFull}: 错误 - ${err.message}`);
          failedCount++;
        }
      }
    }
    
    // 发送 Telegram 通知
    if (totalCount > 0 && config.tgToken && config.tgId) {
      const message = [
        `🔄 <b>上游仓库同步任务报告</b>`,
        `-----------------------------`,
        ...report,
        `-----------------------------`,
        `📊 <b>统计:</b> 已同步 ${syncedCount} / 跳过 ${skippedCount} / 失败 ${failedCount}`
      ].join("\n");

      await this.sendTelegramMessage(config.tgToken, config.tgId, message);
    }
    
    return { report, syncedCount, skippedCount, failedCount, totalCount };
  },

  // 获取仓库分支的最新 commit SHA
  async getBranchSha(repoFullName, branch, token) {
    try {
      const url = `https://api.github.com/repos/${repoFullName}/git/ref/heads/${branch}`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "CF-Worker-SyncUpstream"
        }
      });
      
      if (response.status === 404) {
        return null;
      }
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json();
      return data.object.sha;
    } catch (e) {
      throw new Error(`获取分支 SHA 失败: ${e.message}`);
    }
  },

  // 强制更新目标仓库分支引用到指定 SHA
  async forceUpdateBranch(repoFullName, branch, sha, token) {
    try {
      const url = `https://api.github.com/repos/${repoFullName}/git/refs/heads/${branch}`;
      const response = await fetch(url, {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "CF-Worker-SyncUpstream"
        },
        body: JSON.stringify({
          sha: sha,
          force: true
        })
      });
      
      if (response.ok) {
        return { success: true };
      } else {
        const errorData = await response.json().catch(() => ({}));
        return { success: false, message: errorData.message || `HTTP ${response.status}` };
      }
    } catch (e) {
      return { success: false, message: e.message };
    }
  },

  async sendTelegramMessage(token, chatId, text) {
    try {
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: text,
          parse_mode: "HTML",
          disable_web_page_preview: true
        })
      });
    } catch (e) {
      console.error("TG 发送失败:", e);
    }
  },

  getHTML() {
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ZQ-SyncAction</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg t='1777024262222' class='icon' viewBox='0 0 1024 1024' version='1.1' xmlns='http://www.w3.org/2000/svg' p-id='5277' width='200' height='200'%3E%3Cpath d='M145.778 128h732.444v170.667L945.778 416V96l-32-32h-800L78.222 96v600.889l35.556 32h248.889l-46.222-67.556H145.778V128z m295.111 600.889l-60.444-92.444 152.889-334.222 60.444-39.111h192l53.333 103.111-53.333 96H896L942.222 576 568.889 960H419.556l96-231.111h-74.667z m0-67.556h181.333L512 917.333l384-387.556H661.333l124.444-199.111h-192L440.889 661.333z m-3.556-266.666h-224v67.556h192l32-67.556z m-60.444 135.111H213.333v67.556h131.556l32-67.556z' p-id='5278'%3E%3C/path%3E%3C/svg%3E">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: linear-gradient(135deg, #e3f2fd 0%, #f5f9ff 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
      background: white;
      border-radius: 16px;
      box-shadow: 0 4px 20px rgba(0, 100, 200, 0.08);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #bbdefb 0%, #90caf9 100%);
      padding: 30px;
      text-align: center;
      color: #1565c0;
    }
    .header h1 { font-size: 28px; margin-bottom: 8px; }
    .header p { color: #1976d2; opacity: 0.9; }
    .content { padding: 30px; }
    .login-form {
      max-width: 400px;
      margin: 50px auto;
      text-align: center;
    }
    .form-group { margin-bottom: 20px; }
    .form-group label {
      display: block;
      margin-bottom: 8px;
      color: #333;
      font-weight: 500;
    }
    .form-group input, .form-group textarea {
      width: 100%;
      padding: 12px 16px;
      border: 1px solid #bbdefb;
      border-radius: 8px;
      font-size: 14px;
      transition: all 0.3s;
    }
    .form-group input:focus, .form-group textarea:focus {
      outline: none;
      border-color: #64b5f6;
      box-shadow: 0 0 0 3px rgba(100, 181, 246, 0.2);
    }
    .btn {
      padding: 12px 24px;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      cursor: pointer;
      transition: all 0.3s;
      font-weight: 500;
    }
    .btn-primary {
      background: linear-gradient(135deg, #64b5f6 0%, #42a5f5 100%);
      color: white;
    }
    .btn-primary:hover {
      background: linear-gradient(135deg, #42a5f5 0%, #1e88e5 100%);
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(33, 150, 243, 0.3);
    }
    .btn-success {
      background: linear-gradient(135deg, #81c784 0%, #66bb6a 100%);
      color: white;
    }
    .btn-success:hover {
      background: linear-gradient(135deg, #66bb6a 0%, #4caf50 100%);
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(76, 175, 80, 0.3);
    }
    .btn-warning {
      background: linear-gradient(135deg, #ffb74d 0%, #ffa726 100%);
      color: white;
    }
    .btn-warning:hover {
      background: linear-gradient(135deg, #ffa726 0%, #fb8c00 100%);
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(251, 140, 0, 0.3);
    }
    .btn-danger {
      background: linear-gradient(135deg, #e57373 0%, #ef5350 100%);
      color: white;
    }
    .btn-danger:hover {
      background: linear-gradient(135deg, #ef5350 0%, #f44336 100%);
    }
    .btn-sm {
      padding: 8px 16px;
      font-size: 13px;
    }
    .section { margin-bottom: 30px; padding-bottom: 20px; border-bottom: 1px solid #e3f2fd; }
    .section:last-child { border-bottom: none; margin-bottom: 0; }
    .section-title {
      font-size: 18px;
      color: #1565c0;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .section-desc {
      color: #666;
      font-size: 13px;
      margin-bottom: 15px;
    }
    .user-card {
      border: 1px solid #bbdefb;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 15px;
      background: #f5f9ff;
    }
    .user-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
    }
    .repo-item {
      background: white;
      border: 1px solid #e3f2fd;
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 10px;
    }
    .repo-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }
    .repo-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .action-bar {
      display: flex;
      gap: 12px;
      justify-content: flex-end;
      padding-top: 20px;
      flex-wrap: wrap;
    }
    .section-action-bar {
      display: flex;
      gap: 10px;
      justify-content: space-between;
      align-items: center;
      margin-top: 15px;
    }
    .hidden { display: none !important; }
    .toast {
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 15px 25px;
      border-radius: 8px;
      color: white;
      font-weight: 500;
      z-index: 1000;
      animation: slideIn 0.3s ease;
    }
    .toast-success { background: #66bb6a; }
    .toast-error { background: #ef5350; }
    @keyframes slideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }
    .result-box {
      background: #f5f9ff;
      border: 1px solid #bbdefb;
      border-radius: 8px;
      padding: 15px;
      margin-top: 15px;
    }
    .result-box pre {
      white-space: pre-wrap;
      font-size: 13px;
      line-height: 1.6;
    }
    .feature-section {
      background: #fafcff;
      border: 1px solid #e1f0fe;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .feature-section:last-child { margin-bottom: 0; }
    .feature-title {
      font-size: 16px;
      color: #1565c0;
      margin-bottom: 15px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
    }
    summary.feature-title {
      margin-bottom: 0;
      list-style: none;
      cursor: pointer;
      user-select: none;
      padding: 4px 0;
    }
    summary.feature-title::-webkit-details-marker { display: none; }
    summary.feature-title .chev {
      margin-left: auto;
      font-size: 12px;
      color: #64b5f6;
      transition: transform 0.2s;
    }
    details[open] > summary.feature-title { margin-bottom: 15px; }
    details[open] > summary.feature-title .chev { transform: rotate(180deg); }
    .sync-item {
      background: white;
      border: 1px solid #e3f2fd;
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 10px;
    }
    .sync-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }
    .sync-header span {
      font-weight: 500;
      color: #333;
      font-size: 14px;
    }
    .sync-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .sync-arrow {
      text-align: center;
      color: #1976d2;
      font-weight: 600;
      padding: 5px 0;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🤖 ZQ-SyncAction</h1>
      <p>轻松管理您的 GitHub Actions 保活与上游同步任务</p>
    </div>
    <div class="content">
      <div id="loginPage">
        <div class="login-form">
          <div class="form-group">
            <label>请输入密码</label>
            <input type="password" id="loginPassword" placeholder="首次使用将设置此密码">
          </div>
          <button class="btn btn-primary" onclick="login()">进入</button>
        </div>
      </div>
      
      <div id="mainPage" class="hidden">
        <!-- 基础配置 -->
        <div class="section">
          <h2 class="section-title">⚙️ 基础配置</h2>
          <div class="form-group">
            <label>Telegram Bot Token (TG_TOKEN)</label>
            <input type="text" id="tgTokenInput" placeholder="123456:ABCdefxxxx">
          </div>
          <div class="form-group">
            <label>Telegram 聊天ID (TG_ID)</label>
            <input type="text" id="tgIdInput" placeholder="12345678">
          </div>
        </div>
        
        <!-- 保活功能 -->
        <details class="feature-section">
          <summary class="feature-title">🛡 保活功能<span class="chev">▾</span></summary>
          <p class="section-desc">提交心跳 commit 重置 60 天计时器，并触发 Workflow 执行任务</p>
          <div id="keepAliveUsersList"></div>
          <div class="section-action-bar">
            <button class="btn btn-primary btn-sm" onclick="addKeepAliveUser()">+ 添加用户</button>
            <button class="btn btn-success btn-sm" onclick="runKeepAlive()">🚀 执行保活</button>
          </div>
          <div id="keepAliveResultBox" class="result-box hidden">
            <h3 style="margin-bottom:10px;">保活结果</h3>
            <pre id="keepAliveResultContent"></pre>
          </div>
        </details>
        
        <!-- 同步功能 -->
        <details class="feature-section">
          <summary class="feature-title">🔄 上游同步<span class="chev">▾</span></summary>
          <p class="section-desc">直接通过 GitHub API 同步上游仓库分支到目标仓库（force push）</p>
          <div id="syncUsersList"></div>
          <div class="section-action-bar">
            <button class="btn btn-primary btn-sm" onclick="addSyncUser()">+ 添加用户</button>
            <button class="btn btn-warning btn-sm" onclick="runSyncRepos()">🔄 立即同步</button>
          </div>
          <div id="syncResultBox" class="result-box hidden">
            <h3 style="margin-bottom:10px;">同步结果</h3>
            <pre id="syncResultContent"></pre>
          </div>
        </details>
        
        <!-- 保存按钮 -->
        <div class="action-bar">
          <button class="btn btn-primary" onclick="saveConfig()">💾 保存配置</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    let token = localStorage.getItem('keepAliveToken');
    let config = null;
    
    async function login() {
      const password = document.getElementById('loginPassword').value;
      if (!password) {
        showToast('请输入密码', 'error');
        return;
      }
      
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      
      const data = await res.json();
      if (data.success) {
        token = password;
        localStorage.setItem('keepAliveToken', token);
        showMainPage();
      } else {
        showToast(data.message || '密码错误', 'error');
      }
    }
    
    async function showMainPage() {
      document.getElementById('loginPage').classList.add('hidden');
      document.getElementById('mainPage').classList.remove('hidden');
      await loadConfig();
    }
    
    async function loadConfig() {
      const res = await fetch('/api/config', {
        headers: { 'Authorization': \`Bearer \${token}\` }
      });
      
      const data = await res.json();
      if (data.success && data.config) {
        config = data.config;
        if (!config.users) config.users = [];
        if (!config.syncUsers) config.syncUsers = [];
        renderConfig();
      }
    }
    
    function renderConfig() {
      document.getElementById('tgTokenInput').value = config.tgToken || '';
      document.getElementById('tgIdInput').value = config.tgId || '';
      renderKeepAliveUsers();
      renderSyncUsers();
    }
    
    // ========== 保活用户渲染 ==========
    function renderKeepAliveUsers() {
      const container = document.getElementById('keepAliveUsersList');
      container.innerHTML = '';
      
      (config.users || []).forEach((user, userIndex) => {
        const userDiv = document.createElement('div');
        userDiv.className = 'user-card';
        userDiv.innerHTML = \`
          <div class="user-header">
            <div class="form-group" style="margin:0;flex:1;margin-right:15px;">
              <label>用户名</label>
              <input type="text" value="\${user.name || ''}" onchange="updateKeepAliveUser(\${userIndex}, 'name', this.value)">
            </div>
            <button class="btn btn-danger btn-sm" onclick="removeKeepAliveUser(\${userIndex})">删除</button>
          </div>
          <div class="form-group">
            <label>GitHub Token</label>
            <input type="password" value="\${user.token || ''}" placeholder="ghp_xxxxxxxxxx" onchange="updateKeepAliveUser(\${userIndex}, 'token', this.value)">
          </div>
          <div style="margin-top:15px;">
            <h4 style="color:#1565c0;margin-bottom:10px;">📦 仓库列表</h4>
            <div id="keepAliveRepos-\${userIndex}"></div>
            <button class="btn btn-primary btn-sm" onclick="addKeepAliveRepo(\${userIndex})">+ 添加仓库</button>
          </div>
        \`;
        container.appendChild(userDiv);
        renderKeepAliveRepos(userIndex);
      });
    }
    
    function renderKeepAliveRepos(userIndex) {
      const container = document.getElementById(\`keepAliveRepos-\${userIndex}\`);
      container.innerHTML = '';
      
      const user = config.users[userIndex];
      (user.repos || []).forEach((repo, repoIndex) => {
        const repoDiv = document.createElement('div');
        repoDiv.className = 'repo-item';
        repoDiv.innerHTML = \`
          <div class="repo-header">
            <span style="font-weight:500;color:#333;">\${user.name || ''}/\${repo.name || ''}</span>
            <button class="btn btn-danger btn-sm" onclick="removeKeepAliveRepo(\${userIndex}, \${repoIndex})">删除</button>
          </div>
          <div class="repo-grid">
            <div class="form-group" style="margin:0;">
              <label>仓库名称</label>
              <input type="text" value="\${repo.name || ''}" onchange="updateKeepAliveRepo(\${userIndex}, \${repoIndex}, 'name', this.value)">
            </div>
            <div class="form-group" style="margin:0;">
              <label>Workflow 文件名</label>
              <input type="text" value="\${repo.workflow || ''}" onchange="updateKeepAliveRepo(\${userIndex}, \${repoIndex}, 'workflow', this.value)">
            </div>
            <div class="form-group" style="margin:0;">
              <label>分支名称</label>
              <input type="text" value="\${repo.ref || ''}" onchange="updateKeepAliveRepo(\${userIndex}, \${repoIndex}, 'ref', this.value)">
            </div>
          </div>
        \`;
        container.appendChild(repoDiv);
      });
    }
    
    function addKeepAliveUser() {
      if (!config.users) config.users = [];
      config.users.push({ name: '', token: '', repos: [] });
      renderKeepAliveUsers();
    }
    
    function removeKeepAliveUser(index) {
      config.users.splice(index, 1);
      renderKeepAliveUsers();
    }
    
    function updateKeepAliveUser(index, field, value) {
      config.users[index][field] = value;
    }
    
    function addKeepAliveRepo(userIndex) {
      if (!config.users[userIndex].repos) config.users[userIndex].repos = [];
      config.users[userIndex].repos.push({ name: '', workflow: '', ref: '' });
      renderKeepAliveRepos(userIndex);
    }
    
    function removeKeepAliveRepo(userIndex, repoIndex) {
      config.users[userIndex].repos.splice(repoIndex, 1);
      renderKeepAliveRepos(userIndex);
    }
    
    function updateKeepAliveRepo(userIndex, repoIndex, field, value) {
      config.users[userIndex].repos[repoIndex][field] = value;
    }
    
    // ========== 同步用户渲染 ==========
    function renderSyncUsers() {
      const container = document.getElementById('syncUsersList');
      container.innerHTML = '';
      
      (config.syncUsers || []).forEach((user, userIndex) => {
        const userDiv = document.createElement('div');
        userDiv.className = 'user-card';
        userDiv.innerHTML = \`
          <div class="user-header">
            <div class="form-group" style="margin:0;flex:1;margin-right:15px;">
              <label>用户名</label>
              <input type="text" value="\${user.name || ''}" onchange="updateSyncUser(\${userIndex}, 'name', this.value)">
            </div>
            <button class="btn btn-danger btn-sm" onclick="removeSyncUser(\${userIndex})">删除</button>
          </div>
          <div class="form-group">
            <label>GitHub Token</label>
            <input type="password" value="\${user.token || ''}" placeholder="ghp_xxxxxxxxxx" onchange="updateSyncUser(\${userIndex}, 'token', this.value)">
          </div>
          <div style="margin-top:15px;">
            <h4 style="color:#1565c0;margin-bottom:10px;">📦 仓库列表</h4>
            <div id="syncRepos-\${userIndex}"></div>
            <button class="btn btn-primary btn-sm" onclick="addSyncRepo(\${userIndex})">+ 添加仓库</button>
          </div>
        \`;
        container.appendChild(userDiv);
        renderSyncRepos(userIndex);
      });
    }
    
    function renderSyncRepos(userIndex) {
      const container = document.getElementById(\`syncRepos-\${userIndex}\`);
      container.innerHTML = '';
      
      const user = config.syncUsers[userIndex];
      (user.repos || []).forEach((repo, repoIndex) => {
        const repoDiv = document.createElement('div');
        repoDiv.className = 'repo-item';
        const upstream = repo.upstream 
          || ((repo.upstreamUser && repo.upstreamRepo) ? \`\${repo.upstreamUser}/\${repo.upstreamRepo}\` : '');
        repoDiv.innerHTML = \`
          <div class="repo-header">
            <span style="font-weight:500;color:#333;">\${upstream || '上游仓库'} → \${user.name || ''}/\${repo.name || ''}</span>
            <button class="btn btn-danger btn-sm" onclick="removeSyncRepo(\${userIndex}, \${repoIndex})">删除</button>
          </div>
          <div class="repo-grid">
            <div class="form-group" style="margin:0;grid-column:1 / -1;">
              <label>上游仓库</label>
              <input type="text" value="\${upstream}" placeholder="owner/repo" onchange="updateSyncUpstream(\${userIndex}, \${repoIndex}, this.value)">
            </div>
            <div class="form-group" style="margin:0;">
              <label>分支</label>
              <input type="text" value="\${repo.branch || ''}" placeholder="main" onchange="updateSyncRepo(\${userIndex}, \${repoIndex}, 'branch', this.value)">
            </div>
            <div class="form-group" style="margin:0;">
              <label>目标仓库</label>
              <input type="text" value="\${repo.name || ''}" placeholder="repo" onchange="updateSyncRepo(\${userIndex}, \${repoIndex}, 'name', this.value)">
            </div>
          </div>
        \`;
        container.appendChild(repoDiv);
      });
    }
    
    function addSyncUser() {
      if (!config.syncUsers) config.syncUsers = [];
      config.syncUsers.push({ name: '', token: '', repos: [] });
      renderSyncUsers();
    }
    
    function removeSyncUser(index) {
      config.syncUsers.splice(index, 1);
      renderSyncUsers();
    }
    
    function updateSyncUser(index, field, value) {
      config.syncUsers[index][field] = value;
    }
    
    function addSyncRepo(userIndex) {
      if (!config.syncUsers[userIndex].repos) config.syncUsers[userIndex].repos = [];
      config.syncUsers[userIndex].repos.push({ name: '', upstream: '', upstreamUser: '', upstreamRepo: '', branch: '' });
      renderSyncRepos(userIndex);
    }
    
    function removeSyncRepo(userIndex, repoIndex) {
      config.syncUsers[userIndex].repos.splice(repoIndex, 1);
      renderSyncRepos(userIndex);
    }
    
    function updateSyncRepo(userIndex, repoIndex, field, value) {
      config.syncUsers[userIndex].repos[repoIndex][field] = value;
    }
    
    // 上游仓库写成 owner/repo 一个框，拆开存回 upstreamUser / upstreamRepo
    function updateSyncUpstream(userIndex, repoIndex, value) {
      const repo = config.syncUsers[userIndex].repos[repoIndex];
      const cleaned = (value || '').trim()
        .replace(/^https?:\\/\\/github\\.com\\//i, '')
        .replace(/\\.git$/i, '')
        .replace(/\\/+$/, '');
      const parts = cleaned.split('/');
      repo.upstream = cleaned;
      repo.upstreamUser = parts[0] || '';
      repo.upstreamRepo = parts[1] || '';
    }
    
    // ========== 执行函数 ==========
    async function runKeepAlive() {
      showToast('正在执行保活...', 'success');
      
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: {
          'Authorization': \`Bearer \${token}\`
        }
      });
      
      const data = await res.json();
      if (data.success) {
        const resultBox = document.getElementById('keepAliveResultBox');
        const resultContent = document.getElementById('keepAliveResultContent');
        resultContent.textContent = data.result.report.join('\\n') + \`\\n\\n统计: 成功 \${data.result.successCount} / 总计 \${data.result.totalCount}\`;
        resultBox.classList.remove('hidden');
        showToast('保活执行完成！', 'success');
      } else {
        showToast(data.message || '执行失败', 'error');
      }
    }
    
    async function runSyncRepos() {
      showToast('正在同步...', 'success');
      
      const res = await fetch('/api/sync/run', {
        method: 'POST',
        headers: {
          'Authorization': \`Bearer \${token}\`
        }
      });
      
      const data = await res.json();
      if (data.success) {
        const resultBox = document.getElementById('syncResultBox');
        const resultContent = document.getElementById('syncResultContent');
        resultContent.textContent = data.result.report.join('\\n') + \`\\n\\n统计: 已同步 \${data.result.syncedCount} / 跳过 \${data.result.skippedCount} / 失败 \${data.result.failedCount}\`;
        resultBox.classList.remove('hidden');
        showToast('同步完成！', 'success');
      } else {
        showToast(data.message || '同步失败', 'error');
      }
    }
    
    async function saveConfig() {
      config.tgToken = document.getElementById('tgTokenInput').value;
      config.tgId = document.getElementById('tgIdInput').value;
      
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': \`Bearer \${token}\`
        },
        body: JSON.stringify(config)
      });
      
      const data = await res.json();
      if (data.success) {
        showToast('保存成功！', 'success');
      } else {
        showToast('保存失败', 'error');
      }
    }
    
    function showToast(message, type) {
      const toast = document.createElement('div');
      toast.className = \`toast toast-\${type}\`;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    }
    
    if (token) {
      showMainPage();
    }
  </script>
</body>
</html>
    `;
  }
};
