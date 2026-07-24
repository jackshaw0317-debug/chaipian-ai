# 拆片 AI

粘贴视频链接，自动提取音频、通过 OpenAI Whisper 生成带时间轴字幕，再由 GPT 输出结构化内容拆解。

## 功能

- 支持可直接访问的音频、视频链接
- 可接入自建或已获授权的 Cobalt API，处理常见平台链接
- Whisper 字幕转写与 SRT 下载
- GPT 内容摘要、评分、结构、高光表达、复用句式与优化建议
- 内置演示模式，无需配置即可体验完整界面

## 配置

复制 `.env.example` 为 `.env.local`，至少填写 `OPENAI_API_KEY`。

平台视频链接还需要配置 `COBALT_API_URL`。请使用你自建的实例，或确保已获得实例所有者授权；不要直接把公共 Cobalt 实例当作第三方项目接口。

## 本地运行

Windows PowerShell：

```powershell
$env:WRANGLER_LOG_PATH=".wrangler\wrangler.log"
.\node_modules\.bin\vinext.cmd dev
```

默认访问 `http://localhost:3000/`。

## 使用边界

仅下载和处理你拥有权利或已获授权的内容。当前单次音频限制为 24 MB，以适配 Whisper API 的请求大小限制。
