#!/usr/bin/env node
/**
 * 微信公众号文章批量下载脚本
 *
 * 用法:
 *   node batch.js [urls.txt] [--images] [--delay=3000]
 *
 * 参数:
 *   urls.txt   URL 列表文件，每行一个链接，# 开头为注释（默认: ./urls.txt）
 *   --images   同时下载正文图片到本地并改写为相对路径（默认只保留图床外链）
 *   --delay=N  每篇文章之间的基础间隔毫秒数（默认 3000，实际会加 0-2000ms 随机抖动）
 *
 * 行为:
 *   - 串行逐篇提取，成功写入 ~/Downloads/wechat/{公众号名}/{标题}.md
 *   - done.log 记录已完成 URL，重跑自动跳过（断点续传）
 *   - 单篇失败重试最多 2 次（指数退避），仍失败记入 failed.log 不中断整批
 *   - 遇 1004 访问过于频繁：暂停 15 分钟重试，最多等 2 次，仍不行则中止保现场
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const TurndownService = require('turndown');
const { extract } = require('./scripts/extract.js');

// ---------- 参数解析 ----------
const args = process.argv.slice(2);
const urlFile = args.find(a => !a.startsWith('--')) || './urls.txt';
const withImages = args.includes('--images');
const delayArg = args.find(a => a.startsWith('--delay='));
const BASE_DELAY = delayArg ? parseInt(delayArg.split('=')[1], 10) : 3000;

const OUTPUT_ROOT = path.join(process.env.HOME, 'Downloads', 'wechat');
const DONE_LOG = path.join(OUTPUT_ROOT, 'done.log');
const FAILED_LOG = path.join(OUTPUT_ROOT, 'failed.log');

const MAX_RETRY = 2;               // 单篇失败重试次数
const RATE_LIMIT_WAIT = 15 * 60 * 1000; // 1004 后暂停 15 分钟
const MAX_RATE_LIMIT_WAITS = 2;    // 1004 最多等待次数
const IMAGE_DELAY = 300;           // 图片下载间隔

// 不可重试的错误码：链接过期/已删除/违规/账号类问题，重试无意义
const NON_RETRYABLE = new Set([1006, 2001, 2002, 2003, 2005, 2006, 2007, 2009, 2011, 2012, 2013, 2014, 2015, 2016]);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = () => BASE_DELAY + Math.floor(Math.random() * 2000);
const sanitize = name => (name || 'untitled').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

// ---------- 日志 ----------
function appendLog(file, line) {
  fs.appendFileSync(file, line + '\n');
}
function loadDoneSet() {
  if (!fs.existsSync(DONE_LOG)) return new Set();
  return new Set(fs.readFileSync(DONE_LOG, 'utf8').split('\n').filter(Boolean));
}

// ---------- 单篇提取（含重试与 1004 处理） ----------
async function extractWithRetry(url) {
  let rateLimitWaits = 0;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    const result = await extract(url);
    if (result.done) return result;

    // 频率限制：暂停后重试，不计入普通重试次数
    if (result.code === 1004) {
      rateLimitWaits++;
      if (rateLimitWaits > MAX_RATE_LIMIT_WAITS) {
        throw new Error('RATE_LIMITED'); // 上层中止整批
      }
      console.log(`  ⚠ 触发频率限制，暂停 15 分钟后继续（第 ${rateLimitWaits}/${MAX_RATE_LIMIT_WAITS} 次）`);
      await sleep(RATE_LIMIT_WAIT);
      attempt--; // 本次不算重试
      continue;
    }

    if (NON_RETRYABLE.has(result.code) || attempt === MAX_RETRY) {
      return result; // 失败结果交给上层记录
    }
    const backoff = 5000 * (attempt + 1);
    console.log(`  ⚠ 失败(${result.code} ${result.msg})，${backoff / 1000}s 后重试（${attempt + 1}/${MAX_RETRY}）`);
    await sleep(backoff);
  }
}

// ---------- 图片下载 ----------
async function downloadImages($, assetsDir) {
  const imgs = $('img').toArray();
  let count = 0;
  for (const el of imgs) {
    const src = $(el).attr('data-src') || $(el).attr('src');
    if (!src || !src.startsWith('http')) continue;
    try {
      const ext = (src.match(/wx_fmt=(\w+)/)?.[1] || 'png').replace('jpeg', 'jpg');
      const filename = `img-${String(count).padStart(3, '0')}.${ext}`;
      const res = await fetch(src, { headers: { Referer: 'https://mp.weixin.qq.com/' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(path.join(assetsDir, filename), Buffer.from(await res.arrayBuffer()));
      $(el).attr('src', `${path.basename(assetsDir)}/${filename}`);
      $(el).removeAttr('data-src');
      count++;
      await sleep(IMAGE_DELAY);
    } catch (e) {
      console.log(`  ⚠ 图片下载失败（保留外链）: ${src.slice(0, 60)}... ${e.message}`);
      if (src) $(el).attr('src', src); // 保底用外链
    }
  }
  return count;
}

// ---------- 保存为 Markdown ----------
async function saveArticle(data, url) {
  const accountDir = path.join(OUTPUT_ROOT, sanitize(data.account_name));
  fs.mkdirSync(accountDir, { recursive: true });

  const title = sanitize(data.msg_title);
  let mdPath = path.join(accountDir, `${title}.md`);
  if (fs.existsSync(mdPath)) {
    mdPath = path.join(accountDir, `${title}-${data.msg_sn || Date.now()}.md`); // 同名去重
  }

  const $ = cheerio.load(data.msg_content || '');
  let imgCount = 0;
  if (withImages) {
    const assetsDir = path.join(accountDir, `${path.basename(mdPath, '.md')}.assets`);
    fs.mkdirSync(assetsDir, { recursive: true });
    imgCount = await downloadImages($, assetsDir);
  } else {
    // 不下载图片时也要把 data-src 替换为真实地址，否则图片显示不出
    $('img').each((i, el) => {
      const src = $(el).attr('data-src') || $(el).attr('src');
      if (src) $(el).attr('src', src);
    });
  }

  const body = td.turndown($.html());
  const md = `---
title: "${(data.msg_title || '').replace(/"/g, '\\"')}"
author: "${data.msg_author || data.account_name}"
account: "${data.account_name}"
date: "${data.msg_publish_time_str}"
original_url: "${url}"
---

# ${data.msg_title}

> 作者：${data.msg_author || data.account_name} ｜ 公众号：${data.account_name} ｜ 发布时间：${data.msg_publish_time_str}
> 原文链接：${url}

${body}
`;
  fs.writeFileSync(mdPath, md);
  return { mdPath, imgCount };
}

// ---------- 主流程 ----------
async function main() {
  if (!fs.existsSync(urlFile)) {
    console.error(`找不到 URL 文件: ${urlFile}`);
    console.error('请创建 urls.txt，每行一个公众号文章链接');
    process.exit(1);
  }
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });

  const urls = fs.readFileSync(urlFile, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  const done = loadDoneSet();
  const todo = urls.filter(u => !done.has(u));

  console.log(`共 ${urls.length} 篇，已完成 ${urls.length - todo.length} 篇，本次待下载 ${todo.length} 篇`);
  console.log(`输出目录: ${OUTPUT_ROOT}${withImages ? '（含图片本地化）' : ''}\n`);

  let ok = 0, fail = 0;
  for (let i = 0; i < todo.length; i++) {
    const url = todo[i];
    console.log(`[${i + 1}/${todo.length}] ${url}`);
    try {
      const result = await extractWithRetry(url);
      if (!result.done) {
        console.log(`  ✗ 失败: ${result.code} ${result.msg}`);
        appendLog(FAILED_LOG, `${url}\t${result.code}\t${result.msg}`);
        fail++;
      } else {
        const { mdPath, imgCount } = await saveArticle(result.data, url);
        console.log(`  ✓ ${result.data.msg_title}${withImages ? `（图片 ${imgCount} 张）` : ''}`);
        console.log(`    → ${mdPath}`);
        appendLog(DONE_LOG, url);
        ok++;
      }
    } catch (e) {
      if (e.message === 'RATE_LIMITED') {
        console.error('\n多次触发频率限制，中止本次任务。已完成的进度已保存，稍后重跑即可续传。');
        break;
      }
      console.log(`  ✗ 异常: ${e.message}`);
      appendLog(FAILED_LOG, `${url}\tEXCEPTION\t${e.message}`);
      fail++;
    }
    if (i < todo.length - 1) await sleep(jitter());
  }

  console.log(`\n完成: 成功 ${ok}，失败 ${fail}${fail ? `（详见 ${FAILED_LOG}）` : ''}`);
}

main().catch(e => { console.error(e); process.exit(1); });
