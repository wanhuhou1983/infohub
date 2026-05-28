// @ts-nocheck
/**
 * 爬虫服务模块
 *
 * 微信公众号抓取：Python Spider (requests+bs4) → cheerio 降级 → 摘要兜底
 * MinerU 全文抓取
 */

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { readdirSync, statSync, readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MINERU_SCRIPT = process.env.MINERU_SCRIPT || path.join(
  process.env.HOME || "/root", ".workbuddy/skills/mineru-extract/scripts/mineru_extract.py"
);

// ============ 辅助函数：去除正文末尾的评论区 ============
export function stripCommentSection(content: string): string {
  const lines = content.split("\n");
  const commentMarkers = [
    /^#+\s*(网友评论|热门评论|全部评论|评论|评论区|发表评论|我来说两句)/,
    /^\*\*(网友评论|热门评论|全部评论|评论|评论区)\*\*/,
    /^【(网友评论|热门评论|精彩评论|评论)】/,
    /^分享到[：:]/,
    /^(网友评论|全部评论|热门评论)\s*$/,
  ];

  let cutIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    for (const marker of commentMarkers) {
      if (marker.test(line)) {
        cutIndex = i;
        break;
      }
    }
    if (cutIndex >= 0) break;
  }

  if (cutIndex >= 0) {
    return lines.slice(0, cutIndex).join("\n").trim();
  }
  return content;
}

// ============ MinerU 全文抓取 ============
export async function crawlArticleContent(articleUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    const args = [MINERU_SCRIPT, articleUrl, "--model", "MinerU-HTML", "--print"];
    let proc: any;
    try {
      proc = spawn("python3", args, {
        cwd: path.dirname(MINERU_SCRIPT),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resolve(null);
      return;
    }

    proc.on("error", () => { resolve(null); });

    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      console.warn(`[MinerU] 超时，强制终止: ${articleUrl}`);
      proc.kill("SIGTERM");
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already dead */ } }, 3000);
      resolve(null);
    }, 30000);

    const MAX_OUTPUT = 10 * 1024 * 1024;
    proc.stdout.on("data", (data: any) => {
      stdout += data.toString();
      if (stdout.length > MAX_OUTPUT) { proc.kill("SIGKILL"); stdout = stdout.slice(0, MAX_OUTPUT); }
    });
    proc.stderr.on("data", (data: any) => { stderr += data.toString(); });

    proc.on("close", (code: number) => {
      clearTimeout(timeout);
      if (code !== 0 || !stdout.trim()) {
        console.error(`MinerU error: ${stderr}`);
        resolve(null);
        return;
      }
      let content = stdout
        .replace(/!\[.*?\]\((https?:\/\/[^)]+)\)/g, "__IMG__$1__IMG__")
        .replace(/<img.*?src=["'](https?:\/\/[^"']+)["'].*?>/g, "__IMG__$1__IMG__");
      content = stripCommentSection(content);
      resolve(content);
    });
  });
}

// ============ 微信公众号文章抓取（Python Spider + cheerio 降级） ============
export async function crawlWechatArticle(articleUrl: string): Promise<{ title: string; content: string; author: string; publishDate: string } | null> {
  // ---- 第一层：Python Spider（requests + BeautifulSoup，解析质量更高） ----
  try {
    const spiderScript = path.resolve(__dirname, "../spider/wechat_spider.py");
    if (existsSync(spiderScript)) {
      const result = await new Promise<string>((resolve) => {
        const proc = spawn("python3", [spiderScript, articleUrl], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        proc.on("close", () => resolve(stdout));
        proc.on("error", () => resolve(""));
        setTimeout(() => { try { proc.kill(); } catch {}; resolve(""); }, 30000);
      });

      if (result) {
        try {
          const data = JSON.parse(result);
          if (data.title && data.content && data.content.length > 20) {
            let content = data.content;
            // Convert markdown images to __IMG__ markers for processImages
            content = content.replace(/!\[(.*?)\]\((.+?)\)/g, "__IMG__$2__IMG__");
            content = content.replace(/<img.*?src=["'](.+?)["'].*?>/g, "__IMG__$1__IMG__");
            content = stripCommentSection(content);
            console.log("[WeChat spider] OK: " + data.title.slice(0, 40));
            return {
              title: data.title,
              content,
              author: data.author || "",
              publishDate: data.publish_date || "",
            };
          }
        } catch { /* parse failed, fall through to cheerio */ }
      }
    }
  } catch { /* spider not available */ }

  // ---- 第二层：cheerio 直接解析（降级方案） ----
  try {
    const resp = await fetch(articleUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": "https://mp.weixin.qq.com/",
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    const $ = cheerio.load(html);

    const title = $("#activity-name").text().trim()
      || $("meta[property=\"og:title\"]").attr("content")?.replace(/^\d+[：:]\s*/, "") || "";
    const author = $("#js_author_name").text().trim()
      || $('meta[name="author"]').attr("content") || "";
    const publishDate = $("#publish_time").text().trim() || "";
    const summary = $('meta[property="og:description"]').attr("content") || "";

    const $content = $("#js_content");
    if ($content.length === 0) {
      console.warn("[WeChat cheerio] no js_content, returning summary only");
      return { title, content: summary, author, publishDate };
    }

    const convert = (el: any): string => {
      const out: string[] = [];
      el.contents().each(function (this: any) {
        const node = $(this);
        const tag = (this.tagName || "").toLowerCase();
        const text = node.text().trim();
        if (this.type === "text") {
          const raw = (this.data || "").trim();
          if (raw) out.push(raw);
        } else if (tag === "br") {
          out.push("\n");
        } else if (tag === "img" || (this.attribs && this.attribs["data-src"])) {
          const src = node.attr("data-src") || node.attr("src") || "";
          if (src && !src.startsWith("data:")) out.push("\n__IMG__" + src + "__IMG__\n");
        } else if (tag === "pre") {
          const code = node.text().replace(/\n$/, "");
          if (code) out.push("\n```\n" + code + "\n```\n");
        } else if (tag === "code") {
          const code = node.text();
          if (code) out.push("`" + code + "`");
        } else if (tag === "li") {
          out.push("- " + text + "\n");
        } else if (tag === "p" || tag === "section" || tag === "blockquote") {
          if (text) out.push("\n" + text + "\n");
        } else if (tag.match(/^h[1-6]$/)) {
          if (text) out.push("\n" + "#".repeat(parseInt(tag[1])) + " " + text + "\n");
        } else if (tag === "hr") {
          out.push("\n---\n");
        } else if (this.type === "tag") {
          out.push(convert(node));
        }
      });
      return out.join("");
    };

    let content = convert($content)
      .replace(/\n{4,}/g, "\n\n")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/\u00A0/g, " ")
      .trim();

    console.log("[WeChat cheerio] OK: " + title.slice(0, 40));
    return { title, content: content || summary, author, publishDate };
  } catch (e: any) {
    console.warn("[WeChat fetch] failed: " + e.message);
    return null;
  }
}
