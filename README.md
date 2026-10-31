# pi-hermes-memory-bridge

让本机已经安装的 [pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory) 成为多个 Agent 共用的记忆引擎。Cursor、Claude Code、Codex、CodeBuddy、WorkBuddy、DeepSeek Harness 读写同一份记忆，历史对话也能互相搜索。Pi 本身直接加载这个扩展，不经过本仓库。

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

## 接入 Claude Code

注册为用户级 MCP，所有项目可用：

```bash
claude mcp add-json --scope user hermes-memory "$(cat examples/claude-mcp-server.json)"
claude mcp get hermes-memory
```

不传 `--cwd`。Claude Code 在会话启动目录拉起 stdio 服务，服务未拿到 `--cwd` 时用进程目录作为默认工作区，所以项目记忆跟随当前 Claude 会话的目录。调用时传 `cwd` 仍然优先。

Claude Code 没有接入学习进程，它的对话不会写入 `sessions.db`，`session_search` 只能搜到其他 Agent 的会话。Claude 会把服务说明截断到 4096 字符，末尾的工具清单可能被截掉，不影响工具发现。

## 搜索过滤

扩展只给 `failure` 条目存 `category`，普通记忆和项目记忆没有这个字段。模型带上 `category` 或写错 `project` 时，`memory_search` 会把这些条目滤掉。

- MCP 入口：`memory_search` 查空时，会依次去掉 `category`、`target`、`project` 重搜，见 `memory-search-loose.mjs`。
- Pi：不经过本仓库。部分模型会被要求填满所有可选参数，提示词约束不住。把 `pi-extension/pi-memory-search.ts` 复制到 `~/.pi/agent/extensions/`，作为本地扩展监听 `tool_result`，`memory_search` 返回 0 条时用扩展自己的搜索工具放宽条件重查，并替换结果。Pi 不允许两个扩展注册同名工具，所以不能直接覆盖 `memory_search`。

## 不入库的内容

`logs/`、`state/`、`tmp/`、`node_modules/` 是本机运行状态、学习日志和依赖，不包含在仓库里。
