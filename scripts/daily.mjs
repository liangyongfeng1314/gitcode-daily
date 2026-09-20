#!/usr/bin/env node
/**
 * GitCode 每日任务脚本
 * 功能：每日签到 + 获取热门/推荐项目 + Star 一个未 Star 的热门项目
 *
 * 用法：
 *   node daily.mjs                  # 完整流程（自取 Cookie + 签到 + 热门列表 + Star 一个）
 *   node daily.mjs --no-star        # 只签到 + 看热门列表，不 Star
 *   node daily.mjs --no-refresh     # 跳过"自取 Cookie"步骤（直接用现有 Cookie 文件）
 *   node daily.mjs --no-browser     # 跳过浏览器辅助步骤（无浏览器环境 / CI 用）
 *   node daily.mjs --report-only    # 只看签到状态和热门列表，不做任何写操作
 *
 * 无头环境（服务器 / CI）推荐组合：--no-refresh --no-browser，
 * 此时凭据从 GITCODE_COOKIE_FILE 指向的文件读取，不再依赖浏览器配置目录。
 *
 * Cookie 来源：默认每次运行先调用 refresh_cookie.mjs，从专用浏览器配置目录
 * （~/.workbuddy/gitcode-browser）里导出最新 Cookie 并写回
 * ~/.workbuddy/gitcode-cookie.txt；导出失败时回退到现有文件内容。
 * 配置目录中的会话失效时，脚本会提示用户运行 scripts/gitcode-login.bat 登录一次。
 */
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const args = process.argv.slice(2);
const NO_STAR = args.includes('--no-star');
const REPORT_ONLY = args.includes('--report-only');
const NO_REFRESH = args.includes('--no-refresh');
const NO_BROWSER = args.includes('--no-browser');
const PER_PAGE = 15;

const cookieFile = process.env.GITCODE_COOKIE_FILE || join(homedir(), '.workbuddy', 'gitcode-cookie.txt');

const BASE = 'https://web-api.gitcode.com';
const H = {
  'Accept': 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  'Origin': 'https://gitcode.com',
  'Referer': 'https://gitcode.com/',
  'Cookie': '',
  'X-App-Channel': 'gitcode-fe',
  'X-App-Version': '0',
  'X-Device-Type': 'Windows',
  'X-Platform': 'web',
};

const notes = [];   // 非致命提示（会并入报告）
function loadCookie() {
  H['Cookie'] = existsSync(cookieFile) ? readFileSync(cookieFile, 'utf8').trim() : '';
}

/** 从专用浏览器配置目录自取 Cookie（失败不中断，返回状态字符串） */
function refreshCookie() {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'refresh_cookie.mjs');
  if (!existsSync(script)) return 'SKIP: 未找到 refresh_cookie.mjs';
  try {
    const r = spawnSync(process.execPath, [script, '--quiet'], { encoding: 'utf8', timeout: 180000 });
    const out = ((r.stdout || '') + (r.stderr || '')).trim();
    const result = (out.match(/RESULT: (\S+)/) || [])[1] || (r.status === 0 ? 'OK' : 'ERROR');
    const reason = (out.match(/REASON: (.*)/) || [])[1] || '';
    if (result === 'OK') {
      loadCookie();
      return 'OK';
    }
    if (out.includes('NEED_LOGIN')) {
      notes.push('专用浏览器配置目录的登录态已失效，请运行 scripts/gitcode-login.bat 登录一次（之后即可长期自动运行）。');
      return 'NEED_LOGIN';
    }
    return result + (reason ? ': ' + reason : '');
  } catch (e) {
    return 'ERROR: ' + e.message;
  }
}


async function call(method, url, body) {
  const opt = { method, headers: H };
  if (body) opt.body = JSON.stringify(body);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, opt);
      return { status: r.status, text: await r.text() };
    } catch (e) {
      if (attempt === 2) return { status: 0, text: 'NETWORK_ERROR: ' + e.message };
      await new Promise(res => setTimeout(res, 1500));
    }
  }
}

const lines = [];
const section = (t) => lines.push('\n## ' + t);

// ---------- 0. 自取 Cookie（从专用浏览器配置目录导出最新登录态） ----------
if (!NO_REFRESH) {
  const r0 = refreshCookie();
  if (r0 !== 'OK') notes.push('自取 Cookie 未成功（' + r0 + '），本次沿用现有 Cookie 文件。');
}
if (!existsSync(cookieFile)) {
  console.error('[ERROR] Cookie 文件不存在: ' + cookieFile);
  console.error('请运行 scripts/gitcode-login.bat 登录一次，或手动复制 Cookie 保存到该路径。');
  process.exit(2);
}
loadCookie();

// ---------- 1. 签到 ----------
section('每日签到');
let st = await call('GET', `${BASE}/uc/api/v1/task/v2/sign_status`);
if ((st.status !== 200 || !st.text.trim()) && !NO_REFRESH) {
  // 鉴权失败：自动再自取一次 Cookie 后重试
  const r1 = refreshCookie();
  if (r1 === 'OK') st = await call('GET', `${BASE}/uc/api/v1/task/v2/sign_status`);
  else notes.push('鉴权失败后自动重新获取 Cookie 也失败（' + r1 + '）。');
}
if (st.status !== 200 || !st.text.trim()) {
  // 云端（GitHub Actions）与本机的失效原因不同：云端用的是 Secret 里的静态快照，
  // 一旦本机 Cookie 被刷新，云端那份就会过期。给出各自可执行的修复路径。
  // 同时输出 HTTP 状态码 —— 用于区分「凭据过期」（401/403）与「网络抖动」（0/超时）。
  lines.push('签到状态查询失败（HTTP ' + st.status + (st.status === 0 ? ' ＝ 网络错误' : '') + '）。');
  lines.push('响应摘要: ' + ((st.text || '(空响应)').trim().slice(0, 200)));
  if (process.env.GITHUB_ACTIONS) {
    lines.push('当前在 GitHub Actions 中运行 —— Secret 里的 GITCODE_COOKIE 已失效（本机 Cookie 更新后未同步）。');
    lines.push('修复：在本机执行 node scripts/sync-secret.mjs --force 把最新 Cookie 同步上去。');
    lines.push('（本机每日任务是自动同步的；若同步后仍失败，说明本机 Cookie 也需重新登录一次。）');
  } else {
    lines.push('请重新从浏览器复制 Cookie 并更新 ' + cookieFile + '，或运行 scripts/gitcode-login.bat 登录一次。');
  }
  console.log(lines.join('\n'));
  process.exit(1);
}
let status;
try { status = JSON.parse(st.text); } catch {
  lines.push('签到状态解析失败: ' + st.text.slice(0, 200));
  console.log(lines.join('\n'));
  process.exit(1);
}
if (status.is_sign_in) {
  lines.push(`今日已签到，连续第 ${status.award_index} 天。连续签到奖励梯度: ${JSON.stringify(status.scores)}`);
} else if (REPORT_ONLY) {
  lines.push('今日未签到（--report-only 模式，未执行签到）。');
} else {
  const r = await call('POST', `${BASE}/uc/api/v1/task/sign-in`);
  if (r.status === 200) {
    lines.push(`签到成功 +${status.scores[status.award_index - 1] ?? 7} 积分（连续第 ${status.award_index + 1} 天）。`);
  } else {
    // 实测会返回 400 "点得太快了"，但服务端其实已经签到成功 —— 回查状态再判定。
    await new Promise(res => setTimeout(res, 3000));
    const re = await call('GET', `${BASE}/uc/api/v1/task/v2/sign_status`);
    let reStatus = null;
    try { reStatus = JSON.parse(re.text); } catch {}
    if (reStatus && reStatus.is_sign_in) {
      lines.push(`签到成功 +${reStatus.scores[reStatus.award_index - 1] ?? 7} 积分（连续第 ${reStatus.award_index} 天）。接口返回 HTTP ${r.status}，但状态回查确认已签到。`);
    } else {
      lines.push(`签到失败 HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    }
  }
}

// ---------- 2. 每日任务状态（先取，供后续步骤判断） ----------
// 每日任务（period=4）状态: 0=已完成待领取 1=已完成已领取 2=未完成
let dailyTasks = [];
const listUrl = `${BASE}/uc/api/v1/task/?type=1&limit=50`;
const list = await call('GET', listUrl);
if (list.status === 200) {
  try { dailyTasks = (JSON.parse(list.text).content || []).filter(t => t.period === 4); } catch {}
}
const VIEW_TASK_ID = 59;  // daily-view-recommended 每日查看热门/推荐项目
const STAR_TASK_ID = 62;  // daily-star-project 每日Star一个项目

// ---------- 3. 热门项目 ----------
section('GitCode 热门项目 TOP' + PER_PAGE + '（按 Star 数）');
const hot = await call('GET', `${BASE}/api/v2/projects?order_by=star_count&sort=desc&page=1&per_page=${PER_PAGE}`);
let candidates = [];
if (hot.status === 200) {
  try {
    const j = JSON.parse(hot.text);
    candidates = (j.content || []).filter(p => !p.starred);
    for (const p of (j.content || [])) {
      const mark = p.starred ? '[已Star]' : '';
      lines.push(`${mark}${p.path_with_namespace} | ${p.star_count}★ | ${(p.description || '').slice(0, 60)}`);
    }
  } catch {
    lines.push('热门列表解析失败: ' + hot.text.slice(0, 200));
  }
} else {
  lines.push(`热门列表获取失败 HTTP ${hot.status}: ${hot.text.slice(0, 200)}`);
}

// ---------- 4. Star 一个项目（若今日 Star 任务已完成则跳过） ----------
const starTask = dailyTasks.find(t => t.task_id === STAR_TASK_ID);
if (starTask && starTask.status !== 2 && !REPORT_ONLY) {
  section('今日 Star');
  lines.push(`今日 Star 任务已完成（${starTask.status === 0 ? '待领取' : '已领取'}），跳过。`);
} else if (!NO_STAR && !REPORT_ONLY && candidates.length > 0) {
  section('今日 Star');
  const target = candidates[0];
  const res = await call('POST', `${BASE}/api/v2/projects/${target.id}/star`, { repoId: target.id });
  if (res.status === 200) {
    let newCount = '';
    try { newCount = JSON.parse(res.text).star_count; } catch {}
    lines.push(`已 Star: ${target.path_with_namespace}（${target.star_count}★${newCount ? ' -> ' + newCount + '★' : ''}）`);
    lines.push(`链接: ${target.web_url || 'https://gitcode.com/' + target.path_with_namespace.replace(/ /g, '')}`);
    lines.push(`简介: ${(target.description || '无').slice(0, 120)}`);
  } else {
    lines.push(`Star 失败 HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  }
} else if (candidates.length === 0 && !NO_STAR && !REPORT_ONLY) {
  section('今日 Star');
  lines.push('TOP15 全部已 Star，无需操作。');
}

// ---------- 5. 查看热门任务 + 领取奖励 ----------
section('每日任务与奖励');

const viewTask = dailyTasks.find(t => t.task_id === VIEW_TASK_ID);
if (viewTask && viewTask.status === 2 && !REPORT_ONLY && !NO_BROWSER) {
  const helper = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'view_project.mjs');
  console.error('[info] 运行浏览器辅助脚本完成"查看热门项目"任务...');
  const r = spawnSync(process.execPath, [helper], { timeout: 300000, encoding: 'utf8' });
  console.error((r.stdout || '').trim());
  // re-fetch task state
  const l2 = await call('GET', `${BASE}/uc/api/v1/task/?type=1&limit=50`);
  if (l2.status === 200) {
    try { dailyTasks = (JSON.parse(l2.text).content || []).filter(t => t.period === 4); } catch {}
  }
}

for (const t of dailyTasks) {
  if (t.status === 0 && !REPORT_ONLY) {
    const c = await call('POST', `${BASE}/uc/api/v1/task/${t.task_id}/points`);
    const ok = c.status === 200 && c.text.trim() === 'true';
    lines.push(`${ok ? '✅ 已领取' : '❌ 领取失败'}: ${t.cn_name}（+${t.score}积分）${ok ? '' : ' ' + c.text.slice(0, 80)}`);
  } else if (t.status === 0 && REPORT_ONLY) {
    lines.push(`待领取: ${t.cn_name}（+${t.score}积分）`);
  } else if (t.status === 2) {
    lines.push(`未完成: ${t.cn_name}（${t.description.trim().slice(0, 30)}）`);
  }
}

if (notes.length) {
  section('提示');
  for (const n of notes) lines.push('- ' + n);
}

console.log(lines.join('\n'));
