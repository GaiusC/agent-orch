# Agent Orch Auditor

Auditor is a local, manual-refresh viewer for projects, plans, execution and Git.
The current interface is served from `dashboard/scripts/workspace.html`.

## Language / 界面语言

Use **EN / 中文** in the header to switch between English and Simplified Chinese.
The browser remembers the choice in `agentOrchWorkspaceLanguage` for the same
local origin (host and port). Switching language uses the existing snapshot;
it does not refresh Git or execution data. Project names, plan content, commit
messages, diffs, reports and raw evidence retain their original language.

点击顶部 **EN / 中文** 切换界面语言。偏好按浏览器来源（主机和端口）保存；
切换语言保留当前选择和详情，不额外刷新项目数据。名称、提交说明和原始证据保留原文。

## Desktop shortcut / 桌面快捷方式

Create or update the **Agent Orch Auditor** desktop shortcut from a PowerShell
window using the source checkout:

```powershell
& 'C:\Users\Jieli.chen22\plugins\agent-orch\dashboard\scripts\install-auditor-shortcut.ps1'
```

For a different checkout, run the script at that checkout. It derives the source
root from its own location; `-SourceRoot <path>` can override it explicitly.
`-DesktopDir <existing-directory>` supports redirected desktops or an isolated
shortcut verification. `-PreferredPort <port>` changes the starting port.

该脚本可重复运行，用于创建或更新桌面的 `Agent Orch Auditor.lnk`。更新前会备份
旧快捷方式到源码仓库的 `.agent-orchestrator/auditor-shortcut-backups/`，输出实际
备份路径，并保留原图标。更新后会重新读取快捷方式核对目标、参数和工作目录。

The shortcut targets Windows PowerShell with a hidden window and launches:

```powershell
& '<source-root>\dashboard\scripts\open-dashboard.ps1' `
    -ProjectDir '<source-root>' -PreferredPort 43188 -ProjectHome
```

It opens the **project homepage**, rather than binding the UI to one research
project. The server and its launcher come from the source checkout, never a
dated temporary output directory or an installed plugin cache. A matching
server is reused only when its version and source script path match. Otherwise
the launcher scans the next 50 ports; it does not stop an unrelated service.
Python must be available on the user's PATH.

快捷方式默认从 `43188` 端口开始寻找服务，打开项目首页。启动器位于正式源码
目录；不要再指向旧的 `Documents\Codex\<日期>\...\outputs` 临时控制脚本。
更新源码或移动仓库后，请重新运行快捷方式更新脚本。此更新不会重装 Codex 插件，
也不会替换已加载的 MCP 服务。

To verify the launch target without opening a browser:

```powershell
& '<source-root>\dashboard\scripts\open-dashboard.ps1' `
    -ProjectDir '<source-root>' -PreferredPort 43188 -ProjectHome -NoBrowser
```

The command prints `dashboard_url=...`. Open that URL to confirm the homepage.
To restore a previous shortcut, copy the reported backup over the same desktop
`Agent Orch Auditor.lnk`. This restores only the shortcut, not source or Git data.

## Project links

`/` opens project selection. `/?project=<escaped-absolute-path>` opens a specific
project; an exact supported `thread` parameter can also resolve its directory.
The top **All projects / 所有项目** action returns home. Refresh remains manual.
