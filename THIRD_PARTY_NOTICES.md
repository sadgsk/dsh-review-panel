# Third-party notices

The following components are distributed with, embedded in, or adapted by dsh-review-panel. Their original notices and license terms are retained in this package.

| Component | Source and attribution | Included license / notices |
| --- | --- | --- |
| Monaco Editor AMD distribution and codicon font | Microsoft Corporation; copied from the Monaco assets distributed with `dsh-vscode-mode@0.15.9` | [LICENSE](assets/vendor/monaco/LICENSE), [ThirdPartyNotices.txt](assets/vendor/monaco/ThirdPartyNotices.txt) |
| Inline diff / Monaco loader reference implementation | [dsh-vscode-mode](https://github.com/Lenonss/DSH_VsCodeMode), copyright (c) 2026 LiuZiLong | [MIT license](licenses/dsh-vscode-mode-LICENSE) |
| VS Code Seti icon theme data | [vscode-theme-seti](https://github.com/microsoft/vscode/tree/main/extensions/theme-seti), copyright (c) Microsoft Corporation | [MIT license](licenses/vscode-theme-seti-LICENSE) |
| Embedded Seti icon font and artwork | [seti-ui](https://github.com/jesseweed/seti-ui), copyright (c) 2014 Jesse Weed | [Original Seti notice and MIT license](licenses/vscode-theme-seti-ThirdPartyNotices.txt) |

The generated Seti theme data and embedded WOFF are part of `lib/client.js` (source: `src/client/12-vscode-icons.js`). The original VS Code theme associates these assets with Seti UI revision `2d6c5e68b4ded73c92dac291845ee44e1182d511`.
