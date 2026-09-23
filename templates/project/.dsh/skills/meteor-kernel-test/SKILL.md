---
name: meteor-kernel-test
description: meteor 研究入口与单 kernel 测试规范。Chief 按用户目标自行初始化、准备材料与假设并启动研究，管理已授权的持续目标；研究 Agent 在同一会话构建并独立全尺寸测试每个提交 revision。
---

# 单 kernel 测试

## Chief：配置并启动研究

用户只需给出研究目标，以下操作由 Chief 自动完成，无须用户在聊天里重复操作步骤。工程尚未初始化时，自行调用 `meteor_init`，再继续配置与启动。读取 `meteor.config.json`、存在时读取 `.meteor.local.json`，并读取 `asc/operator.json`。项目默认 mock 可由 local override 切换为 SSH；以合并后的配置为准。配置齐全且目标足以形成研究任务时，尽快调用 `meteor_start`。只有遇到明确缺项或工具错误，才定位对应配置或实现；不要穷尽旧研究日志、数据库、驱动源码或手工 SSH 探测后才启动。

**已配置工程的首轮动作：读完以上配置，下一次调度就调用 `meteor_start`。** 首轮通过 subagent 的构建/测试调用验证 SSH 执行链。不要把 `ssh -V`、端口探测、读取系统 SSH 文件或驱动源码作为前置任务；原生 shell 的环境也不能代表插件实验工具的执行环境。库为空或旧研究没有有效实验时，照常以默认随机材料启动，让 subagent 提出假设并建立实验基线。用户指定了材料或假设时，直接传入启动参数。首个研究已经运行后，Chief 再整理资料、研究后续假设和安排后续轮次。

Chief 可为本轮目标读取少量相关库证据、内部文件，并通过可用的 web 搜索/读取工具查阅厂商官方资料，提出可证伪假设。已有足够证据形成可执行研究时就启动；后续检索围绕报告中的具体缺口。把来源和适用范围随材料引用交给研究 Agent。

调用 `meteor_start` 时传入 `goal`，可带 `research_id` 和 `budget`。通过 `initial_context` 选择本轮初始材料：省略时默认按原新鲜度策略随机分发；`{mode:'random',sampling:{count,seed,epsilon,lambda,tau_hours}}` 中的抽样参数均可选，仅对本轮生效；`{mode:'specified',kernel_refs:[...],knowledge_refs:[...]}` 按指定引用分发，不混入随机材料。引用支持库材料 ID、`sqlite://kind/id` 或文件/模块路径；使用已存在的材料引用。

有给定待检验命题时，Chief 同时传入 `hypothesis:{statement,...}`，它可与任一初始材料模式组合。可补充 `scope`、`mechanism`、`intervention`、`controls`、`predictions`、`support_criteria`、`refutation_criteria`、`confounders`、`measurement_plan`；子 Agent 补齐实验定义并验证该原始目标。未提供假设时才由子 Agent 提出。指定 kernel/知识只作启发，允许继续阅读其他材料、选择其他实现，不要求修改指定 kernel。manifest.json 和 seed.json 保存 Chief 输入与实际分发，用于核对本轮任务。

插件负责创建一个连续 subagent，构建/测试工具负责通过集中 profile 连接 SSH。旧研究已经结束时保留其报告并启动独立研究，不把重查旧日志或 shell 里手工 SSH 探测作为新任务的前置条件。配置缺失时再协助用户补齐明确缺项。

Chief 启动后使用原生 jobs 的等待/完成通知收取结果，并用宿主可用的持久目标能力记录已授权的总目标、进展和剩余预算。不要用空转命令、高频查询或反复创建目标代替等待。遇到插件故障时保留错误报告，定位具体阻塞，避免把算子研究扩展成基础设施重构。

用户已授权持续研究时，先用一个 research 验证调用、工具往返、研究报告及自动集成能稳定完成。稳定后由 Chief 根据总预算、单研究预算、设备能力和在途任务决定并行度。每轮报告和自动集成回执收齐后，若总目标仍未完成且预算允许，自主选择下一假设与材料，再用 `meteor_start` 开启新的 research。单轮 CLOSED 或一个 kernel 成果不等于持续目标完成；不得靠新 research ID 绕过预算。远端状态未知或资源释放未确认时，先查询或收取原请求，禁止重复启动同一远端任务。

Chief 可根据已完成报告和可复现的行为缺口改进项目现有 `prompts/meteor.md` 或这两个 skill，记录修改依据；修改只影响未来 research 的快照。保留正在运行的 snapshot、原始证据和研究结果，不向运行中的 Agent 中途喂提示，不代写最终提交。继续使用一份 persona 和两个 skill，不新增角色 prompt。新研究仍由 Chief 明确调用启动，插件和研究 Agent 不递归创建研究。

Chief 负责维护仓库，功能分支使用 `<type>/<kebab>` 命名；`main`/`dev` 仅经 PR 合入，无需他人审核。只有用户明确允许时才创建 PR，开展研究不构成 PR 许可。提交说明和交付报告区分人类设计、Agent 自主决策、成熟实现借鉴，并写明验证与限制。

所有模型/API 和 SSH 凭据由已有集中配置管理，不能写入 persona、skill、启动目标、材料或报告。

## 研究 Agent：在原会话内实验

研究 Agent 在原 session 内决定调用顺序和实验参数；测试过程不另建 Agent、不触发分桶、不决定假设真假。

先读算子约定、模块接口和测试模板，再按具体缺口查找少量相关 kernel 或官方示例。有了足以执行的假设就保存计划并做第一个实验；不要反复通读宿主、存储和集成源码来推迟实验。后续检索围绕具体编译错误、正确性差异或机制问题展开。长源码分文件或分段写入，保持原会话中的实验计划和记忆。

1. 核对 chief 的启动输入、原假设和实验计划，固定 research_id、experiment_id、kernel revision、case_suite、oracle、环境与测量协议。补齐给定假设的实验定义；实质修订时保留原文、原因和原假设状态，不以修订成立替代原目标的验证。
2. 保存模块 kernel.json/device.asc/host.asc。一个模块只实现一个明确的算法，不把其它独立实现隐藏在 fallback 中。源码或依赖变化时创建新 revision。
3. 调用 `meteor_kernel_build`，输入 experiment_id、kernel_path；research_id 由宿主绑定当前 session。检查 source_hash、artifact_hash、模块身份、simulated 标记与构建状态。
4. 可调用 `meteor_kernel_test` 的 probe 模式调试选定 case。probe 不替代 full。
5. 调用 full 模式独立执行这个 revision 的 case 全集。检查每个 case 的 PASS/INCORRECT/UNSUPPORTED/RESOURCE_REJECTED/RUN_FAILED/TIMEOUT/NOT_RUN、原因、实际实现身份、原始样本和 input/oracle hash。
6. UNSUPPORTED 是显式终态，不运行其它 kernel 代替。正确性通过且有效执行才能记录计时。accounting_complete 与支持/计时 case 数量分别核对。
7. 源码/ELF、环境、suite、协议与提交必须一致。只能引用当前研究、同一 subagent 会话中身份匹配的历史 full 数据；计时可比性或配对要求不足时重新测量。
8. 失败结果保留为实验材料；编译/测量失败不等于假设被证伪。你可以分析、修复或新增实验。
9. 最终交付的每个 kernel 都由编写者在提交前测完并提交完整数据，不能把责任移交 chief。准备交付失败时回到本 skill 补齐。

测试回执通过原调用返回当前 session。可用 run_status/run_control 查询或取消已提交请求；取消或远端状态未知时保持准确状态，禁止重复提交未知的同一远端任务。

mock 数据只用来验证协议；禁止报告为真实 Ascend 性能。真实后端只引用集中 SSH profile，不读取或复制凭据。
