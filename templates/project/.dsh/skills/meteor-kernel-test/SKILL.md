---
name: meteor-kernel-test
description: meteor 研究入口与单 kernel 测试规范。Chief 确认配置后用 meteor_start 选择随机或指定初始材料，并可给定待验证假设；研究 Agent 在同一会话构建并独立全尺寸测试每个提交 revision。
---

# 单 kernel 测试

研究 Agent 在原 session 内决定调用顺序和实验参数；测试过程不另建 Agent、不触发分桶、不决定假设真假。

先读算子约定、模块接口和测试模板，再按具体缺口查找少量相关 kernel 或官方示例。有了足以执行的假设就保存计划并做第一个实验；不要反复通读宿主、存储和集成源码来推迟实验。后续检索围绕具体编译错误、正确性差异或机制问题展开。长源码分文件或分段写入，保持原会话中的实验计划和记忆。

Chief 接到算子研究任务后，先核对 `meteor.config.json`、可选 `.meteor.local.json` 和算子约定。已有配置足以启动时，立即调用 `meteor_start` 传入 `goal`，可带 `research_id` 和 `budget`。通过 `initial_context` 选择本轮初始材料：省略时默认按原新鲜度策略随机分发；`{mode:'random',sampling:{count,seed,epsilon,lambda,tau_hours}}` 中的抽样参数均可选，仅对本轮生效；`{mode:'specified',kernel_refs:[...],knowledge_refs:[...]}` 按指定引用分发，不混入随机材料。引用支持库材料 ID、`sqlite://kind/id` 或文件/模块路径；使用已存在的材料引用。

有给定待检验命题时，Chief 同时传入 `hypothesis:{statement,...}`，它可与任一初始材料模式组合。可补充 `scope`、`mechanism`、`intervention`、`controls`、`predictions`、`support_criteria`、`refutation_criteria`、`confounders`、`measurement_plan`；子 Agent 补齐实验定义并验证该原始目标。未提供假设时才由子 Agent 提出。指定 kernel/知识只作启发，允许继续阅读其他材料、选择其他实现，不要求修改指定 kernel。manifest.json 和 seed.json 保存 Chief 输入与实际分发，用于核对本轮任务。

插件负责创建一个连续 subagent，构建/测试工具负责通过集中 profile 连接 SSH。旧研究已经结束时保留其报告并启动独立研究，不把重查旧日志或 shell 里手工 SSH 探测作为新任务的前置条件。配置缺失时再协助用户补齐明确缺项。

Chief 启动后使用原生 job 等待/完成通知收取结果，不用反复执行的目标、空转命令或高频查询代替等待。插件故障保留错误报告；不要在算子研究过程中修改插件源码或文档来修补基础设施。

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
