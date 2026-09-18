# GitCode 每日任务 · GitHub Actions 部署包

把 GitCode 签到从「必须开着这台电脑」搬到 GitHub 的服务器上，每天到点自动跑，电脑关着也照跑。

---

## 一、要开通什么？

**什么都不用开通。** GitHub Actions 是 GitHub 账号自带的免费内置功能，不是需要申请的附加服务：

| 项目 | 是否需要 | 说明 |
|---|---|---|
| GitHub 账号 | ✅ 需要 | 免费 Free 计划就行 |
| 信用卡 | ❌ 不需要 | 这一点和 Oracle / 腾讯云不同 |
| 单独"开通 Actions" | ❌ 不需要 | 仓库里放 `.github/workflows/*.yml` 就会自动识别 |
| 付费 | ❌ 不需要 | 私有仓库每月送 2000 分钟；本任务每月约 30~60 分钟，占用 &lt;3% |

一个要注意的默认设置：Free 计划默认**支出上限为 $0**，额度用尽会直接停止运行，**不会产生意外账单**。

---

## 二、相关地址

| 用途 | 地址 |
|---|---|
| 新建仓库 | https://github.com/new |
| Actions 功能总览 | https://github.com/features/actions |
| 查看 Actions 用量（每月 2000 分钟剩余） | https://github.com/settings/billing |
| 某个仓库的 Actions 页面（看运行日志） | `https://github.com/<你的用户名>/<仓库名>/actions` |
| 仓库的 Actions 开关 | 仓库 → **Settings** → Actions → General → 勾选 Allow all actions |

---

## 三、四步配置

### 第 1 步：建一个私有仓库

打开 https://github.com/new

- **Repository name**：随便起，例如 `gitcode-daily`
- **Visibility**：选 **Private**（私有）—— 因为要存 Cookie，不要选公开
- 不要勾选 "Add a README file"（本地已有文件，避免推送冲突）
- 点 **Create repository**

### 第 2 步：推送本目录的文件

在本目录（`gitcode-actions/`）打开命令行，依次执行：

```bash
git init
git add -A
git commit -m "chore: GitCode 每日任务 workflow"
git branch -M main
git remote add origin git@github.com:<你的用户名>/gitcode-daily.git
git push -u origin main
```

> 本机 `~/.ssh/id_rsa.pub` 已存在，走 SSH 协议即可。若提示权限问题，把 `id_rsa.pub` 的内容加到
> https://github.com/settings/keys 的 SSH keys 里再重试。

推送后仓库里应该有这些文件：

```
.github/workflows/gitcode-daily.yml   ← 每天 09:20 自动跑
.github/workflows/keepalive.yml       ← 每月自动提交一次，防止定时被停
scripts/daily.mjs                     ← 任务脚本
```

### 第 3 步：把 Cookie 存成 Secret

1. 打开仓库 → **Settings** → 左侧 **Secrets and variables** → **Actions**
2. 点 **New repository secret**
3. **Name** 填：`GITCODE_COOKIE`
4. **Secret** 填：本机文件 `C:\Users\fafa\.workbuddy\gitcode-cookie.txt` 的**全部内容**（一整行，前后不要有空格或换行）

> 说明：Secret 内容会被 GitHub 加密存储，且**在运行日志中自动打码**，即使工作流输出了它也会显示成 `***`。
> 另外 fork 出去的仓库读不到这个 Secret。

在 Windows 上把这行内容完整复制到剪贴板的命令：

```powershell
Get-Content -Raw "$env:USERPROFILE\.workbuddy\gitcode-cookie.txt" | Set-Clipboard
```

### 第 4 步：手动跑一次验证

仓库 → **Actions** 标签页 → 左侧点 **GitCode 每日任务** → 右侧 **Run workflow** → 绿色按钮。

等 30 秒左右刷新，点进这次运行，页面底部会直接显示签到结果（签到状态、连续天数、热门榜单、Star 情况）。

**看到「今日已签到」或「签到成功」就说明部署成功了。**

---

## 四、之后怎么查看结果

- 每天点进仓库的 **Actions** 页面，就能看到当天的运行记录和完整输出
- 运行摘要里直接有签到天数、热门榜 TOP15、Star 情况、未完成任务

---

## 五、已知限制

**1. 「每日查看热门/推荐项目」任务不会在云端执行。**

这个任务纯 HTTP 无法触发，GitCode 只在真实浏览器点击时才计数，所以 CI 里用 `--no-browser` 跳过了它。
影响是每天少 10 积分，**签到和 Star 这两项主要积分不受影响**。

如需补齐，可以在 `ubuntu-latest` 上装 Chromium 并改用 Playwright 重写该步骤（后续可加）。

**2. 定时可能延迟 15~60 分钟。**

GitHub 的定时任务排队执行，整点最拥堵。所以 cron 设在 UTC 01:20（北京时间 09:20）避开整点，
实际执行时间在 09:20~10:20 之间浮动。签到不看具体分钟，无影响。

**3. 每 60 天需要一次仓库活动。**

GitHub 会自动禁用「60 天内无任何仓库活动」的定时工作流（定时运行本身不算活动）。
`keepalive.yml` 每月自动提交一次时间戳来解决这个问题，无需人工干预。

**4. Cookie 在 2027-03-17 前后过期。**

GitCode 的 `GITCODE_ACCESS_TOKEN` 有效期是 **180 天**（2026-09-18 实测），且站点不会自动轮换，
所以到期后需要从本机浏览器重新导出一次，再更新第 3 步的 Secret。
到期前表现为签到状态接口返回 401 或空响应。

---

## 六、和本机任务的关系

本机原有两条执行路径（Windows 任务计划 `GitCode-Daily` 每天 09:30、WorkBuddy 自动化每天 10:30 兜底）
**可以保留，也可以关掉**。脚本是幂等的——同一天重复运行不会重复签到、不会重复 Star、不会重复领奖，
所以留着当双保险也没有副作用。

想彻底改成云端唯一执行，关掉 Windows 任务计划任务即可。

---

## 七、脚本与技能目录的关系

`scripts/daily.mjs` 是从本机技能目录复制过来的副本（源：`~/.workbuddy/skills/gitcode-daily/scripts/daily.mjs`）。
如果以后改了技能里的脚本，需要重新复制一次并推送：

```powershell
Copy-Item "$env:USERPROFILE\.workbuddy\skills\gitcode-daily\scripts\daily.mjs" .\scripts\daily.mjs -Force
git add -A; git commit -m "chore: 同步脚本"; git push
```
