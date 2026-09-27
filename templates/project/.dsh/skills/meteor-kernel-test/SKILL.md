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

收到写算子、优化 kernel 或做实验的请求，按以下最短路径行动。新目录、空目录或不确定是否已初始化时，第一步直接调用 `meteor_init`；不要先用 shell、PowerShell、glob、grep 或手写目录扫描来“确认空目录”。Meteor 工具会保留已有文件并返回当前状态与下一步动作。

1. 工程未初始化就 `meteor_init`；随后加载 `meteor-hardware-prepare`：缺少或失效的设备报告先用 `meteor_hardware_probe` 修复；根据实际 HW 的官方资料与诊断实验发布执行模型；从用户/仓库示例为每个 op/dtype 显式选择装配模板。报告、模型和模板均有效时复用。设备探测成功本身不足以启动新研究。
2. 保留用户目标和约束。用户提到现有文件时，先用文件搜索解析为真实可读的绝对路径，再作为材料引用传入；只有文件名时不能假定它在本工程根目录。当前目录或 Git 仓库内未找到时，沿已知项目的上级目录按文件名搜索，并检查用户明确给出的其他路径；一次局部搜索无结果不代表文件不存在或不可访问。材料只是启发时，缺旧文件可由 subagent 独立实现；目标专门针对该文件时才需要补足真实文件。
3. 条件满足就调用 `meteor_start({goal})`，默认直接引用用户的研究目标，省略无关对话，不扩写任务书。例如用户说“研究 qmq-v1 性能并给我报告”，即可传 `goal:"研究 qmq-v1 性能并给出报告"`。默认随机分发材料并让 subagent 提出假设；你已有具体假设或用户指定材料时再传相应参数。形成完整假设、寻找现成基线和阅读全部代码都不是默认启动前置步骤。
4. 用原生 job 等待和收取报告、自动集成回执。核对用户目标是否达成；仍有已授权工作时，依据报告改进未来提示词和安排后续研究。

在没有明确外部阻塞的情况下，本次处理算子目标应实际发出研究任务。不要以建议用户稍后启动、仅完成设备报告或由你自己开展 kernel 实验作为交付。用户限制研究数量时遵守该数量；每个研究内部沿用正常多次实验预算。

启动前核对当前 target 注册的 case suite 实际清单。内置 QMQ 预设为 192 个固定 shape，M=1～8192、N=1～32769、K=1～8192，分层选点见 suite 同目录的 `full-size-policy.md`；这是选点包围范围，不是所有算子或 kernel 的全域支持保证。旧工程仍为 4 个 smoke case 时，明确指出范围；用户要求扩大时，在下一轮前保存新的 suite 文件并更新对应 target 配置、准备输入/oracle。不要改写进行中的快照或把旧回执扩写为新范围已通过。按新规模配置实验预算，随后及时启动 subagent。

已要求升级的旧工程由你完成迁移，不把复制模板、改配置、核验数据交回用户。需要模板来源时调用 `meteor_init`，使用返回的 `template_root` 和 `conflicts` 对照实际文件；初始化保留已有内容，不代表冲突文件已升级。仅合入必要的工具/skill 差异，保留项目定制；新 suite 用新文件名，复用数据前核对 shape、输入/oracle 哈希与协议。旧回执保留原作用范围，下一轮使用新快照。用户自定义的固定 suite 以其明确要求为准，不因为插件有新预设就替换。

用户只需给出研究目标，以下操作由 Chief 自动完成，无须用户在聊天里重复操作步骤。工程尚未初始化时，自行调用 `meteor_init`。读取 `meteor.config.json`、存在时读取 `.meteor.local.json`，并读取当前 target 注册的契约文件；以合并后的配置为准。一个 workspace 只绑定一个 HW，各 op/dtype 共享仓库，产物按种类/op/dtype 分类，shape 仍由 case 与自动 version 路由表达。使用工具返回的 target/contract/suite 路径，不硬编码旧 `asc/` 目录。初始化不代表设备就绪，不使用默认 mock、示例芯片、假定核数/内存或占位编译目标来启动真实研究。

**Chief 的设备准备职责：** 首先调用 `meteor_hardware_probe({})` 自动发现已有集中 profile；初始化返回的 `available_profiles` 是真实可用引用。不要根据示例猜 `default` 等名称，不要在已有配置可读时要求用户重复提供 SSH 配置。只有多个可用连接需要选择时传实际存在的 `profile_ref`；出现 unknown reference 时先按工具返回的列表纠正调用。读取返回的硬件报告、能力与 setup 状态，核对实际 SoC/架构、设备映射、核数/内存、健康、工具链、真实设备 kernel 的编译执行与采集结果。失败时根据具体诊断在已授权范围内调试配置并重新探测；确实没有可用连接配置时才指出所需配置项，保持未就绪，不启动研究。不要把端口可达、ACL 初始化或原生 shell 的环境当作插件执行链已通过。报告中的未知能力保留未知，不根据名称或其他机器参数补值。详细检查方法见 [Ascend 测量参考](references/ascend-measurement.md)。

已有工程也先核对当前 profile/设备/工具链对应的报告；报告缺失、失效或环境变更时重跑探测。设备报告、执行模型及该 op/dtype 的装配模板已就绪且目标足以形成任务后，调用 `meteor_start`。设备探测只验证环境能力，不能代替研究 Agent 对自己 kernel 的正确性、执行设备与性能验证。库为空时可用默认随机材料启动，由 subagent 提出假设和基线；用户指定材料或假设时直接传入。无需通读旧日志、数据库或驱动源码才开始研究。

设备准备失败时由 Chief 读取报告中具体失败命令和输出，按官方文档自主定位和修复已授权的本地工具或环境配置，再探测；不要只重复相同请求后把可自行排查的问题交给用户。项目 `tools/meteor/runners` 是实际探测代码来源，修改后会以新内容哈希部署。保留失败报告及其原始证据。区分“未运行采集”“采集失败”“采集成功但未匹配任务”；前置正确性失败而跳过 msprof 时，不能报告成 msprof 已采集却找不到任务。

文件和 shell 工具遵循当前 DSH 权限上下文；普通项目编辑沿用默认权限，不自行添加 `sandbox_permissions` 或申请提权。当 approval policy 为 `never` 时省略这些参数。工具因参数校验失败时，根据错误修正参数再调用，不反复提交同一组被拒参数；检查修改已实际生效后再复测。任务受阻不等于任务完成，最终报告和任务状态应准确保留尚未执行的研究。

原生工具的可选参数按需传入，不用空字符串或猜测枚举填满参数表；尤其不要传 `justification:""`。使用原生 `edit` 前先用原生 `read` 读取目标文件，`meteor_read_file` 的读取不替代该工具的读前检查；实际修改的 old/new 内容必须不同。一次参数错误修正后，把正确调用方式用于后续同类操作。

Chief 可为本轮目标读取少量相关库证据、内部文件，并通过可用的 web 搜索/读取工具查阅厂商官方资料，提出可证伪假设。已有足够证据形成可执行研究时就启动；后续检索围绕报告中的具体缺口。把来源和适用范围随材料引用交给研究 Agent。

调用 `meteor_start` 时传入 `goal`，可带 `research_id` 和 `budget`。通过 `initial_context` 选择本轮初始材料：省略时默认按原新鲜度策略随机分发；`{mode:'random',sampling:{count,seed,epsilon,lambda,tau_hours}}` 中的抽样参数均可选，仅对本轮生效；`{mode:'specified',kernel_refs:[...],knowledge_refs:[...]}` 按指定引用分发，不混入随机材料。引用支持库材料 ID、`sqlite://kind/id` 或文件/模块路径；使用已存在的材料引用。

workspace 登记多个目标组时，在 `meteor_start` 传 `target:{op_id,dtype_id}`；状态和控制中出现同名研究时也携带该 target。随机初始材料来自同 HW 的共享库，可跨 op/dtype，来源身份保留。指定跨组同名材料时使用工具返回的完整 `ref` 或 `material_key`；这不改变本轮测试/提交的目标组，也不限制子 Agent 读取其他材料。

`goal` 只写本轮研究目标、特殊约束和需要检验的差异；材料放 `initial_context`，命题放 `hypothesis`，预算放 `budget`。工程 ABI、suite、设备身份和通用行为由配置、启动包、persona 与两个 skill 提供，不要求用户写长启动词，也不靠每轮重复整套操作规程才能工作。

分发时保留用户原意。**用户要求研究和报告时，goal 不得增加“至少提交一个 kernel”之类的交付数量要求。** subagent 仍须编写实验 kernel 验证假设；它是否选择把某个实验实现正式提交给库，由实验结果和用户明确要求决定，研究允许零个、一个或多个正式交付。不要自行增加“必须用 CUBE”“全部 192 个 case 必须 PASS”或峰值性能门槛。具体实现路线由 subagent 根据假设和证据选择。提交 kernel 的全尺寸测试要求仍然严格：固定 suite 中每个 case 都有终态，超出真实支持范围可如实为 `UNSUPPORTED`；完整记账不等于全域支持，推荐范围另行声明。

指定模式只传 `mode` 和需要的引用，省略 `sampling`；若调用中仍携带合法抽样参数，工具会明确报告忽略这些参数，只分发指定材料。原始源码文件可作为只读启发材料，须使用已确认的路径；构建回执、错误日志和报告放入 `knowledge_refs`。参数错误时保留用户的指定材料并按诊断修正，不能为启动成功而改成空随机材料。实际有效分发以返回的 seed/manifest 为准。

用户限制“一轮”或“一个研究任务”约束的是 `meteor_start` 次数，不是实验次数。研究内部需要对照、干预与修复迭代；用户未另限实验预算时沿用项目默认值，不据此将 `max_experiments` 缩成 1。

有给定待检验命题时，Chief 同时传入 `hypothesis:{statement,...}`，它可与任一初始材料模式组合。可补充 `scope`、`mechanism`、`intervention`、`controls`、`predictions`、`support_criteria`、`refutation_criteria`、`confounders`、`measurement_plan`；子 Agent 补齐实验定义并验证该原始目标。未提供假设时才由子 Agent 提出。给定假设不能附带必须 SUPPORTED、必须更快或必须交付的结论；已有 verdict 只作历史材料。指定 kernel/知识只作启发，允许继续阅读其他材料、选择其他实现，不要求修改指定 kernel。manifest.json 和 seed.json 保存 Chief 输入与实际分发，用于核对本轮任务。

插件负责创建一个连续 subagent，构建/测试工具负责通过集中 profile 连接 SSH。设备报告有效时，旧研究已经结束便保留其报告并启动独立研究；无需重复无关环境探查。

### 持续目标与每轮决策

用户直接要求“持续研究”“一直跑”时，Chief 主动使用 DSH 原生 goal，不要求用户另写 `/goal` 或长操作说明：先 `get_goal`，没有当前目标或上个目标已完成时 `create_goal`，目标概述用户要持续改进的算子与范围即可。已有同一持续 goal 就沿用，当前是自主 Goal Round 时也沿用；不反复创建 goal。修改前重新读取精确 id/revision，并遵守当前工具的授权和状态约束。用户暂停不自动恢复，不通过重建 goal 绕过轮次或资源限制。

按最新用户要求判断是否继续。此前“结束本轮、不启动下一轮”已经执行后，用户又明确要求继续研究，后续研究可在已有持续 goal 下正常启动；原研究的终态、预算和证据保留，不恢复已耗尽的研究。没有新的继续要求时仍遵守停止或暂停指令。研究并行数按当前 workspace 内存活的 research/subagent 统计，无须先找到或创建同等数量的实验仓库；一个 HW workspace 可以同时容纳多个研究。

未指定总轮次时沿用 DSH 部署默认值，不硬编码 256；每个 research 采用项目预算或已授权的显式覆盖，不把单轮预算当总额度，也不把持续授权当作无限算力。明确的阶段交付可以完成；开放式“持续研究”在仍有可执行工作时保持 active，一个 kernel、一次提交或单轮 CLOSED 不构成完成条件。进展摘要写入工作记忆和报告，不能为了交一次摘要就将总 goal 标成 complete。

Chief 启动后按下方原生等待规则收取 jobs 的结果。遇到插件故障时保留错误报告，定位具体阻塞，避免把算子研究扩展成基础设施重构。

用户已授权持续研究时，先用一个 research 验证调用、工具往返、研究报告及自动集成能稳定完成。稳定后由 Chief 根据总预算、单研究预算、设备能力和在途任务决定并行度。每轮报告和自动集成回执收齐后，若总目标仍未完成且预算允许，自主选择下一假设与材料，再用 `meteor_start` 开启新的 research。单轮 CLOSED 或一个 kernel 成果不等于持续目标完成；不得靠新 research ID 绕过预算。远端状态未知或资源释放未确认时，先查询或收取原请求，禁止重复启动同一远端任务。

用户明确指定研究并行数时，验证通过后以该数量管理存活的研究 subagent；例如“十路并行”是最多 10 个正在研究或等待设备队列的 subagent，由 Chief 通过 `meteor_start` 逐一启动并在正常收尾后补位。历史 child、已完成任务和自动集成 job 不计入研究并行数。每个研究仍有自己的假设、初始材料和连续上下文，共享设备实验继续自动排队，不提高设备同时执行的名额。先核对原生运行环境的并发限制；启动被拒绝时记录实际限制，不声称已达到请求数量。

用户授权数小时运行时，Chief 用原生 goal 保留总研究目标、截止条件和已授权并行数，并按实际运行时间管理总预算。达到约定截止条件后停止补位，正常收取在途任务和报告；需要中止时使用原请求的取消流程并确认资源释放。长跑报告写明实际并行数、研究数、完成/失败/未决数和设备排队情况，不用“启动成功”代替运行结果。

DSH 0.1.7-rc.2 的原生 goal 提供自动续接轮次预算，没有小时数或硬截止定时器参数；把约定的绝对截止时间和收尾要求写进 objective，由 Chief 检查实际时间执行，不能声称平台会自动定时停止。`meteor_start.budget` 仍约束每个研究。

每轮分别核对原假设及修订结论、各 kernel 的已验证范围/有效性能、知识与新鲜度入库结果、自动集成状态。下一轮可复测噪声、补机制证据、扩大支持域或检验新假设，依据报告中最有信息量的未决问题选择；材料可跨历史研究，代际不形成只能沿上一 kernel 继承的树。单轮失败先保留原因并区分候选问题、工具故障和外部阻塞，修正未来任务的相关缺口后继续，不能只换 research_id 原样重试未知的远端工作。

### 子任务后台运行时怎样工作和等待

`meteor_start` 返回后台 `job_id` 后，Chief 可继续做与在途实验无依赖的工作：分析已完成报告、查少量相关官方资料、准备下一假设和候选材料、整理已完成结果的索引，或在已验证的并行度与预算内启动另一个独立研究。没有必要的独立工作时直接有界等待，无须先制造管理工作。只修改未来任务要用的项目提示词；不修改运行中的 snapshot、kernel、实验输入或回执，也不为保持忙碌而反复通读源码或抢占设备做额外测试。

需要子任务结果才能推进时，使用 DSH 原生 `job_output({job_id, wait:true, timeout_ms:60000})`，并遵守当前部署的超时上限。它等待该 job 进入终态或超时，返回时检查状态和结果；超时仍在运行就保留同一 job，按需再次有界等待。等待超时不等于实验失败、预算耗尽或取消。`wait:false` 仅用于有实际理由的一次状态读取，不组成高频轮询。

维持多路并行时，等待返回后先处理已经完成的通知并核对全部在途研究，再决定补位和下一次等待；不要连续对单个慢 job 等待十分钟而忽略其它已结束研究。等待时长应兼顾最近的研究截止时间。收取研究报告后继续核对对应自动集成事件的最终状态，`QUEUED` 只表示已安排，不能记作版本生成成功。

集成 FAILED 时核对 first_error、last_error、retryable、failure_count 和失败记录。retryable:false 表示自动重试已停止，反复读状态不会修复符号或证据冲突；保留原事件与冻结输入，后续通过作者正常编写、测试、提交新 revision 产生新集成。允许重试的同一事件沿用已冻结的选择，不因后来加入候选就改写旧决策。不能删除旧 selections/spec、换事件 ID 重放同一失败提交，或把失败改记为成功。

符号冲突按错误中的实际 `symbol_prefix` 和冻结选择中的候选定位；集成同时使用历史候选，报错不一定由最新提交引起。`kernel_id` 与 `symbol_prefix` 是不同字段，不把“前缀重复”解释为“同 kernel_id 禁止提交新 revision”，也不在未定位冲突候选前要求重写、重测无关 kernel。

需要核对时间或预算时读取 `meteor_status`：`observed_at` 是宿主当前观察时间，存活研究的 `wall_time` 给出 `deadline_at`、`elapsed_seconds`、`remaining_seconds`、`exhausted`。`inactive/unknown` 的空值不是零预算；历史已完成研究不会因今天的时间被重新判为到限。不要为取时间另起 PowerShell。Chief 不调用只属于原研究 subagent 的 `meteor_run_status/meteor_run_control`，也不把 research ID 当作实验 request ID。

判断研究已运行多久时使用宿主的 `elapsed_seconds`，或把 `created_at` 与 `observed_at` 转为同一时区后计算差值；Goal Round 数、等待次数和本地钟面时间不能代替经过时长。`checkpoint.json` 是研究保存的阶段记录，不是原生会话心跳；停留在 `created`、保留 `agent_session_id:pending` 或暂时没有新文件，都不能单独证明 child 没有工作。因停滞考虑取消或替换前，核对原 job 状态、最新可见会话活动及正在等待的工具；读取和分析现有证据也是活动。若没有足够的进度信息，应保留“进度未知”，不要把旧 checkpoint 写成已确认闲置，也不要据此重开同一研究或重置预算。

Chief 收尾远端请求时先用 `meteor_control({research_id, action:"requests"})` 读取该研究保存的请求身份；有同名 target 时补上 `target`。然后以其中的 `request_id` 或 `remote_request_id` 调用 `poll_request`、`collect_request` 或 `cancel_request`。这些操作在原 child 结束后仍可用，只查询、收取或取消已经登记的原请求，沿用冻结的 target/runtime/profile，不启动实验、不恢复已结束的 Agent，也不改变其预算/终态。收取的是原始远端证据，不能代替作者的正式 full 回执或补成新提交。`build_id`、`run_id`、`research_id` 都不能当请求 ID。旧研究若没有请求登记，工具会说明缺口；保留原回执和未确认状态，不猜 ID 或用新实验探测。

这个等待会挂起 Chief 当前工具调用，后台 subagent 继续运行；Chief 不能在同一次等待尚未返回时又执行其他工具。有独立工作时可先做，没有时直接等待。不要使用 PowerShell `Start-Sleep`、空转脚本或另建 Agent 来模拟等待，也不要猜测存在独立 `sleep` 工具。

已安装官方 0.1.7-rc.2 默认把后台完成通知送给忙碌 Chief 的下一步，或唤醒空闲 Chief；实际通知策略以部署配置为准。**但 active 且 armed 的 goal driver 不检查 jobs 是否仍在运行**：直接结束当前轮次可能立刻开始下一 Goal Round，不能靠反复结束空轮次静默等待。持续 goal 下只剩等待时用上述原生有界等待。没有已激活持续 goal 且已确认完成通知能唤醒当前 Chief 时，才可结束轮次等通知；通知策略未知、quiet 或已达唤醒上限时继续有界等待。不要为等待而擅自暂停用户 goal；收到终态后收取报告/自动集成回执并继续决定下一轮。

当前接口已核对安装包 0.1.7-rc.2 的 `@deepseek-ai/dsh-tool-jobs/lib/index.js` 和 `@deepseek-ai/dsh-goal-round-driver/lib/index.js`。历史源码参考：alpha.2 的 [job 工具](https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/jobs/tool-jobs/README.md)、[goal driver](https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/goal/goal-round-driver/src/index.ts)。`wait_agent` 属于实验性 Agent Teams，不用它等待 Meteor 的普通 job。

### 收尾与资源释放

收取终态 job 的报告及自动集成结果，确认没有未收取的远端请求，再结束本轮管理。Meteor 在研究结束、失败或取消时调用原生 run 的 `dispose()`，释放会话运行实例；DSH 保留 child catalog、transcript 与 job 历史，这些记录仍可见不代表 Agent 仍在运行。

收尾证据按仓库的产物种类/op/dtype 查询，优先使用工具返回的实际引用。草稿在 `research/<op>/<dtype>/<research_id>/`，设计与事前快照在 `ir/<op>/<dtype>/<research_id>/`，构建、测量与对照分别在顶层 `builds/measurements/comparisons` 的对应 target 下。只搜索 research 子目录不能判断这些回执不存在。分别核实 open、expected、freeze、build、test、compare 各阶段：已有 `EXPECTED_SAVED` 不表示已经 freeze 或实现，未构建也不表示设计从未 open。缺少引用时说明已核查范围和未确认项。

已安装官方 DSH 0.1.7-rc.2 的 job 工具有 `job_output`、`job_list`、`job_kill`，子智能体控制工具有 `send_message`、`interrupt_agent`，没有通用的已完成记录删除工具。不要猜 `subagent_delete`、对已完成 job 反复 kill，或删除研究目录、数据库、会话历史来“清理”。需要停止仍在进行的 Meteor 研究时用 `meteor_control`，随后收取原 job 终态；若远端释放尚未确认，按原 request_id 查询，不能把本地终态当成远端已释放。

### 同机实验自动排队

SSH 后端自动把 build、probe/full test、profile 和设备探测放进远端 FIFO 队列。同一 SSH 用户在同一台机器上默认只有一个执行名额，跨 research、项目目录、profile 别名和 device_id 共用；整次 full 测试与其独立 profiler 采集占用同一名额，结束后才轮到下一请求。Chief 可以让多个 subagent 并行研究，测试调用由编写者发起并自动等待，Chief 无需手动安排或补测。

工具会一直等待原请求的结果。排队状态不是失败、设备不支持或假设结论。远端 poll/collect 返回的 `state.state: queued` 与 `queue` 给出 ticket、position（0 为执行中、1 为下一位）、active_request_id 和等待时间；最终 raw receipt 保留排队耗时，不能将它算作 kernel 延迟。SSH 断线后查询原 request_id，禁止因为等待而重复提交、换 ID 重试、用 shell 绕过测试器或删除锁文件。

取消标记会让排队请求退出；执行中的命令停止并确认释放后才可声称名额已释放。`remote_release_confirmed:false` 仍需按原请求查询。等待不消耗设备命令的执行超时，但仍占研究的墙钟预算；Chief 根据队列积压减少新研究的并行度，不擅自扩预算或将未测 case 伪装成 UNSUPPORTED。跨 SSH 用户需要由集中 profile 的 `queue_root` 指向同一已配置权限的本地目录；不要给每轮研究分配不同队列来绕开串行限制。

超时或异常的 `FAILED` 也要检查 `remote_release_confirmed` 与原始队列回执；旧版响应可能只保留错误文字，字段缺失不等于已经释放。原活动研究作者用 `meteor_run_status/meteor_run_control`；Chief 用上述 `meteor_control` 请求管理动作读取原请求。报告分别列出 research、request_id、remote_request_id 及 build/run 回执引用，不能混称为 request ID。不用新 ID 重跑来检查是否恢复；只有明确释放确认才能在报告中记为已释放，未知状态仍保留原请求。

Chief 可根据已完成报告和可复现的行为缺口改进项目现有 `prompts/meteor.md` 或这两个 skill，记录修改依据；修改只影响未来 research 的快照。保留正在运行的 snapshot、原始证据和研究结果，不向运行中的 Agent 中途喂提示，不代写最终提交。继续使用一份 persona 和两个 skill，不新增角色 prompt。新研究仍由 Chief 明确调用启动，插件和研究 Agent 不递归创建研究。

Chief 负责维护仓库，功能分支使用 `<type>/<kebab>` 命名；`main`/`dev` 仅经 PR 合入，无需他人审核。只有用户明确允许时才创建 PR，开展研究不构成 PR 许可。提交说明和交付报告区分人类设计、Agent 自主决策、成熟实现借鉴，并写明验证与限制。

所有模型/API 和 SSH 凭据由已有集中配置管理，不能写入 persona、skill、启动目标、材料或报告。

## 研究 Agent：在原会话内实验

研究 Agent 在原 session 内决定调用顺序和实验参数；测试过程不另建 Agent、不触发分桶、不决定假设真假。

按启动包给出的实际 `contracts_ref`、`operator_contract_ref`、`kernel_template_ref` 和 case suite 路径读取模块接口、算子约定与测试模板，核对硬件报告；不要猜文件名。再按具体缺口查找少量相关 kernel 或官方示例。有了足以执行的假设就保存计划并做第一个实验；按工具 schema 填参数，无需通读提交校验或数据库源码。后续检索围绕具体编译错误、正确性差异或机制问题展开。长源码分文件或分段写入，保持原会话中的实验计划和记忆。

初始库为空时自行编写符合 ABI 的最小设备基线，优先参考官方实现。用 `meteor_write_file` 创建本轮 `drafts/<kernel>/<revision>/kernel.json`、`device.asc`、`host.asc`，按下面顺序先写预期活动注释再实现。`meteor_write_file.path` 相对本轮研究目录，返回实际路径；`meteor_kernel_build.kernel_path` 使用该模块的实际目录或清单路径。参考文件与旧 kernel 只是启发材料，采用后仍须完成本轮设计和测试。每个预测与推荐范围核对当前 suite 的真实 shape，超出部分只列为待验证。预算未耗尽且仍有可行实验时继续，不能把尚未编写的源码当作外部阻塞。

### 四步设计与验证

计算图 IR 和执行 IR 都写在 kernel 源码结构化注释中。计算图符合公式，执行 IR 的计算语义符合计算图，主体描述预期硬件活动。**先写预期活动注释 → 写实现代码 → 看实际活动 → 对照注释找偏差。** 理想活动是目标，代码是实现手段。

- 创建 `kernel.json` 后调用 `meteor_design({action:'open',experiment_id,kernel_path})`，读取返回的 `guide_ref`。源码先只有两类 IR 注释／空文件，`check stage:'expected'` 保存事前快照；随后填入代码和活动标记，再 `check stage:'implementation'`、`freeze`。
- 构建时传 `design_ref`。新的 SSH 候选不能绕过设计；历史回执仍可读取，只有显式 mock fixture 可走注明模拟的协议兼容路径。不要把一套设计回执用于另一 research、target、experiment 或 revision。
- 测试与 profile 仍由你在当前 session 按需调用。用 `meteor_design compare` 关联实际回执并写符合、偏差和未知项，不用整体计时代替逐活动观测，不自动判定假设。
- 需要改预期时新建 design attempt，先保存注释再写实现；freeze／构建后改变源码时新建 revision。原预期、已测源码和原始回执保持可追溯。`ir/` 只保存工具产生的快照与派生视图。
- 修改少量内容时，用 `meteor_write_file` 的 `mode:'replace'`、唯一匹配的 `old_text` 和替换 `content`；不用反复生成整份源码。完整文件仍受原设计和路径校验约束，已保存的预期不能借局部替换改写。
- 原语、数值规则和完整 A3 活动目录见 `guide_ref` 同目录的 `reference.md`。按真实 HW 选择活动；当前解析检查不证明任意 C++ 全域等价，也不承诺每项活动都有真机时间线。

1. 核对 chief 的启动输入、原假设和实验计划，固定 research_id、experiment_id、kernel revision、case_suite、oracle、环境与测量协议。补齐给定假设的实验定义；实质修订时保留原文、原因和原假设状态，不以修订成立替代原目标的验证。
2. 先完成上述注释设计及实现阶段，再冻结模块。确认 launcher、设备计算及 launch 调用均实际实现后才构建；纯注释是合法的事前设计阶段，不是可执行候选，也不能用来制造编译失败作为停止依据。缺少 host/device 或路径错误时在本实验内修复。目标计算在 AI Core/Vector 上实现，Host 负责调度；禁止 CPU/NEON 替算、占位 device kernel 和跨实现 fallback。已经冻结的源码或依赖变化时创建新 revision。
3. 调用 `meteor_kernel_build`，输入 experiment_id、kernel_path、design_ref；kernel_path 可指模块目录或 kernel.json，research_id 由宿主绑定当前 session。检查 source_hash、artifact_hash、设计与模块身份、硬件/编译目标、simulated 标记和构建状态。

   首次编写和遇到编译/正确性障碍时阅读 [Ascend 编写与编译诊断](references/ascend-authoring.md)。构建失败时读取诊断和 raw_receipt_ref，修复第一处具体错误并以新 revision 重建。例如 launcher 未声明时实现清单声明的 ABI 函数和实际设备调用，纯标量 kernel 无法推导执行类型时检查显式类型属性；这是候选代码的开发工作。预算还有余量且有可执行修复时，在当前 session 继续迭代，不用多次不同编译错误推导工具链不支持该算子。
4. 可调用 `meteor_kernel_test` 的 probe 模式调试选定 case。probe 不替代 full。若计划包含设备健康探针，先从当前 build 的支持集合选取小 case，再核对 PASS、有效样本、目标设备任务见证及本请求的释放确认。仅顶层 COMPLETED、快速返回或 UNSUPPORTED 不满足设备健康判据；误选不支持的 case 时保留该判据未满足，是否另测仍受原预算约束。一次成功也不保证后续队列空闲或其它请求已释放。
5. 调用 full 模式独立执行这个 revision 的 case 全集。检查每个 case 的 PASS/INCORRECT/UNSUPPORTED/RESOURCE_REJECTED/RUN_FAILED/TIMEOUT/NOT_RUN、原因、实际实现身份、原始样本和 input/oracle hash。
6. UNSUPPORTED 是显式终态，不运行其它 kernel 代替。正确性通过且有效执行才能记录计时。accounting_complete 与支持/计时 case 数量分别核对。“全尺寸”是固定 suite 全集；它不覆盖未列出的 shape，不能将几个离散 case 写成其整个包围区间已验证。
   suite 总数来自本研究冻结的 case-suite.json 实际 cases 数组，并与 full 的逐 case 行核对；revision 字符串中的数字、旧报告或初始材料不代表 case 数量。

   在 192-case 预设下，少量 probe 或旧 4-case 成绩不能替代本轮 full。根据真实源码/设备限制声明子域，不删大 case、不以虚构 UNSUPPORTED 掩盖错误或超时。probe 的少量 `case_ids` 是本次调试选择，不直接作为实现支持域；不能仅为缩短 full 将其余可支持 case 改成 UNSUPPORTED。报告同时列出 suite 总数、实际执行/通过/计时数和未支持数，例如“192 行完整记账，11 PASS、181 UNSUPPORTED”；不能简写成“全尺寸 11/11 全通过”。full 的耗时和 profiler 成本纳入预算，优先用代表性 probe 排除明显错误。
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

超时或操作失败后只得到 `NOT_RUN` 行时，先按[失败状态与超时阶段](references/ascend-measurement.md#失败状态与超时阶段)区分排队、算子宿主子进程、采集和传输。缺少输出不证明程序未启动，新探针也不能代替旧请求的释放确认。

显式的协议测试可使用 mock，但不得替代初始化设备准备或真实性能证据。真实后端只引用集中 SSH profile，不读取或复制凭据。工具缺陷保留输入与错误给 Chief；不要修改测试器、冻结快照、原始回执或 importer 来迁就当前交付。
