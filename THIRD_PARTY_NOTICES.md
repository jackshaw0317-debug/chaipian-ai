# 第三方软件声明

拆片 AI 建立在多个开源项目和外部服务之上。各组件继续适用其原始许可证和服务条款。

## 随应用安装的主要依赖

- Next.js、React、React DOM；
- vinext、Vite 与 Cloudflare Vite 插件；
- Drizzle ORM 与 Drizzle Kit；
- Tailwind CSS；
- ESLint、TypeScript 及相关类型包。

精确版本以 `package-lock.json` 为准。安装依赖后，可在对应 `node_modules/<package>/LICENSE` 中查看许可证原文。

## 本机可选组件

- [yt-dlp](https://github.com/yt-dlp/yt-dlp)：用于读取用户有权处理的公开视频或音视频。项目源代码采用 The Unlicense；其可执行发行物可能包含采用其他许可证的第三方组件。
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper)：本机 Whisper 推理实现，采用 MIT License。
- [CTranslate2](https://github.com/OpenNMT/CTranslate2)：由 faster-whisper 使用，采用 MIT License。
- [NumPy](https://numpy.org/)：用于本机音频数组处理，采用 BSD-3-Clause License。

这些本机组件通过 `npm run local:setup` 下载到 `.local-tools/`，不会提交到仓库，也不包含在本项目源代码中。

## 可选外部服务

项目可以接入 Groq、DeepSeek、OpenAI 和已获授权的 Cobalt 服务。它们不是本项目的一部分，使用时应分别遵守对应服务条款、价格、数据政策和内容规则。

如发现声明遗漏或许可证信息需要更新，请创建 Issue。
