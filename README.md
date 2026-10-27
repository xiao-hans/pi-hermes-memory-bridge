# pi-hermes-memory-bridge

让本机已经安装的 [pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory) 成为多个 Agent 共用的记忆引擎。Cursor、Codex、CodeBuddy、WorkBuddy、DeepSeek Harness 读写同一份记忆，历史对话也能互相搜索。Pi 本身直接加载这个扩展，不经过本仓库。

桥接只做适配，不复制记忆库，也不修改扩展源码。加锁、条目格式、全文索引和后台回顾都走扩展自己的实现。

## 两个入口

| 入口 | 作用 |
|---|---|
| `server.mjs` | MCP 服务。暴露 `memory_search`、`memory_add`、`memory_replace`、`memory_remove`、`session_search`、`skill_manage` |
| `learner.mjs` | 后台学习。把各 Agent 的会话重放成扩展的事件，由扩展自己决定何时回顾、写入 |

会话写入 `sessions.db` 时带来源前缀：`cursor-`、`dsh-`、`codex-`、`codebuddy-`、`workbuddy-`。Pi 的会话保持原生日志号。记忆正文（`MEMORY.md`、`USER.md`、`failures.md`）不记录是哪个 Agent 写的。

## 运行

使用安装了 `pi-hermes-memory` 和 `pi-coding-agent` 的 Node。在这台机器上是 `C:\nvm4w\nodejs\node.exe`。

```bash
node server.mjs --cwd <工作区绝对路径>
node server.mjs --learner
node learner.mjs
```

`--learner` 会在 MCP 服务存活期间拉起并保活学习进程。DeepSeek Harness、Codex、CodeBuddy、WorkBuddy 没有 Cursor 那种对话钩子，学习进程改为轮询它们的本地会话日志。

调用记忆工具时带上当前工作区的绝对路径 `cwd`，项目记忆才会落到对应项目。

## 不入库的内容

`logs/`、`state/`、`tmp/`、`node_modules/` 是本机运行状态、学习日志和依赖，不包含在仓库里。
