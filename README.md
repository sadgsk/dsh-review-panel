# dsh-review-panel

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.2.1%2B-4B6BFB)](https://www.deepseek.com/download/) <br>
[English](README.en.md) · [Issues](https://github.com/sadgsk/dsh-review-panel/issues)

![代码审查：完整源码 + 行级内联 diff](docs/images/review-panel.png)

## 这是什么

`dsh-review-panel` 把 **Cursor 式的代码审查体验**带进 DeepSeek Harness：在官方右侧栏里加一个只读的「代码审查」页，用完整源码 + 行级内联 diff 展示 Agent 本轮改了什么，并把常用的 **VS Code 快捷键操作**搬了过来。

DSH 自带的审查是一个个 hunk 片段；这个插件给的是**整个文件**——新增行整行着色，删除行按原行号内联显示，配合文件树、编辑器标签页和键盘操作，像在编辑器里 review 一样。

- **完整源码 + 行级内联 diff**：新增行整行着色，删除行内联保留原行号
- **三种对比基线**：`Agent 本轮` / `Git 未提交` / `仅代码`，一键切换
- **VS Code 式工作区**：文件树、编辑器标签页、Quick Open（Ctrl+P）、命令面板、工作区搜索
- **语言服务导航**：F12 跳转定义、Shift+F12 查找引用、悬停提示、文档大纲、只读诊断
- **只读安全**：不写文件、不提交 Git、不静默安装任何东西；需要操作时交给 DSH Agent
- **自动跟随 DSH 明暗主题**

## 安装

需要 **DSH 0.2.1-rc.2** 或更高版本（Desktop 与 Web 均可）。Git 与语言服务器都是可选项，缺失时自动降级。

### 1. 打开插件页

在 DSH 左侧栏打开 **插件**，点右上角的 **添加插件**：

![在插件页点击添加插件](docs/images/install-plugins-page.png)

### 2. 粘贴仓库地址并安装

在输入框里粘贴本仓库地址（`https://github.com/sadgsk/dsh-review-panel`），点 **安装**：

![添加插件对话框](docs/images/install-dialog.png)

### 3. 打开代码审查

安装完成后按提示重启 DSH。之后在右侧栏点 **+**，选择 **代码审查** 即可：

![在右侧栏 + 菜单里打开代码审查](docs/images/entry-plus-menu.png)

如果预览入口还没出现，也可以点击聊天输入框上方的「本轮修改」直接打开。

## 快捷键

所有命令都注册在 DSH 官方快捷键服务里，可在 **设置 → 通用 → 键盘快捷键** 中重新绑定。macOS 上把 `Ctrl` 换成 `Cmd`；个别组合被系统占用时会显示为未绑定，此时可在设置里改绑。

| 操作 | Windows / Linux | macOS |
| --- | --- | --- |
| 打开代码审查 | `Ctrl+Alt+D` | `Cmd+Option+D` |
| 上一处 / 下一处改动 | `Shift+F7` / `F7` | `Shift+F7` / `F7` |
| 快速打开文件 | `Ctrl+P`（被占用时 `Ctrl+Alt+P`） | `Cmd+P`（被占用时 `Cmd+Option+P`） |
| 命令面板 | `Ctrl+Shift+P` | `Cmd+Shift+P` |
| 工作区搜索 | `Ctrl+Shift+F` | `Cmd+Shift+F` |
| 跳转到行 | `Ctrl+G` | `Cmd+G` |
| 下一个 / 上一个标签页 | `Ctrl+Tab` / `Ctrl+Shift+Tab` | `Cmd+Tab` / `Cmd+Shift+Tab` |
| 关闭标签页 | `Ctrl+F4` | `Cmd+F4` |
| 显示 / 隐藏文件树 | `Ctrl+Shift+E` | `Cmd+Shift+E` |
| 文档大纲 | `Ctrl+Shift+O` | `Cmd+Shift+O` |
| 编辑器内查找 | `Ctrl+F` | `Cmd+F` |
| 跳转定义 | `F12` / `Ctrl+单击` | `F12` / `Cmd+单击` |
| 查找引用 | `Shift+F12` | `Shift+F12` |
| 折叠 / 展开代码块 | `Ctrl+Shift+[` / `Ctrl+Shift+]` | `Cmd+Option+[` / `Cmd+Option+]` |
| 全部折叠 / 全部展开 | `Ctrl+K Ctrl+0` / `Ctrl+K Ctrl+J` | `Cmd+K Cmd+0` / `Cmd+K Cmd+J` |
| 字号缩放 | `Ctrl+滚轮` / `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | `Cmd+滚轮` / `Cmd+=` / `Cmd+-` / `Cmd+0` |

导航后退 / 前进默认不占用按键，可在设置里自行绑定。

## 反馈

使用中遇到问题、有功能建议，或者想分享使用体验，欢迎提 [Issue](https://github.com/sadgsk/dsh-review-panel/issues)。

## License

采用 [MIT](LICENSE) 许可。第三方组件与对应许可见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。
