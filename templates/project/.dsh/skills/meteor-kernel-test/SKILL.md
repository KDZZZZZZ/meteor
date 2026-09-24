---
name: meteor-kernel-test
description: 用户要求写算子、优化 kernel、持续研究或继续实验时使用。Chief 自动准备工程与设备、管理持续 goal，并用 meteor_start 调度研究 subagent；Subagent 负责源码、构建、全尺寸测试与性能实验。
---

# 单 kernel 测试

## Chief：启动并管理研究 subagent

**你的主要责任是把用户的算子目标交给研究 subagent 执行，并管理其进度和结果。** 算子实现、编译修复、正确性调试、全尺寸测试和性能实验由研究 subagent 完成。你负责用户沟通、必要的设备配置、启动任务、收取报告与维护仓库。

### 用户只给目标即可

用户说“写这个算子”“优化当前算子”“继续研究”时，从当前工程、已有 goal 和会话恢复算子、suite、设备及预算；已有配置、材料路径和操作步骤不用让用户再说一遍。只有确实缺少且不能从文件/已有配置确定的信息才询问。普通实现请求按其交付目标执行；“持续研究”“一直跑”明确授权持续调度，具体做法见下方持续目标规则。

初始化、设备准备、材料抽样、假设设计、单 kernel 全尺寸测试、报告入库和自动集成均是本 skill 定义的默认职责。用户没有逐条复述这些规则，也照常执行。沿用用户当前模型/API 和集中 SSH 配置；不把这台机器的路径、芯片或连接名称固化为插件默认值。

收到写算子、优化 kernel 或做实验的请求，按以下最短路径行动：

1. 工程未初始化就 `meteor_init`；已有工程读取当前配置及硬件就绪状态。报告有效且环境未变时直接使用；尚未就绪才自动探测并处理具体故障。
2. 保留用户目标和约束。用户提到现有文件时，先用文件搜索解析为真实可读的绝对路径，再作为材料引用传入；只有文件名时不能假定它在本工程根目录。当前目录或 Git 仓库内未找到时，沿已知项目的上级目录按文件名搜索，并检查用户明确给出的其他路径；一次局部搜索无结果不代表文件不存在或不可访问。材料只是启发时，缺旧文件可由 subagent 独立实现；目标专门针对该文件时才需要补足真实文件。
3. 条件满足就调用 `meteor_start({goal})`。默认即可随机分发初始材料并让 subagent 提出假设；你已有具体假设或用户指定材料时再传相应参数。形成完整假设、寻找现成基线和阅读全部代码都不是默认启动前置步骤。
4. 用原生 job 等待和收取报告、自动集成回执。核对用户目标是否达成；仍有已授权工作时，依据报告改进未来提示词和安排后续研究。

在没有明确外部阻塞的情况下，本次处理算子目标应实际发出研究任务。不要以建议用户稍后启动、仅完成设备报告或由你自己开展 kernel 实验作为交付。用户限制研究数量时遵守该数量；每个研究内部沿用正常多次实验预算。

启动前核对当前 `case_suite` 的实际清单。新项目默认 192 个固定 shape，M=1～8192、N=1～32769、K=1～8192，分层选点见 `asc/full-size-policy.md`；这是选点包围范围，不是 kernel 的全域支持保证。旧工程仍为 4 个 smoke case 时，明确指出范围；用户要求扩大时，在下一轮前保存新的 suite 文件并更新配置、准备输入/oracle。不要改写进行中的快照或把旧回执扩写为新范围已通过。按新规模配置实验预算，随后及时启动 subagent。

已要求升级的旧工程由你完成迁移，不把复制模板、改配置、核验数据交回用户。需要模板来源时调用 `meteor_init`，使用返回的 `template_root` 和 `conflicts` 对照实际文件；初始化保留已有内容，不代表冲突文件已升级。仅合入必要的工具/skill 差异，保留项目定制；新 suite 用新文件名，复用数据前核对 shape、输入/oracle 哈希与协议。旧回执保留原作用范围，下一轮使用新快照。用户自定义的固定 suite 以其明确要求为准，不因为插件有新预设就替换。

用户只需给出研究目标，以下操作由 Chief 自动完成，无须用户在聊天里重复操作步骤。工程尚未初始化时，自行调用 `meteor_init`。读取 `meteor.config.json`、存在时读取 `.meteor.local.json`，并读取 `asc/operator.json`；以合并后的配置为准。初始化不代表设备就绪，不使用默认 mock、示例芯片、假定核数/内存或占位编译目标来启动真实研究。

**Chief 的设备准备职责：** 首先调用 `meteor_hardware_probe({})` 自动发现已有集中 profile；初始化返回的 `available_profiles` 是真实可用引用。不要根据示例猜 `default` 等名称，不要在已有配置可读时要求用户重复提供 SSH 配置。只有多个可用连接需要选择时传实际存在的 `profile_ref`；出现 unknown reference 时先按工具返回的列表纠正调用。读取返回的硬件报告、能力与 setup 状态，核对实际 SoC/架构、设备映射、核数/内存、健康、工具链、真实设备 kernel 的编译执行与采集结果。失败时根据具体诊断在已授权范围内调试配置并重新探测；确实没有可用连接配置时才指出所需配置项，保持未就绪，不启动研究。不要把端口可达、ACL 初始化或原生 shell 的环境当作插件执行链已通过。报告中的未知能力保留未知，不根据名称或其他机器参数补值。详细检查方法见 [Ascend 测量参考](references/ascend-measurement.md)。

已有工程也先核对当前 profile/设备/工具链对应的报告；报告缺失、失效或环境变更时重跑探测。设备就绪且目标足以形成任务后尽快 `meteor_start`。设备探测只验证环境能力，不能代替研究 Agent 对自己 kernel 的正确性、执行设备与性能验证。库为空时可用默认随机材料启动，由 subagent 提出假设和基线；用户指定材料或假设时直接传入。无需通读旧日志、数据库或驱动源码才开始研究。

设备准备失败时由 Chief 读取报告中具体失败命令和输出，按官方文档自主定位和修复已授权的本地工具或环境配置，再探测；不要只重复相同请求后把可自行排查的问题交给用户。项目 `tools/meteor/runners` 是实际探测代码来源，修改后会以新内容哈希部署。保留失败报告及其原始证据。区分“未运行采集”“采集失败”“采集成功但未匹配任务”；前置正确性失败而跳过 msprof 时，不能报告成 msprof 已采集却找不到任务。

文件和 shell 工具遵循当前 DSH 权限上下文；普通项目编辑沿用默认权限，不自行添加 `sandbox_permissions` 或申请提权。当 approval policy 为 `never` 时省略这些参数。工具因参数校验失败时，根据错误修正参数再调用，不反复提交同一组被拒参数；检查修改已实际生效后再复测。任务受阻不等于任务完成，最终报告和任务状态应准确保留尚未执行的研究。

原生工具的可选参数按需传入，不用空字符串或猜测枚举填满参数表；尤其不要传 `justification:""`。使用原生 `edit` 前先用原生 `read` 读取目标文件，`meteor_read_file` 的读取不替代该工具的读前检查；实际修改的 old/new 内容必须不同。一次参数错误修正后，把正确调用方式用于后续同类操作。

Chief 可为本轮目标读取少量相关库证据、内部文件，并通过可用的 web 搜索/读取工具查阅厂商官方资料，提出可证伪假设。已有足够证据形成可执行研究时就启动；后续检索围绕报告中的具体缺口。把来源和适用范围随材料引用交给研究 Agent。

调用 `meteor_start` 时传入 `goal`，可带 `research_id` 和 `budget`。通过 `initial_context` 选择本轮初始材料：省略时默认按原新鲜度策略随机分发；`{mode:'random',sampling:{count,seed,epsilon,lambda,tau_hours}}` 中的抽样参数均可选，仅对本轮生效；`{mode:'specified',kernel_refs:[...],knowledge_refs:[...]}` 按指定引用分发，不混入随机材料。引用支持库材料 ID、`sqlite://kind/id` 或文件/模块路径；使用已存在的材料引用。

`goal` 只写本轮研究目标、特殊约束和需要检验的差异；材料放 `initial_context`，命题放 `hypothesis`，预算放 `budget`。工程 ABI、suite、设备身份和通用行为由配置、启动包、persona 与两个 skill 提供，不要求用户写长启动词，也不靠每轮重复整套操作规程才能工作。

指定模式只传 `mode` 和需要的引用，省略 `sampling`；若调用中仍携带合法抽样参数，工具会明确报告忽略这些参数，只分发指定材料。原始源码文件可作为只读启发材料，须使用已确认的路径；构建回执、错误日志和报告放入 `knowledge_refs`。参数错误时保留用户的指定材料并按诊断修正，不能为启动成功而改成空随机材料。实际有效分发以返回的 seed/manifest 为准。

用户限制“一轮”或“一个研究任务”约束的是 `meteor_start` 次数，不是实验次数。研究内部需要对照、干预与修复迭代；用户未另限实验预算时沿用项目默认值，不据此将 `max_experiments` 缩成 1。

有给定待检验命题时，Chief 同时传入 `hypothesis:{statement,...}`，它可与任一初始材料模式组合。可补充 `scope`、`mechanism`、`intervention`、`controls`、`predictions`、`support_criteria`、`refutation_criteria`、`confounders`、`measurement_plan`；子 Agent 补齐实验定义并验证该原始目标。未提供假设时才由子 Agent 提出。给定假设不能附带必须 SUPPORTED、必须更快或必须交付的结论；已有 verdict 只作历史材料。指定 kernel/知识只作启发，允许继续阅读其他材料、选择其他实现，不要求修改指定 kernel。manifest.json 和 seed.json 保存 Chief 输入与实际分发，用于核对本轮任务。

插件负责创建一个连续 subagent，构建/测试工具负责通过集中 profile 连接 SSH。设备报告有效时，旧研究已经结束便保留其报告并启动独立研究；无需重复无关环境探查。

### 持续目标与每轮决策

用户直接要求“持续研究”“一直跑”时，Chief 主动使用 DSH 原生 goal，不要求用户另写 `/goal` 或长操作说明：先 `get_goal`，没有当前目标或上个目标已完成时 `create_goal`，目标概述用户要持续改进的算子与范围即可。已有同一持续 goal 就沿用，当前是自主 Goal Round 时也沿用；不反复创建 goal。修改前重新读取精确 id/revision，并遵守当前工具的授权和状态约束。用户暂停不自动恢复，不通过重建 goal 绕过轮次或资源限制。

未指定总轮次时沿用 DSH 部署默认值，不硬编码 256；每个 research 采用项目预算或已授权的显式覆盖，不把单轮预算当总额度，也不把持续授权当作无限算力。明确的阶段交付可以完成；开放式“持续研究”在仍有可执行工作时保持 active，一个 kernel、一次提交或单轮 CLOSED 不构成完成条件。进展摘要写入工作记忆和报告，不能为了交一次摘要就将总 goal 标成 complete。

Chief 启动后按下方原生等待规则收取 jobs 的结果。遇到插件故障时保留错误报告，定位具体阻塞，避免把算子研究扩展成基础设施重构。

用户已授权持续研究时，先用一个 research 验证调用、工具往返、研究报告及自动集成能稳定完成。稳定后由 Chief 根据总预算、单研究预算、设备能力和在途任务决定并行度。每轮报告和自动集成回执收齐后，若总目标仍未完成且预算允许，自主选择下一假设与材料，再用 `meteor_start` 开启新的 research。单轮 CLOSED 或一个 kernel 成果不等于持续目标完成；不得靠新 research ID 绕过预算。远端状态未知或资源释放未确认时，先查询或收取原请求，禁止重复启动同一远端任务。

每轮分别核对原假设及修订结论、各 kernel 的已验证范围/有效性能、知识与新鲜度入库结果、自动集成状态。下一轮可复测噪声、补机制证据、扩大支持域或检验新假设，依据报告中最有信息量的未决问题选择；材料可跨历史研究，代际不形成只能沿上一 kernel 继承的树。单轮失败先保留原因并区分候选问题、工具故障和外部阻塞，修正未来任务的相关缺口后继续，不能只换 research_id 原样重试未知的远端工作。

### 子任务后台运行时怎样工作和等待

`meteor_start` 返回后台 `job_id` 后，Chief 可继续做与在途实验无依赖的工作：分析已完成报告、查少量相关官方资料、准备下一假设和候选材料、整理已完成结果的索引，或在已验证的并行度与预算内启动另一个独立研究。只修改未来任务要用的项目提示词；不修改运行中的 snapshot、kernel、实验输入或回执，也不为保持忙碌而反复通读源码或抢占设备做额外测试。

需要子任务结果才能推进时，使用 DSH 原生 `job_output({job_id, wait:true, timeout_ms:60000})`，并遵守当前部署的超时上限。它等待该 job 进入终态或超时，返回时检查状态和结果；超时仍在运行就保留同一 job，按需再次有界等待。等待超时不等于实验失败、预算耗尽或取消。`wait:false` 仅用于有实际理由的一次状态读取，不组成高频轮询。

这个等待会挂起 Chief 当前工具调用，后台 subagent 继续运行；Chief 不能在同一次等待尚未返回时又执行其他工具。因此先做独立工作，再等待。不要使用 PowerShell `Start-Sleep`、空转脚本或另建 Agent 来模拟等待，也不要猜测存在独立 `sleep` 工具。

官方 alpha.2 默认把后台完成通知送给忙碌 Chief 的下一步，或唤醒空闲 Chief；实际通知策略以部署配置为准。**但 active 且 armed 的 goal driver 不检查 jobs 是否仍在运行**：直接结束当前轮次可能立刻开始下一 Goal Round，不能靠反复结束空轮次静默等待。持续 goal 下只剩等待时用上述原生有界等待。没有已激活持续 goal 且已确认完成通知能唤醒当前 Chief 时，才可结束轮次等通知；通知策略未知、quiet 或已达唤醒上限时继续有界等待。不要为等待而擅自暂停用户 goal；收到终态后收取报告/自动集成回执并继续决定下一轮。

接口依据：DSH 0.1.7-alpha.2 的 [job 工具](https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/jobs/tool-jobs/README.md)、[goal driver](https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/goal/goal-round-driver/src/index.ts)。`wait_agent` 属于实验性 Agent Teams，不用它等待 Meteor 的普通 job。

Chief 可根据已完成报告和可复现的行为缺口改进项目现有 `prompts/meteor.md` 或这两个 skill，记录修改依据；修改只影响未来 research 的快照。保留正在运行的 snapshot、原始证据和研究结果，不向运行中的 Agent 中途喂提示，不代写最终提交。继续使用一份 persona 和两个 skill，不新增角色 prompt。新研究仍由 Chief 明确调用启动，插件和研究 Agent 不递归创建研究。

Chief 负责维护仓库，功能分支使用 `<type>/<kebab>` 命名；`main`/`dev` 仅经 PR 合入，无需他人审核。只有用户明确允许时才创建 PR，开展研究不构成 PR 许可。提交说明和交付报告区分人类设计、Agent 自主决策、成熟实现借鉴，并写明验证与限制。

所有模型/API 和 SSH 凭据由已有集中配置管理，不能写入 persona、skill、启动目标、材料或报告。

## 研究 Agent：在原会话内实验

研究 Agent 在原 session 内决定调用顺序和实验参数；测试过程不另建 Agent、不触发分桶、不决定假设真假。

按启动包给出的实际 `contracts_ref`、`operator_contract_ref`、`kernel_template_ref` 和 case suite 路径读取模块接口、算子约定与测试模板，核对硬件报告；不要猜文件名。再按具体缺口查找少量相关 kernel 或官方示例。有了足以执行的假设就保存计划并做第一个实验；按工具 schema 填参数，无需通读提交校验或数据库源码。后续检索围绕具体编译错误、正确性差异或机制问题展开。长源码分文件或分段写入，保持原会话中的实验计划和记忆。

初始库为空时自行编写符合 ABI 的最小设备基线，优先参考官方实现。用 `meteor_write_file` 创建本轮 `drafts/<kernel>/<revision>/kernel.json`、`device.asc`、`host.asc`；源码是研究 Agent 的交付工作，缺文件时自行补齐。`meteor_write_file.path` 相对本轮研究目录，其返回值给出实际路径；`meteor_kernel_build.kernel_path` 使用该模块的实际目录或清单路径。文件全部写入后实际调用 build，根据编译与正确性结果迭代；计划和文档不能替代实验。每个预测与推荐范围都核对当前 case-suite 的真实 shape，超出 suite 的尺寸只能列为后续待验证范围。预算未耗尽且仍有可行实验时继续本轮，不能仅以“尚未实现”“时间有限”交回空结果；外部阻塞应有具体失败证据。

1. 核对 chief 的启动输入、原假设和实验计划，固定 research_id、experiment_id、kernel revision、case_suite、oracle、环境与测量协议。补齐给定假设的实验定义；实质修订时保留原文、原因和原假设状态，不以修订成立替代原目标的验证。
2. 保存模块 kernel.json/device.asc/host.asc，确认清单引用的源码文件、launcher 函数、设备计算及 launch 调用均已实际实现后再构建。只含 TODO/注释的文件仍是未实现，不能靠它制造编译失败作为停止依据。缺少 host/device 文件或路径写错时，补齐文件并在同一实验内重试；这类输入错误未形成一次设备实验，不能据此认定实验预算耗尽。目标计算在 AI Core/Vector 上实现，Host 负责调度与输入准备；禁止 CPU/NEON 替算、占位 device kernel 和跨实现 fallback。源码或依赖变化时创建新 revision。
3. 调用 `meteor_kernel_build`，输入 experiment_id、kernel_path；kernel_path 可指模块目录或 kernel.json，research_id 由宿主绑定当前 session。检查 source_hash、artifact_hash、模块身份、硬件/编译目标、simulated 标记与构建状态。

   首次编写和遇到编译/正确性障碍时阅读 [Ascend 编写与编译诊断](references/ascend-authoring.md)。构建失败时读取诊断和 raw_receipt_ref，修复第一处具体错误并以新 revision 重建。例如 launcher 未声明时实现清单声明的 ABI 函数和实际设备调用，纯标量 kernel 无法推导执行类型时检查显式类型属性；这是候选代码的开发工作。预算还有余量且有可执行修复时，在当前 session 继续迭代，不用多次不同编译错误推导工具链不支持该算子。
4. 可调用 `meteor_kernel_test` 的 probe 模式调试选定 case。probe 不替代 full。
5. 调用 full 模式独立执行这个 revision 的 case 全集。检查每个 case 的 PASS/INCORRECT/UNSUPPORTED/RESOURCE_REJECTED/RUN_FAILED/TIMEOUT/NOT_RUN、原因、实际实现身份、原始样本和 input/oracle hash。
6. UNSUPPORTED 是显式终态，不运行其它 kernel 代替。正确性通过且有效执行才能记录计时。accounting_complete 与支持/计时 case 数量分别核对。“全尺寸”是固定 suite 全集；它不覆盖未列出的 shape，不能将几个离散 case 写成其整个包围区间已验证。

   在 192-case 预设下，少量 probe 或旧 4-case 成绩不能替代本轮 full。根据真实源码/设备限制声明子域，不删大 case、不以虚构 UNSUPPORTED 掩盖错误或超时。full 的耗时和 profiler 成本纳入预算，优先用代表性 probe 排除明显错误。
7. 源码/ELF、环境、suite、协议与提交必须一致。只能引用当前研究、同一 subagent 会话中身份匹配的历史 full 数据；计时可比性或配对要求不足时重新测量。
8. 失败结果保留为实验材料；编译/测量失败不等于假设被证伪。你可以分析、修复或新增实验。
9. 最终交付的每个 kernel 都由编写者在提交前测完并提交完整数据，不能把责任移交 chief。已验证正确的基线可在明确性能限制后交付，推荐 case 表示允许自动集成考虑的适用范围，不表示已证实加速。缺少有效性能对照时报告未知，不把错误实现的时间当成回退依据。准备交付失败时回到本 skill 补齐。`meteor_prepare_submission` 使用完整工具 schema，研究身份自动绑定；实验要关联 hypothesis revision。最终报告使用准备结果返回的被测模块、完整测量与报告引用，不根据目录名称重建链接。

## 设备执行与计时检查

- 每个被测实现都要有与其 source/build、case 和目标设备对应的执行证据。SSH 成功、simulated:false、ACL event 有数值不足以证明 AI Core 执行。采集器需找到目标 kernel 的真实 AI Core/Vector/MIX 任务；任意无关设备任务、AI_CPU 或纯搬运不能代替它。
- 检查 Host/Device 实际路径：输入回 Host 计算、占位 kernel、编译为 CPU 调试模式都不符合目标。仅有 profiler 行也不能替 CPU 计算背书；结合源码/launch、正确性与工具证据判断。
- kernel 延迟区间应在预热与 H2D 完成之后开始，涵盖目标设备 launch，结束后同步，再做 D2H/正确性校验。Host 计算、额外拷贝、分配或编译若被计入，应明确标成相应端到端时间，不作为 kernel 延迟。
- ACL event 在同一 stream 上记录 start/end，同步完成后读取 `aclrtEventElapsedTime`；单位 ms，转 us 乘 1000。保留 warmup、repeat、每次原始样本、同步点和计时范围；不把平均值当原始样本。
- 常态计时与插桩/profile 分开。profiling 开销、缓存状态、频率、其他并行任务可能改变结果；需要时采用配对复测。设备级 profiling 按工具队列串行，不另开采集进程竞争设备。

具体命令、字段、版本差异和官方链接见 [Ascend 测量参考](references/ascend-measurement.md)。仅在相应问题出现时查阅对应小节。

测试回执通过原调用返回当前 session。可用 run_status/run_control 查询或取消已提交请求；取消或远端状态未知时保持准确状态，禁止重复提交未知的同一远端任务。

显式的协议测试可使用 mock，但不得替代初始化设备准备或真实性能证据。真实后端只引用集中 SSH profile，不读取或复制凭据。工具缺陷保留输入与错误给 Chief；不要修改测试器、冻结快照、原始回执或 importer 来迁就当前交付。
