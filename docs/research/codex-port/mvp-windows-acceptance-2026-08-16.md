# Windows Codex 一手实测(2026-08-16,经 WSL interop 跑 Windows codex.exe 0.147.0)

> 环境:`C:\Users\Xiao\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe`,隔离 `CODEX_HOME=C:\Users\Xiao\AppData\Local\Temp\pace-codex-win\home`(经 `cmd.exe /c "set CODEX_HOME=… && codex.exe …"` 传入;auth.json 从用户 Windows ~/.codex 复制),`codex plugin marketplace add K:\AI\paceflow-hooks\paceflow`(直接读仓库根 `.claude-plugin/marketplace.json`)→ `codex plugin add paceflow@paceaitian-paceflow`。测试项目在 `%TEMP%\pace-codex-win\proj*`,`set-artifact-root --choice local` 启用。**测完整目录已删除,用户真实 `~/.codex/config.toml` mtime 未变、无 paceflow 条目。**

## 结论

| # | 问题(来自 CHG-01 审计 P2-7 / finding windows-untested) | Windows 实测 |
|---|---|---|
| W1 | `hooks.codex.json` 里 `node "${CLAUDE_PLUGIN_ROOT}/hooks/codex-adapter.js" …` 在 Windows 能否展开/执行 | ✅ **全部触发且 Completed**:SessionStart(CREATE_TEMPLATES + INJECT ×2)、UserPromptSubmit INJECT、PreToolUse(Bash/apply_patch/mcp__paceflow__*)、PostToolUse、Stop 全部有日志;不需要 `commandWindows`(Codex 在 Windows 也把 `${CLAUDE_PLUGIN_ROOT}` 展开了) |
| W2 | MCP server 能否在 Windows 拉起并拿到上下文 | ✅ 拉起;但 **`_meta["x-codex-turn-metadata"]` 在 Windows 缺 `workspaces`**(passthrough 工具 `reserve_artifact_id` 首次报 `no-context: 无法确定项目 cwd`)→ 修复:adapter 对 passthrough 工具也 `updatedInput` 注入 `_pace_cwd/_pace_session_id`;修后 reserve/create/approve/close 全部成功 |
| W3 | Stop 阻断形态 | ❌ **exit 2 + stderr 在 Windows Codex 被记为 `hook: Stop Failed` 且不阻断**(三形态探针:`process.exit(2)` / `exitCode=2` 都 Failed;JSON `{"decision":"block","reason"}` → `Stop Blocked` 并续跑)。Linux 两种都认。→ 修复:adapter 把真 hook 的 exit 2 统一翻译成 JSON block(PreToolUse → `permissionDecision:"deny"`,Stop/UPS → `decision:"block"`),exit 0;修后 Windows 上 in-progress CHG 未收口 → `Stop Blocked ×3 → DOWNGRADE`(与 Linux/Claude 同语义) |
| W4 | 完整闭环 | ✅ reserve → create_chg → approve-and-start → apply_patch 建 hello.js → `node hello.js` 输出 hi → close_chg → status archived、task.md 移 ARCHIVE、walkthrough 行、Stop Completed(与 Linux T-003 存档同构) |
| W5 | 副作用/清理 | `codex plugin add` 重装时若上一次 `codex exec` 进程未退出(timeout 杀 cmd 不杀子进程)会 `os error 32/5` 拷贝失败——用 `taskkill /PID` 清掉后重装即可;插件缓存按 version 目录,同版本重装会覆盖 |

## 备注
- Windows 侧模型 shell 是 PowerShell(`python` 不在 PATH,改用 `node hello.js` 验证)。
- `codex.exe exec` 的 prompt 走 stdin(`type prompt.txt | codex.exe exec … -`)避免 cmd 引号地狱。
- 本轮修复 commit:28853ae(adapter exit2→JSON、passthrough 注参、emit 去 process.exit)。
