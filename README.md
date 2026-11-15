# Fit Extended

通过 GitHub 在手机与电脑之间同步 Obsidian 知识库。本仓库是 [joshuakto/fit](https://github.com/joshuakto/fit) 的改版分支，插件 id 为 `fit-extended`，可与原版并存安装，配置互不影响。

在上游双向同步的基础上，本分支提供**六类文件处理规则 + 统一人工审阅**。完整说明见 [README-extended.md](README-extended.md)。

## 六类文件处理规则

所有入口都作用于整个知识库，没有目录或单文件入口。每条规则都先「检查 → 生成计划 → 审阅 → 执行」。

| 规则 | 行为 |
|---|---|
| 仅补充缺失文件 | 来源有、目标没有才写入；目标已有同名文件不覆盖 |
| 单向更新 | 按共同状态把来源的改动写到目标；双方都改且不同则交你决策 |
| 单向覆盖 | 来源存在的文件一律以来源内容为准，保留目标独有文件 |
| 单向镜像 | 使目标与来源在同步范围内一致，包括删除目标独有文件 |
| 双向合并（不传播删除） | 交换新增与修改，一端缺失则补回 |
| 双向同步（传播删除） | 基于共同状态交换新增、修改与删除 |

单向四类在入口处选择方向；双向两类不设方向。

## 审阅

- 计划按「上传 / 写入本地 / 删除远端 / 删除本地」分组，可逐项勾选、全选、全部取消
- 冲突直接给出双方的大小与最后修改时间，并标出更新、更大的一侧，由你选择采用本地、采用远端或手工编辑结果
- 手工结果可以为空；双向规则写入两端，单向规则只写目标端
- 二进制文件只提供版本选择，不做文本编辑

## 忽略规则

只编辑当前仓库共享的 `.gitignore`，被匹配的路径不参与同步。本机排除、个人全局规则与跟踪状态由 Git 自行管理。

## 触发方式

- 默认手动触发；设置项「打开知识库时自动检查变化」默认关闭，开启后只生成待审计划，不自动执行
- 没有定时同步，也没有「启用整个仓库同步」的总开关

## 安装

### BRAT

1. 安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat)
2. 命令面板 → BRAT: Add a beta plugin for testing
3. 输入本仓库地址 `https://github.com/zuelwyw/fit-extended`

### 手动

把 release 中的 `main.js`、`manifest.json`、`styles.css` 复制到 `你的库/.obsidian/plugins/fit-extended/`，重启 Obsidian 并启用。

## 开发

```shell
npm install
npm run typecheck
npm test
npm run lint -- .
npm run build
```

## 许可证与来源

[MIT](LICENSE)。上游项目与作者：joshuakto/fit。
