# Ascend C 编写与编译诊断

核查日期：2026-09-24。开始一个缺少已验证基线的研究时，先阅读本页，再结合本轮 operator、完整 case suite、kernel 契约和硬件报告编写自己的实现。这里提供通用开发指导；实际计算、对照实验和源码由研究 subagent 完成。

## 最小可运行实现

先实现覆盖真实 case 的设备基线，再逐项优化。从启动包的 `case_suite.cases` 复制实际 case_id 和 shape；不要根据算子名猜 case 名或测试尺寸。完整读取 operator 的舍入、布局、输出和运算顺序。`meteor_read_file` 的 offset/limit 单位为字符，`truncated:true` 时按 next_offset 续读，或省略 limit 使用默认长度。

核函数在设备上计算，Host 实现 launcher ABI 并调用它。清单的 `launcher` 必须等于 `symbol_prefix + "launch"`；清单中的源码路径相对 project_root。接口契约和实际支持域先对齐，避免把无关协议错误带入性能实验。

源码由模板顺序插入同一个编译单元，device 在 host 之前。模板已经定义 Meteor/Tensor 类型和外部 `run_kernel`，候选不要重新定义；host 部分实现自己的 launcher 即可。设备函数定义已可见，无需再加前向声明；若声明则保持签名、属性和 C/C++ linkage 与定义完全一致。

CANN 9.0 SIMD 的启动形态是 `<<<numBlocks, l2ctrl, stream>>>`：第一项为核数，第二项是保留指针并固定传 `nullptr`，第三项为 stream。不要套用其他平台的 launch 参数含义。[9.0 核函数][kernel-entry]

## 按第一处具体诊断修复

| 诊断或现象 | 检查和下一步 |
| --- | --- |
| `auto derivate failed` / 要求 function type attribute | 纯 Scalar 实现可能没有足够指令让编译器推导 AIC/AIV 类型；同一编译单元的多个 kernel 也可能需要显式类型。按实际执行内容声明 Vector、Cube 或 Mix，再用新 revision 重建。纯标量基线可声明 Vector 执行域，但这不代表已经向量化。 |
| `Round(float)` 无匹配重载 | `AscendC::Round` 是 LocalTensor 运算，不能当成返回标量的数学函数。区分标量转换与向量接口，按实际 CANN 版本核对签名、类型和舍入模式。 |
| 构建成功，输出为旧值或部分行错误 | 检查 GM 标量写回、DataCache、核间 cache line 所有权和 UB 到 GM 搬运依赖。Host stream 同步不能替代 kernel 内的数据流与缓存同步。 |
| launcher 未声明、参数或类型错误 | 对照本轮 kernel-contracts.md 和模板修复自己的模块；不要把候选源码错误当成环境不支持该算子。 |

官方 CANN 9.0 beta2 的编译约束给出显式 Vector 声明形态：

```cpp
__global__ __vector__ __aicore__ void entry(/* device arguments */);
```

是否使用这个属性或 kernel-launch 工程的 `KERNEL_TASK_TYPE_DEFAULT`，由实际编译路线和目标能力决定；不能为消除报错随意指定 MIX。设备函数只含标量计算时，`__global__ __aicore__` 本身未明确 AIC/AIV 类型。[编译约束][compile]、[当前官方约束页][constraints]、[9.0 Kernel 类型设置][kernel-type]

对要求 nearest-even 的量化，`CAST_RINT` 与 `CAST_ROUND` 不等价；截断或简单加 0.5 也不满足所有边界。8.5 文档的标量 API 名为 `ScalarCast`，当前 9.0 页面为标量 `Cast`，以实际工具链签名为准；不要把版本差异当成“没有办法舍入”。保留逐阶段 FP32 运算，检查半整数、零行和饱和边界，随后完成固定全尺寸测试。[Round][round]、[8.5 ScalarCast][scalar-cast]、[9.0 标量转换][cast]

每个 AIC/AIV 的 DataCache 独立；标量 GM 写入可能只把本核 cache line 标成 dirty。不同核即使写不同元素，也可能共享同一 cache line。需要根据本机支持的缓存 API、输出布局和核分工保证写回与所有权；或采用 LocalTensor 输出、正确的流水同步和 DataCopy。先把正确数据流做通，再用对照实验验证并行优化。不要将所有输出失败归因于测试器。[9.0 标量访存和同步][scalar-memory]、[官方 Add 示例][add]

`volatile` 不能代替脏数据写回、缓存失效或核间同步。官方缓存接口的示例 3 展示了两个核修改同一 64B cache line 中不同元素、各自刷新却相互覆盖的情况；“每个核都调用刷新”仍不保证正确。检查实际字节地址、对齐和缓存行写入所有权；用单写入者等对照隔离并发影响，再验证目标设备支持的写回路径。NaN/Inf 也可能来自未初始化、越界或数值运算，需要逐输出诊断，不能预定缓存为根因。[缓存控制及反例][cache-control]、[volatile 与同步示例][store-barrier]

## 在本轮内完成调试

编译失败是实现循环的一部分。读取 build 的第一处诊断及 raw_receipt_ref，形成具体修复，创建新 revision 并重建。进入下一类错误往往说明前一修复已生效，应继续定位；两次不同编译错误不是不可修复的证据。

可先对最小真实 case 做 probe。构建和正确性通过后，再完成每个交付 revision 的 full 测试和所需对照。还存在可执行修复且预算允许时继续当前 session；不能用“留待下一轮”代替当前能完成的修复。确有外部阻塞或预算到限时，引用实际状态与尝试，提交真实的不确定结论。kernel 可用性和假设结论分开报告。

[compile]: https://www.hiascend.com/document/detail/zh/CANNCommunityEdition/900beta2/opdevg/Ascendcopdevg/atlas_ascendc_10_10077.html
[constraints]: https://asc.gitcode.com/guide/programming_guide/compilation_and_execution/operator_compilation/constraints.html
[kernel-type]: https://www.hiascend.com/document/detail/en/CANNCommunityEdition/900/API/ascendcopapi/atlasascendc_api_07_0218.html
[kernel-entry]: https://www.hiascend.com/document/detail/en/CANNCommunityEdition/900/programug/Ascendcopdevg/atlas_ascendc_10_0014.html
[round]: https://www.hiascend.com/doc_center/source/zh/canncommercial/80RC3/apiref/ascendcopapi/atlasascendc_api_07_0571.html
[scalar-cast]: https://www.hiascend.com/document/detail/en/CANNCommunityEdition/850/API/ascendcopapi/atlasascendc_api_07_0018.html
[cast]: https://www.hiascend.com/document/detail/en/CANNCommunityEdition/900/API/ascendcopapi/atlasascendc_api_07_0018.html
[scalar-memory]: https://www.hiascend.com/doc_center/source/en/CANNCommunityEdition/900/programug/Ascendcopdevg/atlas_ascendc_10_00031.html
[cache-control]: https://asc.gitcode.com/api/SIMD-API/basic_api/cache_control/DataCacheCleanAndInvalid.html
[store-barrier]: https://www.hiascend.com/document/detail/en/canncommercial/850/API/ascendcopapi/atlasascendc_api_07_00188.html
[add]: https://gitee.com/ascend/samples/blob/166b4a5204a70b6d000be6eedc101a1238aa2df2/operator/AddTemplateCustomSample/KernelLaunch/AddKernelInvocationNeo/add_custom.cpp
