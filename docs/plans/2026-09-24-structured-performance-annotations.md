# Meteor 结构化性能注释设计

状态：设计提案，尚未实现。本文件中的新字段、新工具和新目录均为拟议接口。

## 1. 目标与约束

让研究 subagent 在写 kernel 时说明：哪些代码完成哪些工作、消耗什么资源、哪些操作必须等待、哪些操作可能重叠，以及需要什么实验才能检验这些判断。工具从注释生成可执行的测量计划，采集后把可追溯证据呈现在对应代码旁。

保持 Meteor 已确定的职责：chief 准备设备并管理研究；一个连续 subagent 自主编写、测试和分析；测试与分析仍是现有两个 skill。每个交付 kernel 的精确 revision 由作者完成独立全尺寸测试，最后程序自动集成。注释不会自动启动研究、改写 kernel、判定假设或选择集成版本。

首版以 Ascend 后端为实现目标，借鉴 NVIDIA/AMD 的观测方法；不同时开发三个硬件后端。设计必须在现有 Node/Python 工具中落地，不增加编译器框架或第三方运行依赖。

## 2. 核心决定

**源码内放作者的分析和测量意图；工具产生独立、不可变的测量证据；再生成带证据注释的源码视图。** 三者通过源码、构建、实验和区段身份关联。

```mermaid
flowchart LR
    A[作者写源码与结构化注释] --> B[解析与契约检查]
    B --> C[工作量、依赖与资源模型]
    C --> D[按真实设备能力生成测量计划]
    D --> E[原 subagent 选择并调用测试或 profile]
    E --> F[原始回执与不可变证据]
    F --> G[报告与带证据注释的源码视图]
    G --> H[原 subagent 分析并决定下一实验]
    H --> A
```

必须保留以下区别：

| 信息 | 谁产生 | 能说明什么 |
| --- | --- | --- |
| 作者声明 | subagent | 预期工作量、依赖、资源竞争和待验证预测 |
| 静态推导 | 工具计算，保留声明前提 | 逻辑字节数、操作数、缓冲占用、理想调度下界 |
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
| MLIR GPU async tokens | 用显式完成依赖表达异步操作，分别表示入队和完成 | 不把源码先后顺序当作全部设备执行依赖 |
| XProf | 把静态工作量、观测时间和派生速率分别保存 | 编译器估算的 bytes 不是实测总线流量 |

Ascend 的 `InitBuffer` 文档区分实际分配块数与队列声明；注释应绑定实际 buffer 配置，而非只见到队列或“double buffer”字样就推断并行。[官方 InitBuffer 说明](https://asc.gitcode.com/api/SIMD-API/basic_api/resource_management/TPipe/InitBuffer.html)

MLIR 的异步 GPU 操作以 token 表达完成依赖；这里只借鉴其依赖语义，不引入 MLIR。[GPU dialect](https://mlir.llvm.org/docs/Dialects/GPU/)

XProf 明确区分编译器静态 FLOPs/bytes 与 profiler 时间，再据此计算速率。这支持把来源和推导链作为独立字段。[HLO Op Profile](https://openxla.org/xprof/hlo_op_profile)

Ascend 新版文档中的 Source、KernelScale、timeline 等模式有编译选项和产品范围限制；当前机器已验证的是 CANN 9.0，不能根据更新版本文档直接启用。[MindStudio 26.1 msOpProf](https://www.hiascend.com/document/detail/en/mindstudio/2610/optools/Operatordevelopmenttools/docs/en/user_guide/msopprof_user_guide.md)

Nsight Compute 的 Range Replay 可以保留范围内并发，但计数归属整个范围；软件插桩及重放会改变采集开销。AMD 的 dispatch counter 采集可能串行化同一 GPU 上的 kernel，PC sampling 和选中 CU 的 trace 又有不同粒度。因此计划必须选择需要的观测粒度，并把重放、串行化和采样范围带进报告。[Nsight Compute Profiling Guide 2026.2](https://archive.docs.nvidia.com/nsight-compute/2026.2/ProfilingGuide/index.html)、[ROCm Compute Profiler 3.8 Profile Mode](https://rocm.docs.amd.com/projects/rocprofiler-compute/en/docs-10.0.0/how-to/profile/mode.html)、[ROCprofiler PC Sampling](https://rocm.docs.amd.com/projects/rocprofiler-sdk/en/docs-10.0.0/how-to/using-pc-sampling.html)

以上链接于 2026-09-24 查阅。版本化 GPU 文档用于设计借鉴，不代表要把这些工具安装到当前 Ascend 机器；Ascend 开发分支文档的能力需再对照实际安装版本核验。

## 4. 注释格式

采用 C/C++ 块注释中的严格 JSON，统一以 `@meteor` 标识。每个块都有 `v` 和 `kind`。使用 JSON 是为了复用现有解析能力、拒绝歧义输入和避免引入 YAML 依赖。

### 4.1 最小信息量

不要求逐行注释。作者为主要计算阶段、显著数据搬运、归约和同步边界定义 region；未建模的部分明确列出。每个主要 region 必须回答五个问题：

1. 一次执行做多少计算、搬运或同步？按什么单位计数？
2. 运行在 Host、哪个设备执行域或尚不确定的执行域？
3. 谁可以并行，谁必须串行，原因和同步位置是什么？
4. 使用哪些有限资源，何时释放？
5. 需要什么证据才能知道这个分析是否符合实际？

不知道耗时可以写未知；不能为了满足格式猜一个 cycles/us 数值。简单 kernel 可以只有一个计算 region。格式完整不代表分析正确。

### 4.2 块类型

| `kind` | 作用 | 主要字段 |
| --- | --- | --- |
| `kernel` | 本次代码的建模上下文 | `id`, `hypothesis_ref`, `parameters`, `loops`, `buffers`, `unmodeled` |
| `region` | 开始一个静态源码区段 | `id`, `purpose`, `execution`, `instances`, `work`, `resources`, `reasoning`, `questions` |
| `end` | 结束对应区段 | `id` |
| `edge` | 区段之间的依赖或缓冲复用关系 | `from`, `to`, `relation`, `distance`, `mechanism`, `source_anchor`, `reasoning` |
| `expectation` | 本轮需要验证的性能预测 | `id`, `hypothesis_ref`, `targets`, `comparison`, `predicted_change`, `decision_rule`, `confounders` |
| `evidence` | 工具生成的观测索引，仅存在于生成视图 | `target`, `context_ref`, `observations`, `analysis_ref` |

region 的开始与结束标记决定字节区间，工具计算文件哈希、字节偏移和展示行号。行号不是持久身份。作者的稳定 ID 便于跨 revision 比较，但不能据此继承旧性能证据。

使用可识别 C/C++ 字符串、raw string、行注释和块注释的词法扫描器提取标记，不能用跨文件正则表达式猜代码边界。标记必须独立成行，禁止放在宏定义/续行中。跨文件区段、交叉但非嵌套区段、重复 ID 和没有配对的结束标记直接报错。条件编译下的区段标成待确认，不宣称它一定出现在实际构建中。

### 4.3 示意：tile 加载区段

下面只展示注释协议，省略了实际算子代码；不是可构建候选，也不是性能证据。

```cpp
/* @meteor {
  "v": 1,
  "kind": "region",
  "id": "load_ab",
  "purpose": "装入当前输出 tile 所需的 A/B 数据",
  "execution": {
    "domain": "device",
    "logical_worker": "output_tile",
    "engine_hint": "MTE2",
    "engine_basis": "author_declared"
  },
  "instances": {"loop": "k_tiles", "iterator": "t"},
  "work": {
    "basis": "per_iteration_per_worker",
    "logical_gm_read_bytes": "(TM + TN) * active_k",
    "physical_gm_read_bytes": null
  },
  "resources": [{"buffer": "ab_tile", "access": "write"}],
  "reasoning": "每个 worker 装入一个 A/B tile；物理流量可能受对齐、重复读取和缓存影响。",
  "questions": [
    {"observable": "region_duration", "requirement": "optional"},
    {"observable": "overlap", "with": "accumulate", "requirement": "optional"}
  ]
} */
// 此处是作者编写的实际加载与入队代码。
/* @meteor {"v":1,"kind":"end","id":"load_ab"} */
```

示例变量由 kernel 块定义：`TM/TN/TK` 是有来源的 tile 参数，`t` 是 K 分块循环变量，`active_k = min(TK, K - t*TK)`；M/N/K 来自固定 suite。示例按 int8 逻辑输入计字节，尾块 M/N、padding、重复加载和额外 scale 流量须由作者补入相应 region，不能把片段公式当全算子的物理流量。

表达式仅允许有限数值、声明变量、四则运算及 `min/max/ceildiv/align_up`。禁止 eval、属性访问、文件读写或命令。表达式保留单位和计数基准；未绑定变量、除零、负字节数、溢出或无法确定的动态值均返回具体诊断。参数来自源码声明时记录 `symbol/value/source_anchor`，首版无法静态证明的一律标为作者声明；实际构建参数、编译器导出信息可以提高可信度，不能仅靠注释反向修改源码。

## 5. 串行、并行与资源竞争

### 5.1 必须分开的关系

| 关系 | 含义 |
| --- | --- |
| `enqueue_before` | Host 或控制核先发起 A 再发起 B；不保证 A 在 B 开始前完成 |
| `completion_before` | A 完成后 B 才能消费数据或继续执行，绑定队列、event 或 barrier 位置 |
| `iteration_dependency` | 跨迭代的数据或累加依赖，例如 `accumulate[t] -> accumulate[t+1]` |
| `buffer_reuse` | 上次消费者完成/释放后才能覆盖同一 buffer slot |
| `resource_exclusion` | 同一资源上的工作需要排队；资源由真实架构/工具确认，未知时保留未知 |

“没有依赖边”只说明模型没有声明顺序，不能作为实际并行证据。另记 `may_overlap` 分析结论，说明可能并行的理由和待验证条件。并行 worker 的总数、单核内指令并行和同时驻留数量必须分别表示，不能把 block 数直接写成实际并行度。

### 5.2 双缓冲的跨迭代例子

```text
load[t] 完成  ───────► compute[t] 完成
                         │            │
                         │            └──► load[t+2] 可复用同一槽
                         └───────────────► compute[t+1] 可继续累加

load[t+1] 可能与 compute[t] 重叠：前提是另一个槽可用、同步允许且执行资源允许。
```

对应边：`load -> compute, distance=0`；`compute -> compute, distance=1`；`compute -> load, distance=2, buffer_reuse`。`distance=d` 表示源迭代 t 到目标迭代 t+d。首版只接受非负整数和已声明循环；同一迭代的完成依赖必须无环。跨迭代边按真实迭代次数解释，不会因为模板图看起来有环就拒绝正常流水。

队列深度、实际 buffer 数量、每槽字节数、分配存储域、生产者和最后消费者分别记录。工具计算 buffer 需求时计入所有同时存活槽位、对齐和暂存区；不能只记一个 tile 的大小。容量未知时不通过比较假定可用。

对于 qmq-v1 还要显式表达：K 维累加完成之后才能得到该输出；一行所有输出激活值参与 row max；该行量化依赖这个 row max。若实现跨 block 分摊一行，必须描述真实跨 block 同步或拆分 kernel 的依赖，不能只在注释中画边。

### 5.3 成本计算的边界

分别记录整数 MAC、FP32 运算、逻辑/物理访存、同步和资源占用。以 MAC 为单位时不隐含乘以二；需要算 ops 时注明换算 convention。绝不混合 int8 MAC 和 FP32 FLOPs 得到一个没有定义的利用率。

在已声明模型下可计算工作量与理想下界，例如 `max(依赖关键路径下界, 各共享资源服务时间下界)`；每个数值都保留带宽/吞吐率来源、有效条件与假设。没有阶段观测或校准数据时只显示符号式和未知项，不假装得到实际 critical path。

对于无资源冲突、阶段独立且满足缓冲和循环依赖的理想流水，才可使用 `fill + (tiles-1)*II + drain` 形式。`II` 不能无条件取各阶段时间的最大值；共享引擎、累加依赖、内存竞争和不足的 buffer 都可能加大它。只有完成区间处于同一时钟域、且绑定到确定的任务实例时才计算实测重叠率；不同采集 pass 的区间不能拼出一张“真实时间线”。

## 6. 从注释到可执行测量计划

注释表达“要观察什么”，后端决定“本设备怎样观察”。不允许注释携带 shell、SSH 命令或任意脚本片段。

1. **校验输入。** 读取固定 suite、hardware report、候选源码/构建身份和当前研究预算；解析 region/edge/expectation。
2. **生成任务图。** 把必要的正确性检查、普通测量和可选诊断明确列出；对照版本必须指向实际 build，不能只给一个名字。
3. **解析能力。** 将 `observable` 与设备、工具版本、编译条件和已实现 adapter 匹配。不支持时生成 `UNAVAILABLE` 及原因，不映射成名字相似但含义不同的指标。
4. **生成声明式测试脚本。** `plan.json` 是权威执行输入，由固定执行器解释执行；`reproduce.md` 保存调用同一 DSH 工具的参数。具体采集命令来自固定 adapter，不生成可脱离 session 直接调用 runner/SSH 的独立脚本。
5. **由原 subagent 决定执行。** 解析本身不触发远端运行。subagent 在既有预算和队列下调用测试/profile；失败、取消和远端状态未知沿用既有生命周期。
6. **汇总并回填。** 工具绑定观测与目标区段，生成报告、证据索引和源码视图。原 subagent 分析矛盾、修订解释或编写下一版。

### 6.1 三种运行分开

| 类型 | 用途 | 能否用于最终性能排名 |
| --- | --- | --- |
| `benchmark` | 原始候选，无新增设备插桩，固定正确性与计时协议 | 匹配提交协议的 full 数据可以 |
| `diagnostic` | 计数器、源映射、指令 trace、区段插桩等 | 不能直接替代普通全尺寸计时 |
| `intervention` | 作者编写的消融/对照 revision 或显式受控参数组合 | 作为独立候选，需自己全尺寸测试 |

诊断需要 `-g`、trace 宏或插桩时，生成单独的诊断 build，记录父 build、完整编译命令和 ELF 哈希；不把它伪装成原 build。自动生成采集脚本不等于自动合成正确的消融 kernel。代码或设备执行逻辑的变化仍由 subagent 编写并校验。

计划记录 warmup、原始样本数、重复块、顺序 seed、缓存/频率策略、测量边界、预计 profiler passes、资源锁、总时限与停止条件。现有 3 次 warmup / 5 个普通样本是起点，不天然保证能辨别小差异；需要时在预算内生成配对复测计划。报告必须给样本及噪声限制，不根据预期结果临时挑样本或补次数直至显著。

数值预测的 `decision_rule` 在采样前固定 baseline 的实际 build、按 case 配对方式、最小有意义效应及单位、最低独立重复块数、噪声处理、支持/反驳/不确定条件，以及哪些 case 属于原始预测。顺序效应、同一次运行内相关样本和多 case 筛选都应考虑；五个内部样本不能冒充五次独立实验。非数值的机制预测可以使用明确的事件/数据流观测规则。规则尚未定义时计划只能用于探索，报告不输出规则满足与否。

自动报告至多计算某项观测是否满足预先定义的规则；它不自动给研究假设下结论。若“流量减少”和“延迟降低”是两项预测，前者成立而后者不成立应分别记录，再由 Agent 分析原命题及混杂。未检测到显著差异本身也不构成等价或无收益的证明。

case selector 只从当前固定 suite 解析。针对性诊断可以用子集；无论注释声明了多少个区域，每个交付 revision 都仍须独立 full。新增 shape 是后续新 suite 的显式实验，不偷偷纳入既有提交。

### 6.2 当前 Meteor 能力与首版降级

当前 SSH driver 公开 `kernel_time_us` 与 `device_task_time_us`。前者是普通 ACL event 区间；后者来自独立 msprof 中匹配任务的 duration，当前聚合可能包含 warmup，且不与五个普通样本一一配对。当前并未导出完整 pipe/带宽/cache/occupancy counter 映射。

因此首版可以自动回填**整个候选 kernel 的观测**、匹配设备任务的证据、逐 case 对比和静态工作量。某个 Load/Compute 区段的精确耗时、实际重叠率或 stall 原因没有适配器支持时明确留空。不能把 whole-kernel latency 按操作数比例拆分成 region 的实测值。

首版适配器读取当前回执时保留实际采集与聚合语义。后续若要支持精确任务配对，必须扩展原始数据的 phase、launch ordinal、correlation/task 标识后再使用，不能事后猜哪些样本属于 warmup。

## 7. 证据数据模型与归因

一次观测至少包含：

```text
observation_id / schema_version
context_ref -> research + experiment + kernel revision + hypothesis revision
               source_hash + rendered_source_hash + build_ref + artifact_hash
               suite revision + case_id + input/oracle hashes
               hardware/toolchain/compiler flags + protocol + annotation_hash
target -> kernel | region | edge | resource
          dynamic_instance -> loop_id + iteration_index/range/aggregate_all
                              logical_worker_id + buffer_slot + case_id
                              launch_ordinal + phase + matching_basis
metric -> name + unit + definition + clock_domain
measurement_kind -> observed | sampled | derived | modeled
observability_scope -> launch | kernel | range | source_pc | core_subset
attribution -> direct | correlated | aggregate | inferred | unmapped
capture -> tool/version/mode + pass_id + replay/serialization/instrumentation
           sampled cores + phase/launch matching + cache/clock policy
value -> statistic + count + raw_samples_ref + uncertainty/limitations
provenance -> raw_receipt_ref + content_hash + selector/query + adapter_version
status -> VALID | UNAVAILABLE | FAILED | AMBIGUOUS | STALE
```

工具填观测字段，Agent 不能通过源码内自写 `evidence` 冒充采集结果。Agent 的解释另存在 `analysis` 记录中，包含证据 ID、替代解释和限制。源码中的手填旧数值最多作为待核对声明；工具只信经过回执校验的记录。

归因规则：

- `direct` 表示观测确实属于目标范围和采集条件，不代表“已经证明瓶颈原因”。
- 源码区段到编译后 PC 可能是多对多映射；内联、融合、优化删除或调度变化时必须允许 `AMBIGUOUS/unmapped`，不能按最近行号强行配对。
- Host range 只能关联它实际包含或发起的调用；异步设备完成必须有独立 task/correlation 证据。
- 跨 pass、跨 build、跨设备、跨时钟域或跨 case 的数据不自动组合成一个直接观测。
- 需要分析 `load[t+1]` 与 `compute[t]` 时，必须匹配同一次 launch、worker、迭代、buffer slot 和阶段。`phase` 区分 enqueue/execute/complete；动态身份来自可核对的 trace 或显式关联。只采到静态 region 汇总或一部分 CU 时保留聚合/子集范围，不能恢复出不存在的逐迭代重叠。所需动态身份缺失时返回 UNAVAILABLE/AMBIGUOUS。
- 去掉阶段前后的总时间差只作为该干预的实验效应；它不等于该阶段原本的独占耗时。
- 源码、构建、编译选项、环境、suite、协议或 annotation_hash 变化后旧证据在新上下文标为历史/STALE。即使 region 文本没变，也不能继承新的即时性能。
- 假设真伪仍由 Agent 根据完整证据判断；任何更快/更慢、排名或区段计数都不自动决定 SUPPORTED/REFUTED。

## 8. 如何真正把报告补到注释里

现有 Meteor 对 source_hash/revision 实施不可变约束。直接给已测试的 `device.asc` 添注释也会改变哈希。因此采用以下默认方案：

1. 作者源码连同事前分析注释在 build 时冻结。
2. 证据进入不可变 `evidence.json` 和现有结构化知识库的索引。
3. 工具输出 `device.annotated.asc`、`host.annotated.asc`，复制对应源码，在 region 旁插入生成的 `evidence` 块；顶部明确原文件、原哈希和“仅供阅读”。
4. 生成视图不能作为 `kernel.json` 的构建/交付源路径；构建入口检查保留标识，防止误编译。正式提交仍指向原始被测源码，报告同时链接带注释视图。
5. 作者继续编码时创建新 revision，保留分析意图，旧测量引用只作为历史。新候选的真实性能重新测。

生成注释示意（未测量的值明确留空）：

```cpp
/* @meteor {
  "v": 1,
  "kind": "evidence",
  "target": "region:load_ab",
  "context_ref": "../evidence.json#/context",
  "observations": [{
    "metric": "region_duration_us",
    "status": "UNAVAILABLE",
    "value": null,
    "reason": "当前 adapter 只能关联整个设备任务，不能分离这个区段"
  }],
  "analysis_ref": "../analysis.json#/load_ab"
} */
```

有真实数据时由工具复制观测 ID、值、单位、范围和回执引用；不会要求模型重新抄数。原 subagent 在 `analysis.json` 补充成本解释、与预测的差异和下一步实验，工具再渲染到注释视图。这样满足“代码旁补齐实测分析”，又不破坏原测试证据。

不采用“忽略所有注释再计算 source_hash”：这会改变已有身份契约，也可能掩盖宏、行号或生成过程的影响。若必须把证据注释写回可编译源码，应作为新 revision 构建并履行正常测试要求；首版不为此新增哈希豁免。

## 9. 接入位置与文件结构

```text
templates/project/
  tools/meteor/perf/
    annotation-schema.json       # 注释格式与字段说明
    parse.ts                     # 词法提取、区段配对、表达式解析
    model.ts                     # 工作量、依赖、buffer 和未知项
    plan.ts                      # 观测请求 -> 有界计划
    evidence.ts                  # 回执验证、归因、身份与过期检查
    render.ts                    # 报告、图、带证据注释的源码视图
  .dsh/skills/meteor-kernel-test/references/
    performance-annotations.md  # 两个现有 skill 共用详细参考
  knowledge/migrations/
    0002-performance-evidence.sql

reports/meteor/<backend>/research/<id>/experiments/<experiment>/perf/<plan_id>/
  annotations.json              # 原始声明和精确源码区段
  model.json                    # 静态推导及全部假设
  plan.json                     # 自包含、绑定身份的执行计划
  reproduce.md                  # 原 DSH 工具调用与计划身份
  observations.json             # 不可变原始观测索引
  evidence.json                 # 验证、关联和派生结果
  analysis.json                 # Agent 分析，修订有历史
  report.md
  annotated/device.annotated.asc
  annotated/host.annotated.asc
```

原始 profiler 文件继续由现有 runner 保留，以上目录保存引用和哈希。SQLite 增加 annotation/plan/observation/claim 的可查询索引，不把整张 trace 塞进一份提示词或 JSON 文件。新鲜度只由新的证据支撑的知识进展更新；重新渲染注释、重复导入、修改措辞不会刷新。

拟新增一个工具 `meteor_perf_plan(build_ref, annotation_refs?)`，只解析、检查并生成计划。执行优先扩展现有 `meteor_kernel_profile` 接受 `plan_ref`，与现有直接 `metrics` 调用互斥；不再新增规划 Agent 或强制 workflow。普通 `meteor_kernel_test(mode=full)` 仍保留原职责。

初版计划只含现有 adapter 能执行的步骤。实际执行唯一经过当前研究 session 的 `meteor_kernel_profile`，先完成身份、预算、队列和远端状态检查，再解释声明式脚本。研究已关闭时不能离线重放原身份；需要在新研究中明确生成新上下文的计划。没有独立 import runner 或直接 SSH 的执行分支。不同 region 共用一次合法采集时可复用该 capture，不能重复采集制造新鲜度。

修改 `assemble.ts` 时额外生成插入片段的 source map：原始文件与字节区段 -> 渲染后 `.asc` 区段。它说明拼装位置；编译后 PC 映射需要额外调试信息，不能混为一谈。默认不靠插入 `#line` 改写原构建行为。

## 10. 对现有两个 skill 的改动大纲

这里只定义未来改动，功能落地前不向运行中的 Agent 注入不可调用的新接口。

### meteor-kernel-test

- 写主要阶段时完成最小五问注释；按实际代码声明搬运、计算、等待和 buffer 生命周期。
- 使用计划工具检查格式、变量、case、能力和预算；修复具体输入错误，不把未实现注释或缺字段报告成设备能力不足。
- 由原会话选择执行普通测试、针对性 profile 或新的对照实验；处理失败并保留证据。
- 每个交付 revision 仍独立 full；生成视图和诊断 build 不替代正式候选。

### meteor-performance-analysis

- 先区分作者估算、静态推导、直接观测和因果解释，再分析开销及串并行。
- 读取工具生成的证据，给出支持、冲突、未知项和下一个最有区分力的实验；不抄造区域耗时。
- 预测与结果不符时检查单位、范围、尾块、缓存、调度、资源争用、profile 扰动和代码映射。
- 把证据关联的机制知识入库，保留适用范围；向 chief 报告假设结论、kernel 实绩和下一步建议。

## 11. 实施顺序与验收

### 第一阶段：可用的分析与观测闭环

实现 schema/解析器、工作量和依赖检查、whole-kernel 计划、现有两种指标的严格关联、源码视图、知识索引。阶段级观测不支持时正常返回 UNAVAILABLE。交付前必须有一个真实研究案例由 subagent 写注释、执行计划并收取报告，零人工补写候选。

### 第二阶段：Ascend 区段诊断

由 chief 的设备准备检查实际安装版本及功能。按确认支持的模式接入 Source/KernelScale 或其他官方诊断；隔离诊断 build，记录影响和范围。先验证一个区段映射与回执，再扩大覆盖。当前芯片不支持的模式保持不可用，不把仿真值回填成真机数据。

### 第三阶段：流水解释和受控干预

补充满足条件的时间线重叠、资源竞争证据和跨迭代 buffer 分析。结合作者实现的对照 revision 检查预测，逐步校准模型。只有前两阶段证据充分时才考虑更复杂的静态分析或新硬件 adapter。

有意义的验收用例：

1. 注释出现在普通字符串/raw string 中不被误解析；损坏标记报精确文件位置。
2. 先发起后完成、同迭代数据依赖、K 累加依赖和双缓冲复用均有不同模型结果；同迭代非法环失败。
3. 任意脚本字段、未知变量、错单位、越界 case、缺失 capability 和超预算计划不执行远端命令。
4. 只有 whole-kernel 数据时，region 时长保持 UNAVAILABLE；PC 多对多映射保留歧义。没有匹配动态实例时不能回填逐迭代重叠。
5. profile 重放/串行化/采样子集/插桩条件和缺样本完整传播；不会进入普通 full 排名。
6. 生成注释前后原始源码、原始回执和 artifact 哈希不变；新 revision 的旧证据标为历史。
7. 同一报告重复渲染或导入不刷新知识新鲜度；chief/subagent 的文件读取与工具职责不变。
8. 真机验收包括一个有效观测、一个不支持的区段指标、一个对照实验，以及 subagent 最终逐 case 全尺寸提交；失败案例不能包装成完成性能目标。
9. 没有预定义规则、样本不足或只看到不显著差异时不自动生成性能假设的支持/反驳；机制观测与 kernel 排名独立显示。

## 12. 决策记录与风险

| 决策 | 选择依据 | 代价/风险与处理 |
| --- | --- | --- |
| 严格 JSON 注释 | 复用解析能力、明确版本和错误位置 | 比自由文本啰嗦；只要求主要区域，解释可以简短 |
| 注释是声明，不是源码语义证明 | 任意 C++/Ascend C 自动推断不现实 | 检查结构与明显矛盾，运行事实独立验证 |
| 依赖 + buffer + 资源模型 | 能表达异步、流水、归约与串行瓶颈 | 第一阶段仅做显式关系和下界，不宣称精确模拟 |
| 按能力降级的采集计划 | 官方功能受芯片和版本限制 | 报告会有未知项；给出需要的下一种证据 |
| 生成带注释视图 | 保留精确源码/回执不可变契约 | 增加派生文件；由工具生成并清楚链接原文件 |
| 原 Agent 控制执行 | 保持用户确定的研究循环 | 自动化负责可靠执行与报告，Agent 负责下一实验选择 |
| 先 whole-kernel，后区段 | 当前接口和设备已有证据支撑 | 首版不承诺每段真实耗时，明确后续能力门槛 |

本方案中“要求显式分析并联动测量、回填证据”来自人类；注释语法、字段、分层、生成视图、工具形态和分阶段范围是 Agent 的设计建议。厂商方法只作上述明确借鉴。新设计尚未通过真实 kernel 实验验收。
