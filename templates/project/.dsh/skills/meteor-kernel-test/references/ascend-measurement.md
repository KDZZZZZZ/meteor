# Ascend 设备准备、测试与性能分析

本页供现有两个 Meteor skill 按需查阅，不引入额外 Agent 或固定研究流水线。核查日期：2026-09-24。以 CANN 9.0 文档为主要依据；补充资料明确标出版本。本机编译器、头文件、工具帮助和真实探测结果决定可用能力。

## 1. Chief 初始化时生成硬件报告

在 `meteor_init` 后调用 `meteor_hardware_probe`，可用 `profile_ref` 选择已有集中配置。读取工具返回的报告、能力和 setup 状态。没有连接配置、真实设备不可用或必要探测失败时，保持未就绪；不写默认芯片、核数、内存、编译架构来凑齐配置。设备调试属于 Chief 的准备职责，不交给研究 subagent 用正式研究预算摸索。

报告应说明实际观察到的硬件、工具链及限制，并关联探测命令、退出码、原始输出、时间和探测产物。初次设备准备包含小型真实 Ascend C kernel 的编译、launch、同步、正确性检查和设备采集；单纯 SSH 可达或 ACL 初始化不足以确认链路。

| 查询内容 | 方法与解释 |
| --- | --- |
| NPU、Chip、逻辑设备映射 | `npu-smi info`、`npu-smi info -l`、`npu-smi info -m`；区分物理 NPU ID、Chip ID 与 ACL 逻辑 Device ID |
| 芯片、板卡、固件 | `npu-smi info -t board -i <npu_id> -c <chip_id>`；以实际输出为准 |
| 健康与现场状态 | `-t health`、`-t usages`、`-t memory`、`-t temp`、`-t power`；参数支持情况先查本机帮助，未知项保留 unavailable |
| 运行时芯片名称 | `aclInit`、`aclrtSetDevice` 后调用 `aclrtGetSocName()`，检查空指针和错误 |
| 运行时可用内存 | `aclrtGetMemInfo(ACL_HBM_MEM, &free, &total)`；byte，不含系统预留内存；不支持该内存属性时不可补造容量 |
| 核数、片上内存、架构 | `PlatformAscendCManager::GetInstance()` 后查询可用的平台 API；不要传 `customSocVersion` 冒充真实发现 |
| CANN、驱动、编译器 | 在实际安装路径读取 toolkit 安装信息和 driver/firmware 版本，记录实际编译器路径、版本、编译参数 |
| 性能工具 | 记录 `msprof --help`、`msprof op --help` 或 `msopprof --help` 与可用的版本输出；区分安装存在、参数支持和实际采集成功 |

`GetCurNpuArch()` 返回枚举，按本机 `include/platform/soc_spec.h` 解释。官方对应表区分 Atlas 训练系列 `DAV_1001` 与 A2/A3 `DAV_2201`，不能由裸 `Ascend910` 名称猜架构。`PlatformAscendCManager` 传入自定义 SoC 的用法支持无 NPU 环境，不是设备存在的证据。相关 API 缺失时读取当前版本的官方替代方法并记录限制。[CANN 9.0 架构查询][arch] · [平台信息接口][platform]

`npu-smi` 适合记录温度、健康、利用率及并发负载；瞬时利用率为 0 不能证明一个微秒级 kernel 没运行。执行证明使用下面的任务关联方法。[官方设备查询][smi] · [CANN 9.0 SoC API][soc] · [CANN 8.2 内存 API][memory] · [CANN 8.5 版本查询][version]

## 2. 真正的 Ascend C 执行路径

官方 Add sample 展示了 GM → LocalTensor → `AscendC::Add` → GM，以及 Host 通过设备 launch 调用核函数的结构。[Ascend/samples 实现][sample]

使用实际 SoC 与编译器支持的编译方式。新 `.asc` 路线可按本机能力使用 `bisheng source.asc -o executable --npu-arch=<实测架构>`；旧 kernel launch 项目使用对应 CANN 版本 sample 的编译工程。保存命令、源码与二进制 hash，并检查没有启用 `ASCENDC_CPU_DEBUG` 或链接模拟运行库。[CANN 8.5 编译说明][compile]

目标算子在 AI Core/Vector 完成计算；Host 可以准备输入、设置 tiling、调度和独立计算正确性参考。Host CPU/NEON 实际完成输出、将设备输入搬回 CPU 替算、空设备 kernel 配合 CPU 结果，都不能称作 Ascend AI Core 实现。

环境探测的样例只证明准备阶段链路可用。每个研究 kernel 的精确构建仍需自己的执行证据和完整测试，不能复用探测样例的 profiler 行。

## 3. 测试口径与计时

固定 case suite、输入生成/seed、oracle、dtype、布局、误差要求、源码/构建及设备身份。探针测试用于调试；交付 revision 的 full 测试必须覆盖 suite 每个 case 的终态。suite 只有四个 case 时，“全尺寸”只表示这四个 case 已完整处理；不能推导它们围成的 shape 区间已被验证。

### 设备 kernel 时间

1. 在计时区间外完成构建、资源申请和 H2D；输入在设备就绪。
2. 进行预热并同步，记录预热方法与次数。
3. 在同一个 stream 上记录 start event，提交目标设备 kernel，再记录 end event。
4. 同步 stream 完成后，检查 `aclrtEventElapsedTime` 的返回码；返回单位为 ms，转换到 us 乘 1000。
5. 在该区间外 D2H、检查输出，保留全部原始样本。

这是官方 event 调用约束与 Meteor 对 kernel 计时范围的组合：event 测到的是两个 stream 时间点的间隔，其间的 Host 延迟、额外复制或其他任务也可能影响数值。若使用包含这些部分的口径，应另标端到端延迟，不能混入 kernel 延迟排名。[ACL event API][event]

短任务会受到频率、缓存和测量开销影响。根据假设选择 warmup、重复数量和配对执行顺序，并检查样本波动；不删除不利样本来追求更快中位数。正常基准运行与插桩/profile 分开。官方单算子调优工具提供 warmup，用于减小尚未提频的影响，但固定次数不能保证所有工作负载稳定。[官方 msopprof 指南][opprof]

### 正确性与支持域

只对正确且有效执行的 case 报告性能。UNSUPPORTED 表示实现不支持该 case，不能算正确性通过或触发另一个 kernel fallback。实现支持域、已测 case、推荐 case、资源上限分别陈述；源码中的缓冲区上限不等于该范围已经通过验证。

## 4. 验证实际设备任务

普通 `msprof` 适合建立算子任务、运行时 API 和设备时序的关联。CANN 9.0 支持以下命令形态；实际工具调用由 runner 管理，示例不要求 Agent 绕过工具另开远端进程：

```bash
msprof --output=<本次独立输出目录> \
  --task-time=l1 --ai-core=on --aic-mode=task-based \
  --aic-metrics=PipeUtilization --ascendcl=on --runtime-api=on \
  <本次二进制> <case参数>
```

也支持 `--application="<命令及参数>"`。优先使用可正确保留参数边界的调用形式。保留本次 `PROF_*` 原始数据、导出文件与完整调用结果，关联源码/二进制/环境身份。[CANN 9.0 启动方式][msprof-command] · [CANN 9.0 采集参数][msprof-options]

`op_summary_*.csv` 同时包含 AI Core、Vector 与 AI CPU，检查文件存在或工具退出 0 不足以验收：

| 字段 | 用途 |
| --- | --- |
| `Device_id` | 核对目标逻辑设备 |
| `Task ID`、`Stream ID` | 关联当前调用中的设备任务 |
| `Op Name`、`OP Type` | 匹配目标 kernel，保留真实符号与匹配依据 |
| `Task Type` | 区分 AI Core、Vector、MIX 与 AI_CPU/其他任务 |
| `Task Start Time(us)`、`Task Duration(us)` | 关联本次执行窗口与任务时长 |
| `Block Dim` | 实际任务 block 信息 |

使用版本适配的类型解析，例如官方资料出现 `AI_CORE`、`AI_Core`、`AI_VECTOR_CORE`、`MIX_AIC`。设备验证用 `--task-time=l1`；l0 的 Task Type 可能为 N/A、Block Dim 为 0，且没有 PMU。Task Duration 包含调度到加速器、加速器执行和结束响应；不能直接解释为纯核上指令时间。[CANN 9.0 字段定义][summary]

验收需要匹配**本次目标 kernel** 的设备计算任务，不能拿其他 kernel、AI_CPU 或 DMA 行代替。缺少匹配行时标为执行证据不足，检查版本能力、采集错误、符号和实际执行路径；不要自动填零，也不要仅凭缺行断言一定在 CPU 上运行。

即使有匹配任务，仍需结合真实 Host/Device 路径排除 CPU 替算和占位 kernel。profiler 证明一个设备任务发生过，不能单独证明目标计算全部发生在该任务中。

探测或候选 kernel 写回错误时，检查 GM/UB 数据流与同步。`GlobalTensor::SetValue` 的标量写可能留在每核 DataCache，不能把 D2H 读到旧值直接归因于设备故障；同一 cache line 的多核写还可能相互覆盖。模板 add 探针参考官方 Add 的 `DataCopy → Add → DataCopy`，使用 TPipe 事件完成 MTE2/V/MTE3 依赖。缓存 API 的支持随产品变化，先核对本机版本。[官方 Add 示例][sample-pinned]、[同步 API][events]、[标量访存说明][scalar-cache]

采集状态要如实区分：`NOT_RUN` 表示前置编译或正确性失败，profiler 尚未运行；`UNAVAILABLE` 表示工具不可用；采集运行失败或成功但没有匹配任务应分别依据日志说明，不能合并成“没有设备执行”。

启动普通 msprof 时按本机 `--help` 使用位置参数 `msprof [选项] <app> [app arguments]`；从 Python 用 argv 列表传入每个参数，避免包装脚本将带空格的 `--application` 值重新拆开。若本机版本仅支持另一种入口，以其帮助和对应版本文档为准，记录实际命令。

## 5. 按假设选择性能分析

确认实际设备执行是实验有效性的条件；它不等于假设证明。选择能区分预测与替代解释的证据，不强制每个命题都有 PMU 数据：

| 命题 | 可选证据与对照 |
| --- | --- |
| 指定 case 的延迟降低 | 正确实现、同口径配对重复计时、原始样本与漂移检查 |
| 分块提高缓存复用 | 相应 L2Cache/搬运观测，或保持其他变量的复用消融；速度变化不能直接改写为 cache 命中率提高 |
| 双缓冲重叠搬运与计算 | PipeUtilization/时序或有区别能力的单缓冲对照，检查额外 buffer 是否改变 tile/并行度 |
| 增加核数改善并行性 | 保持工作量与算法一致，改变 block 数并观察延迟及负载；区分调度开销和计算收益 |

`meteor_kernel_profile` 只传其 schema 和硬件能力支持的 metrics。若工具只有 `kernel_time_us`，就只讨论它声明口径的耗时，不声称得到带宽、cache 或流水指标。必要机制不可观测且对照仍无法区分解释时，报告 INCONCLUSIVE 及最有价值的后续实验。

### 单算子调优

按本机能力使用 `msprof op` 或 `msopprof`，例如：

```bash
msprof op --output=<本次独立输出目录> \
  --kernel-name=<目标符号前缀> --launch-count=1 --warm-up=10 \
  <本次二进制> <case参数>
```

这与普通 `msprof` 的应用采集接口不同，参数不能互相照搬。未指定目标时工具可能只采集第一个 kernel。PipeUtilization 分析计算/搬运流水，Memory 系列分析访存，L2Cache 分析缓存，ResourceConflictRatio 分析资源冲突；只解释实际可用且已采到的字段。记录重放模式：kernel replay 与 application replay 的 L2 处理不同，不能无说明地直接比较。**同一 Device 不并发多个 profiler**；交给工具的设备队列管理。[官方 msopprof 指南][opprof]

研究报告分开写观测事实、机制解释、支持/反证依据、性能表现和边界。SUPPORTED 不能由速度排名、交付或集成选中推导；REFUTED 也不能由一次编译/采集失败推导。最终引用 `meteor_prepare_submission` 返回的实际测量与模块引用，不猜 drafts 路径。

## 官方来源与适用版本

- [CANN 9.0：普通 msprof 启动][msprof-command]、[采集参数][msprof-options]、[op_summary 字段][summary]。
- [CANN 9.0：aclrtGetSocName][soc]；[CANN 9.0 beta1：GetCurNpuArch][arch]，枚举仍以本机头文件为准。
- [CANN 8.5：event 计时][event]、[编译方式][compile]、[包版本查询][version]；[CANN 8.2：内存查询][memory]。
- [Ascend 官方 npu-smi 参考][smi]、[Ascend/samples Add 实现][sample]、[Ascend/msopprof 当前指南][opprof]。仓库 master 会更新；实际引用到实验时记录所用版本/commit，不将新版本特性假定为已安装版本能力。

[smi]: https://github.com/Ascend/agent-skills/blob/master/skills/npu-smi/SKILL.md
[soc]: https://www.hiascend.com/document/detail/en/CANNCommunityEdition/900/API/runtimeapi/aclcppdevg_03_0048.html
[memory]: https://www.hiascend.com/document/detail/zh/CANNCommunityEdition/82RC1alpha003/API/appdevgapi/aclcppdevg_03_0107.html
[arch]: https://www.hiascend.com/document/detail/zh/CANNCommunityEdition/900beta1/API/ascendcopapi/atlasascendc_api_07_00199.html
[platform]: https://www.hiascend.com/document/detail/zh/CANNCommunityEdition/910/API/ascendcopapi/docs/api/Utils-API/%E5%B9%B3%E5%8F%B0%E4%BF%A1%E6%81%AF%E8%8E%B7%E5%8F%96/PlatformAscendC/CalcTschNumBlocks.md
[version]: https://www.hiascend.com/doc_center/source/zh/canncommercial/850/softwareinst/instg/instg_0064.html
[sample]: https://gitee.com/ascend/samples/blob/master/operator/ascendc/0_introduction/3_add_kernellaunch/AddKernelInvocationNeo/add_custom.cpp
[compile]: https://www.hiascend.com/document/detail/en/canncommercial/850/opdevg/Ascendcopdevg/atlas_ascendc_10_00037.html
[event]: https://www.hiascend.com/doc_center/source/zh/canncommercial/850/API/appdevgapi/aclcppdevg_03_0090.html
[msprof-command]: https://www.hiascend.com/document/detail/en/CANNCommunityEdition/900/devaids/Profiling/atlasprofiling_16_0010.html
[msprof-options]: https://www.hiascend.com/doc_center/source/en/CANNCommunityEdition/900/devaids/Profiling/atlasprofiling_16_0011.html
[summary]: https://www.hiascend.com/doc_center/source/en/CANNCommunityEdition/900/devaids/Profiling/atlasprofiling_16_0067.html
[opprof]: https://github.com/Ascend/msopprof/blob/master/docs/zh/user_guide/msopprof_user_guide.md
[sample-pinned]: https://gitee.com/ascend/samples/blob/166b4a5204a70b6d000be6eedc101a1238aa2df2/operator/AddTemplateCustomSample/KernelLaunch/AddKernelInvocationNeo/add_custom.cpp
[events]: https://www.hiascend.com/document/detail/en/CANNCommunityEdition/900/API/ascendcopapi/atlasascendc_api_07_0270.html
[scalar-cache]: https://www.hiascend.com/doc_center/source/en/CANNCommunityEdition/900/programug/Ascendcopdevg/atlas_ascendc_10_00031.html
