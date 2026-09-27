---
name: meteor-hardware-prepare
description: Chief 在新仓库初始化或设备、编译器、测量环境改变后使用。通过官方搜索与设备诊断建立当前硬件的执行 IR 模型，按 op/dtype 选择装配模板，再启动研究。
---

# Chief 硬件与执行模型准备

## 一次准备，共享原语

Chief 为整个 workspace 完成设备探测、环境准备和硬件原语定义。准备有效时，所有 subagent 直接复用同一模型、证据和环境；新增研究或 op/dtype 不触发重复探测。装配模板由 Chief 按 op/dtype 选择，同目标的后续研究复用。

Chief 准备的是有证据的资源、原语及约束。subagent 使用这些原语，自己编写各个 kernel 需要的计算图和执行中间表达，再实现与测量；不要让每个 subagent 重新准备环境或定义一套原语。研究快照是共享准备的固定副本，不是一次新的准备任务。必要原语缺失时由 subagent 报告缺口，Chief 在后续准备阶段统一补充。

## 产出与顺序

| 阶段 | 动作 | 产出 | 通过条件 |
|---|---|---|---|
| 初始化 | `meteor_init` | workspace、target 清单 | 一个 HW，各 op/dtype 独立 |
| 设备确认 | `meteor_hardware_probe` | 实测身份及环境报告 | 编译、执行、正确性、设备见证有效 |
| 搜索与诊断 | 官方搜索、`meteor_hardware_experiment` | 版本化资料、源程序、命令结果及释放回执 | 足以定义首轮研究需要的资源与操作，未知项明确保留 |
| 发布执行模型 | `meteor_hardware_model` | 不可变模型与证据副本 | 当前 HW/environment，资源/操作引用闭合 |
| 选择装配模板 | `meteor_configure_assembly_template` | 当前 op/dtype 的模板 hash/来源 | 槽位正确、ABI 与目标一致 |
| 开始研究 | `meteor_start` | 原上下文 subagent、冻结准备快照 | 模型和模板均已绑定 |

这是 Chief 的设备准备职责。诊断用于建立硬件模型，不能代替研究 Agent 的实验预算、原作者测量、full 或正式提交。准备接口不收取或重开研究请求；进行中的研究保持原快照。已有模型与当前环境及原探测报告 hash 一致时复用；每次重新 probe 都需要重新确认资料、诊断并发布模型，避免未观测到的运行时变化被遗漏。需要扩充时保留旧模型，用新模型 ID/内容发布，未来研究采用新快照。

## 从给定硬件建立模型

探测成功后，从当前仓库读取以下文件，确认 SoC、设备、编译器/运行时版本和可用观测工具：

| 所需信息 | 精确来源 |
|---|---|
| 模型的 `hardware_id` | `hardware/target.json.hardware_id` |
| 模型的 `environment_ref` | `.meteor.local.json.environment.environment_ref` |
| 当前探测报告 | `.meteor.local.json.environment.hardware_report_ref` 指向的文件 |

`.meteor.local.json` 是仓库根目录的文件，覆盖 `meteor.config.json` 中相应配置；基础配置仍显示 `unconfigured` 或空环境值是正常的。用文件读取工具直接打开该路径，无需搜索旧仓库或猜测隐藏目录。模型作者只复制前两个身份值，`hardware_report_hash/profile_hash` 由工具自动记录和校验。连接沿用集中 SSH profile，不把密钥或连接凭据写进资料、代码、模型或日志。

使用当前会话的文件搜索与 web 搜索/读取工具，优先用户材料、当前仓库示例、与实测版本对应的厂商官方文档/源码。保存必要摘录到 `hardware/sources/`，记录标题、URL 或仓库文件/commit、版本及取得时间。初始材料只是线索；不从插件示例、另一种芯片或历史报告推定当前硬件的资源、操作、容量、同步及并行能力。

Chief 用会话原生 `write/edit` 保存资料、模型草稿和装配模板；`meteor_write_file` 属于原研究 Agent，不能用于 Chief 准备。优先建立足够启动首轮研究的模型，未影响该设计的缺口留作 unknown。已成功的探测可以直接引用；不要仅为更换证据格式重新编译或运行同一能力核。

为子研究留下可直接查用的原语资料：当前版本的精确声明、已确认的类型与调用条件、必要的最小用法摘录及来源。头文件名和搜索命中列表只作定位线索；未取得的具体接口或语义保持 unknown。子研究从冻结资料组合自己的中间表达与实现，不以重复设备准备补齐交接材料。

按首轮算子需要列出问题：哪些执行资源可用、怎样表达对应计算与数据流、有哪些生命周期和同步限制、哪些性能指标真正可观测。资源名、操作名、粒度和约束全部由这些资料与诊断决定；插件没有预设 matrix/vector/load 等活动清单。概念未证实时记为假设/未知；不可为了“填满模型”编造精度、容量、并行度或固定代价。

| 证据 | 可以记录 | 仍需确认 |
|---|---|---|
| 本机头文件、SDK 配置 | 精确版本、声明、字段原值 | 具体重载/dtype/方向的语义；名称相近不等于同一操作，未知单位不换算成带宽 |
| 官方文档或搜索摘录 | 原文对应的版本与范围 | 获取日期不是版本；正文未取得时标明仅有摘录及适用版本差异 |
| 成功复合设备样例 | 实际执行路径、输入、输出、同步和观测方法 | 整条流程成功不能归因于其中单个事件；Host 同步/回读不能省略出证据链 |
| 性能或任务日志 | 本次实际使用的计时 API、预热/重复数、单位 | 声明支持某指标不等于本次已测；另一次 profiler 运行不验证当前 event 计时协议 |

这些界限也适用于 `sources` 的摘要和 `resources/primitives` 描述，不能只在 limitations 撤回正文中的保证。编译诊断前先读取当前 SDK 的精确声明和调用示例，避免猜测枚举名；返回零但无能力说明的字段保留原值和未知解释。

依据官方示例编写小型设备诊断，先声明问题、控制和预期观察。`run` 必须同时提供 `question`、非空 `files` 和 `commands`，每个文件都有 `path/content`；`poll/collect/cancel` 只需原 ID。即使诊断只读取已安装配置，也提交一个小脚本并用命令执行它：

```json
{
  "action": "run",
  "experiment_id": "由 Chief 为这次诊断指定的唯一 ID",
  "question": "要辨别的硬件能力与观察边界",
  "files": [{"path": "diagnostic.py", "content": "按实际资料编写的诊断程序"}],
  "commands": [{"argv": ["python3", "diagnostic.py"], "timeout_seconds": 60}]
}
```

接口通过同机 FIFO 执行，不自行加并发或跳过排队；继承已配置的设备工具链环境。最多 32 文件/1 MB、8 命令，每条 1～900 秒、总上限 1800 秒。配置查询只输出问题相关的节、键和值以及文件身份，避免整份 SDK 清单或巨大类型表挤掉需要的输出。逐命令检查 stdout/stderr/returncode、实际提取内容和原请求释放；退出码 0 但未提取到目标字段仍未回答问题。执行成功只是命令证据。编译产物说明编译器生成内容，kernel 级见证说明匹配设备任务；单条指令、分支或并行时间线需要对应观测，不能相互替代。实验设计要能区分相关机制；无法观测时保留 unknown。

请求 ID 发起前已落盘。SSH 断开或结果未知时用同一 `experiment_id` 的 `poll`、`collect`，必要时 `cancel` 并确认释放；禁止换 ID 原样重跑。失败可作为局部反证，不能以缺日志、NOT_RUN 或后续成功推定从未启动、唯一根因或旧请求已释放。命令超时不包含 FIFO 等待，命令耗时也不是 kernel 时间。

## 发布数据结构

模型 JSON 的字段与实例由你填写，详见 [模型协议](references/model-contract.md)。每个资源与活动引用来源 ID；约束分别标 `documented`、`measured`、`hypothesis`、`unknown`，写清作用域。模型必须包含资料和本 Chief 的本设备诊断，至少一份完整且已释放的成功诊断。当前探测报告可作为补充 `experiment` 来源，不能替代该诊断；不把报告改标为资料来通过校验。每个 `measured` 断言仍需相应实验支持，不因此推导所有资源均已实测。

用 `meteor_hardware_model({action:"publish",path:"hardware/model-draft.json"})` 发布。工具验证结构、身份与来源；它不代替你判断科学结论。发布保存资料内容副本和 hash，不改旧证据。research、design/expected/freeze 使用冻结模型；源码活动 `kind` 和 `resource` 只能取自该模型。

## 每个 op/dtype 的装配准备

从用户文件与仓库搜索实际版本/dispatch 示例，核对该目标 ABI、入口、shape 参数及调用约定。阅读 `tools/meteor/assembly-guide.md`，在本目标模板中放置程序提供的源码、bucket 表与路由槽。用户已有模板优先采用；没有时依据实际示例适配，不把 bundled QMQ 示例当成所有 op/dtype 的默认 ABI。

调用 `meteor_configure_assembly_template({target:{op_id,dtype_id},source_path,template_id,source_label})` 显式选择。选择按目标冻结，不覆盖其它 op/dtype。正式集成只在同一 workspace/op/dtype 内比较兼容且推荐的有效 PASS 测点，性能选择与机制假设结论分开。准备完成才调度研究；不要为模板或文档汇总派无实验的研究任务。
