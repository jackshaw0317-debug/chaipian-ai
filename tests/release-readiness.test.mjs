import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

const requiredCommunityFiles = [
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "THIRD_PARTY_NOTICES.md",
  "CHANGELOG.md",
  "ROADMAP.md",
  ".github/workflows/ci.yml",
  ".github/dependabot.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",
];

test("公开仓库包含发布与社区基础文件", async () => {
  await Promise.all(
    requiredCommunityFiles.map((path) => access(new URL(path, projectRoot))),
  );

  const [license, readme] = await Promise.all([
    readFile(new URL("LICENSE", projectRoot), "utf8"),
    readFile(new URL("README.md", projectRoot), "utf8"),
  ]);

  assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.match(license, /Version 3, 19 November 2007/);
  assert.match(readme, /https:\/\/jackshaw\.top/);
  assert.match(readme, /npm run local:start/);
  assert.match(readme, /AGPL-3\.0/);
  assert.doesNotMatch(readme, /OWNER\/REPOSITORY|YOUR_ACCOUNT/);
});

test("项目命名、脚本和忽略规则适合公开发布", async () => {
  const [packageText, ignore, startScript, setupScript] = await Promise.all([
    readFile(new URL("package.json", projectRoot), "utf8"),
    readFile(new URL(".gitignore", projectRoot), "utf8"),
    readFile(new URL("scripts/start-local.ps1", projectRoot), "utf8"),
    readFile(new URL("scripts/setup-local.ps1", projectRoot), "utf8"),
  ]);
  const packageJson = JSON.parse(packageText);

  assert.equal(packageJson.name, "chaipian-ai");
  assert.equal(packageJson.private, true);
  assert.equal(typeof packageJson.scripts.check, "string");
  assert.equal(typeof packageJson.scripts["local:setup"], "string");

  assert.match(ignore, /^\.env\*/m);
  assert.match(ignore, /^\/dns\/$/m);
  assert.match(ignore, /^\/\.local-tools\/$/m);
  assert.match(startScript, /scripts\/setup-local\.ps1|scripts\\setup-local\.ps1/);
  assert.match(setupScript, /faster-whisper/);
  assert.match(setupScript, /yt-dlp/);
  assert.doesNotMatch(startScript, /C:\\Users\\[^\\]+/i);
  assert.doesNotMatch(setupScript, /C:\\Users\\[^\\]+/i);
});

test("已跟踪文本文件不包含常见真实密钥", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: new URL(".", projectRoot),
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .filter((path) =>
      /\.(?:c?js|mjs|json|md|ts|tsx|py|ps1|cmd|ya?ml|example|txt)$/i.test(path),
    );

  const secretPatterns = [
    /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    /\bgsk_[A-Za-z0-9]{20,}\b/g,
    /\b(?:DEEPSEEK|GROQ|OPENAI)_API_KEY[ \t]*=[ \t]*\S+/g,
  ];

  for (const path of tracked) {
    const content = execFileSync("git", ["show", `HEAD:${path}`], {
      cwd: new URL(".", projectRoot),
      encoding: "utf8",
      maxBuffer: 5 * 1024 * 1024,
    });
    for (const pattern of secretPatterns) {
      assert.doesNotMatch(content, pattern, `${path} 疑似包含真实密钥`);
    }
  }
});
