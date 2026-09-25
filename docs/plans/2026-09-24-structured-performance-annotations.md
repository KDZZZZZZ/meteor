# Meteor 结构化性能注释：目标与测量约束

状态：需求与测量约束，尚未实现。具体注释格式、串并行模型和证据数据结构待另行设计。

接入边界见[可替换的 kernel 实验设计步骤](2026-09-25-pluggable-kernel-design-step.md)，公共目录与身份见[单 HW workspace 仓库级改造](2026-09-25-single-hardware-workspace-restructure.md)。

分层策略采用“公式 → 计算图 IR → 硬件原生代码（如 Ascend C）”。HW 共享预测编译从原生代码出发，生成对应条件的预测执行 IR；真实编译产生硬件指令，运行 case 后，将不同 case/运行条件的实际执行情况转述为执行 IR。执行 IR 的原语由真实硬件能力决定，预测与实测转述按相同源码、构建配置和运行条件对照。本文保留性能分析与测量需求，具体注释格式和证据 schema 待重新设计。

## 1. 目标与约束

让研究 subagent 在写 kernel 时说明：哪些代码完成哪些工作、消耗什么资源、哪些操作必须等待、哪些操作可能重叠，以及需要什么实验才能检验这些判断。工具从注释生成可执行的测量计划，采集后把可追溯证据呈现在对应代码旁。

保持 Meteor 已确定的职责：chief 准备设备并管理研究；一个连续 subagent 自主编写、测试和分析；测试与分析仍是现有两个 skill。每个交付 kernel 的精确 revision 由作者完成独立全尺寸测试，最后程序自动集成。注释不会自动启动研究、改写 kernel、判定假设或选择集成版本。

首版以 Ascend 后端为实现目标，借鉴 NVIDIA/AMD 的观测方法；不同时开发三个硬件后端。设计必须在现有 Node/Python 工具中落地，不增加编译器框架或第三方运行依赖。

## 2. 测量与证据原则

**源码内放作者的分析和测量意图；工具产生独立、不可变的测量证据；再生成带证据注释的源码视图。** 三者通过源码、构建、实验和区段身份关联。

必须保留以下区别：

| 信息 | 谁产生 | 能说明什么 |
| --- | --- | --- |
| 作者声明 | subagent | 预期工作量、依赖、资源竞争和待验证预测 |
| 静态推导 | 保留来源与前提的计算 | 逻辑工作量与资源需求，作为待验证的分析 |
| 原始观测 | profiler / 测试器 | 特定条件下实际记录到的事件、时间、计数或样本 |
| 分析结论 | subagent 引用证据 | 这些观测如何支持或反驳某种解释，以及剩余混杂 |

例如，源码推导出逻辑读取 4 KiB，并测得 kernel 10 µs，可以得到“逻辑工作量 / kernel 时间”的派生速率；不能写成硬件实测 HBM 带宽，也不能把这 10 µs 填到读取阶段。

## 3. 成熟实现提供的依据

以下是方法借鉴，不声称相关能力已被 Meteor 或当前设备支持。

| 参考 | 借鉴内容 | 不能直接推出的结论 |
| --- | --- | --- |
| [NVIDIA Nsight Systems 2026.4](https://archive.docs.nvidia.com/nsight-systems/2026.4/UserGuide/index.html) / [Nsight Compute 2026.2](https://archive.docs.nvidia.com/nsight-compute/2026.2/NsightCompute/index.html) | 稳定区段标识、运行关联、源码/指令映射、区分普通运行和诊断重放 | Host range 的墙钟时间不等于异步 GPU 区段时间 |
| [AMD ROCTx ranges](https://rocm.docs.amd.com/projects/rocprofiler-sdk/en/docs-10.0.0/api-reference/rocprofiler-sdk-roctx_api/roctx_modules/ranges.html) / [ROCprofiler-SDK](https://rocm.docs.amd.com/projects/rocprofiler-sdk/en/docs-10.0.0/what-is-rocprofiler-sdk.html) | 标注与实际 dispatch 关联；区分范围、dispatch 计数、PC 采样、指令 trace | 标签本身不能提供每个设备阶段的精确时长 |
| Ascend TPipe/TQue | 显式阶段、队列同步、缓冲生命周期和跨迭代复用 | double buffer 配置不保证运行时一定重叠 |
| Ascend msOpProf | 按工具和芯片能力选择源码、区段或指令诊断 | 文档有某种模式不代表当前 CANN/芯片/runner 支持 |
| XProf | 把静态工作量、观测时间和派生速率分别保存 | 编译器估算的 bytes 不是实测总线流量 |

Ascend 的 `InitBuffer` 文档区分实际分配块数与队列声明；注释应绑定实际 buffer 配置，而非只见到队列或“double buffer”字样就推断并行。[官方 InitBuffer 说明](https://asc.gitcode.com/api/SIMD-API/basic_api/resource_management/TPipe/InitBuffer.html)

XProf 明确区分编译器静态 FLOPs/bytes 与 profiler 时间，再据此计算速率。这支持把来源和推导链作为独立字段。[HLO Op Profile](https://openxla.org/xprof/hlo_op_profile)

Ascend 新版文档中的 Source、KernelScale、timeline 等模式有编译选项和产品范围限制；当前机器已验证的是 CANN 9.0，不能根据更新版本文档直接启用。[MindStudio 26.1 msOpProf](https://www.hiascend.com/document/detail/en/mindstudio/2610/optools/Operatordevelopmenttools/docs/en/user_guide/msopprof_user_guide.md)

Nsight Compute 的 Range Replay 可以保留范围内并发，但计数归属整个范围；软件插桩及重放会改变采集开销。AMD 的 dispatch counter 采集可能串行化同一 GPU 上的 kernel，PC sampling 和选中 CU 的 trace 又有不同粒度。因此计划必须选择需要的观测粒度，并把重放、串行化和采样范围带进报告。[Nsight Compute Profiling Guide 2026.2](https://archive.docs.nvidia.com/nsight-compute/2026.2/ProfilingGuide/index.html)、[ROCm Compute Profiler 3.8 Profile Mode](https://rocm.docs.amd.com/projects/rocprofiler-compute/en/docs-10.0.0/how-to/profile/mode.html)、[ROCprofiler PC Sampling](https://rocm.docs.amd.com/projects/rocprofiler-sdk/en/docs-10.0.0/how-to/using-pc-sampling.html)

以上链接于 2026-09-24 查阅。版本化 GPU 文档用于设计借鉴，不代表要把这些工具安装到当前 Ascend 机器；Ascend 开发分支文档的能力需再对照实际安装版本核验。

## 4. 从注释到可执行测量计划

注释表达“要观察什么”，后端决定“本设备怎样观察”。不允许注释携带 shell、SSH 命令或任意脚本片段。

1. **校验输入。** 读取固定 suite、hardware report、候选源码/构建身份和当前研究预算；检查作者分析与测量意图。
2. **列出实验任务。** 把必要的正确性检查、普通测量和可选诊断明确列出；对照版本必须指向实际 build，不能只给一个名字。
3. **解析能力。** 将所需观测与设备、工具版本、编译条件和已实现 adapter 匹配。不支持时生成 `UNAVAILABLE` 及原因，不映射成名字相似但含义不同的指标。
4. **生成声明式测试脚本。** `plan.json` 是权威执行输入，由固定执行器解释执行；`reproduce.md` 保存调用同一 DSH 工具的参数。具体采集命令来自固定 adapter，不生成可脱离 session 直接调用 runner/SSH 的独立脚本。
5. **由原 subagent 决定执行。** 解析本身不触发远端运行。subagent 在既有预算和队列下调用测试/profile；失败、取消和远端状态未知沿用既有生命周期。
6. **汇总并回填。** 工具绑定观测与目标区段，生成报告、证据索引和源码视图。原 subagent 分析矛盾、修订解释或编写下一版。

### 4.1 三种运行分开

| 类型 | 用途 | 能否用于最终性能排名 |
| --- | --- | --- |
| `benchmark` | 原始候选，无新增设备插桩，固定正确性与计时协议 | 匹配提交协议的 full 数据可以 |
| `diagnostic` | 计数器、源映射、指令 trace、区段插桩等 | 不能直接替代普通全尺寸计时 |
| `intervention` | 作者编写的消融/对照 revision 或显式受控参数组合 | 作为独立候选，需自己全尺寸测试 |

诊断需要 `-g`、trace 宏或插桩时，生成单独的诊断 build，记录父 build、完整编译命令和 ELF 哈希；不把它伪装成原 build。自动生成采集脚本不等于自动合成正确的消融 kernel。代码或设备执行逻辑的变化仍由 subagent 编写并校验。

计划记录 warmup、原始样本数、重复块、顺序 seed、缓存/频率策略、测量边界、预计 profiler passes、资源锁、总时限与停止条件。现有 3 次 warmup / 5 个普通样本是起点，不天然保证能辨别小差异；需要时在预算内生成配对复测计划。报告必须给样本及噪声限制，不根据预期结果临时挑样本或补次数直至显著。

数值预测的判定规则在采样前固定 baseline 的实际 build、按 case 配对方式、最小有意义效应及单位、最低独立重复块数、噪声处理、支持/反驳/不确定条件，以及哪些 case 属于原始预测。顺序效应、同一次运行内相关样本和多 case 筛选都应考虑；五个内部样本不能冒充五次独立实验。非数值的机制预测可以使用明确的事件/数据流观测规则。规则尚未定义时计划只能用于探索，报告不输出规则满足与否。

自动报告至多计算某项观测是否满足预先定义的规则；它不自动给研究假设下结论。若“流量减少”和“延迟降低”是两项预测，前者成立而后者不成立应分别记录，再由 Agent 分析原命题及混杂。未检测到显著差异本身也不构成等价或无收益的证明。

case selector 只从当前固定 suite 解析。针对性诊断可以用子集；无论注释声明了多少个区域，每个交付 revision 都仍须独立 full。新增 shape 是后续新 suite 的显式实验，不偷偷纳入既有提交。

### 4.2 当前 Meteor 能力与首版降级

当前 SSH driver 公开 `kernel_time_us` 与 `device_task_time_us`。前者是普通 ACL event 区间；后者来自独立 msprof 中匹配任务的 duration，当前聚合可能包含 warmup，且不与五个普通样本一一配对。当前并未导出完整 pipe/带宽/cache/occupancy counter 映射。

因此首版可以自动回填**整个候选 kernel 的观测**、匹配设备任务的证据、逐 case 对比和静态工作量。某个 Load/Compute 区段的精确耗时、实际重叠率或 stall 原因没有适配器支持时明确留空。不能把 whole-kernel latency 按操作数比例拆分成 region 的实测值。

首版适配器读取当前回执时保留实际采集与聚合语义。后续若要支持精确任务配对，必须扩展原始数据的 phase、launch ordinal、correlation/task 标识后再使用，不能事后猜哪些样本属于 warmup。

## 5. 如何真正把报告补到注释里

现有 Meteor 对 source_hash/revision 实施不可变约束。直接给已测试的 `device.asc` 添注释也会改变哈希。因此采用以下默认方案：

1. 作者源码连同事前分析注释在 build 时冻结。
2. 真实回执保持不可变，结构化知识库保存对应证据引用。
3. 工具生成带证据说明的源码阅读视图，在对应代码旁展示可追溯观测；明确原文件、原哈希和“仅供阅读”。
4. 生成视图不能作为 `kernel.json` 的构建/交付源路径；构建入口检查保留标识，防止误编译。正式提交仍指向原始被测源码，报告同时链接带注释视图。
5. 作者继续编码时创建新 revision，保留分析意图，旧测量引用只作为历史。新候选的真实性能重新测。

有真实数据时由工具复制观测 ID、值、单位、范围和回执引用；不会要求模型重新抄数。原 subagent 在 `analysis.json` 补充成本解释、与预测的差异和下一步实验，工具再渲染到注释视图。这样满足“代码旁补齐实测分析”，又不破坏原测试证据。

不采用“忽略所有注释再计算 source_hash”：这会改变已有身份契约，也可能掩盖宏、行号或生成过程的影响。若必须把证据注释写回可编译源码，应作为新 revision 构建并履行正常测试要求；首版不为此新增哈希豁免。

## 6. 接入位置与文件结构

正式产物按[仓库级改造方案](2026-09-25-single-hardware-workspace-restructure.md)中的“产物种类 → op → dtype”归档；shape 保留在 case 与自动路由中。

原始 profiler 文件由现有 runner 保留，报告和源码阅读视图保存其引用。知识继续使用 workspace 的结构化 catalog 与内容寻址 artifact；重新渲染视图、重复导入或修改措辞不会刷新新鲜度。

测量计划由原 Agent 通过现有测试/分析 skill 使用，在同一研究 session 的身份、预算、设备队列与远端状态检查下执行。具体注释解析器、字段、模型及观测映射协议另行定义。

## 7. 对现有两个 skill 的改动大纲

这里只定义未来改动，功能落地前不向运行中的 Agent 注入不可调用的新接口。

### meteor-kernel-test

- 在主要代码旁说明预计开销、等待与并行关系，以及需要验证的问题。
- 根据固定 case、真实设备能力与预算安排验证；先确认需要的观测能被现有工具采集。
- 由原会话选择执行普通测试、针对性 profile 或新的对照实验；处理失败并保留证据。
- 每个交付 revision 仍独立 full；生成视图和诊断 build 不替代正式候选。

### meteor-performance-analysis

- 先区分作者估算、静态推导、直接观测和因果解释，再分析开销及串并行。
- 读取工具生成的证据，给出支持、冲突、未知项和下一个最有区分力的实验；不抄造区域耗时。
- 预测与结果不符时检查单位、范围、尾块、缓存、调度、资源争用、profile 扰动和代码映射。
- 把证据关联的机制知识入库，保留适用范围；向 chief 报告假设结论、kernel 实绩和下一步建议。

## 8. 后续实现的验收边界

具体格式与数据结构确定后，实现仍须满足：

1. 原 subagent 编写分析、主动执行测试/性能采集、读取报告并决定下一实验，研究上下文连续。
2. 缺少区段观测能力时如实保留未知项；整 kernel 耗时不能拆填为各阶段实测值。
3. 诊断采集的重放、串行化、采样范围和插桩条件保留在报告中，不能替代普通全尺寸成绩。
4. 生成源码阅读视图前后，已测源码与原始回执哈希保持不变；新 revision 重新测试。
5. 重复渲染或导入不刷新知识新鲜度；所有提交 kernel 均由作者完成逐 case 全尺寸测试。
6. 没有预定义规则、样本不足或只看到不显著差异时，不自动判定假设；假设结论与 kernel 排名分别报告。

## 9. 决策记录与风险

| 决策 | 选择依据 | 代价/风险与处理 |
| --- | --- | --- |
| 注释是声明，不是源码语义证明 | 任意 C++/Ascend C 自动推断不现实 | 检查结构与明显矛盾，运行事实独立验证 |
| 按能力降级的采集计划 | 官方功能受芯片和版本限制 | 报告会有未知项；给出需要的下一种证据 |
| 生成带注释视图 | 保留精确源码/回执不可变契约 | 增加派生文件；由工具生成并清楚链接原文件 |
| 原 Agent 控制执行 | 保持用户确定的研究循环 | 自动化负责可靠执行与报告，Agent 负责下一实验选择 |
| 先 whole-kernel，后区段 | 当前接口和设备已有证据支撑 | 首版不承诺每段真实耗时，明确后续能力门槛 |

“要求显式分析并联动测量、回填证据”来自人类；保留已测源码、生成独立阅读视图和按设备能力安排采集是 Agent 的建议。厂商方法只作上述明确借鉴。相关能力尚未实现或通过真实 kernel 实验验收。
