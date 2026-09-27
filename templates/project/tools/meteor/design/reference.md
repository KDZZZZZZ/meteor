# 计算与硬件活动原语参考

本文件保留硬件无关计算图定义。执行 IR 词汇由 Chief 的硬件准备结果提供。可用工具与注释语法见 [guide.md](guide.md)，实际契约、HW 模型和 case 以本轮冻结启动包为准。

### 4.1 计算图 IR v1：28 个计算原语

计算节点限定为下表的 **28 个标量原语**。每个节点产生一个带类型的值，边引用该值；同一个值可以被多个节点使用。图按人类确定的完整数据依赖 DAG组织，张量运算由这些节点及其重复结构组成。

类型记号：`I` 为 `i8/i16/i32/i64/u8/u16/u32/u64`；`S` 为其中的有符号整数；`F` 为 `f16/bf16/f32/f64`；`N = I | F`；`V = N | bool`。同一签名内重复的类型字母表示**完全相同的 dtype**。常量也有 dtype；除显式 `cast` 外没有隐式类型提升、混合精度或广播。类型集合表示 IR 的表达能力，具体 HW 支持由映射检查确定。

| 类别 | 原语 | 输入 → 输出 | 定义 |
| --- | --- | --- | --- |
| 算术 | `add`、`sub`、`mul` | `(N, N) → N` | 加、减、乘 |
| 浮点除法 | `div` | `(F, F) → F` | 浮点除法，在结果 dtype 舍入 |
| 整数除法 | `idiv` | `(I, I) → I` | 整数商向零截断：`idiv(-5, 2) = -2` |
| 整数余数 | `imod` | `(I, I) → I` | `a - idiv(a,b) * b`：`imod(-5, 2) = -1` |
| 二元极值 | `min`、`max` | `(N, N) → N` | 只比较两个值并产生较小/较大值 |
| 融合乘加 | `fma` | `(F, F, F) → F` | 计算 `a*b+c`，中间乘积不舍入，最终只舍入一次 |
| 相等比较 | `eq`、`ne` | `(V, V) → bool` | 相等、不等 |
| 大小比较 | `lt`、`le`、`gt`、`ge` | `(N, N) → bool` | 小于、小于等于、大于、大于等于 |
| 布尔逻辑 | `and`、`or` | `(bool, bool) → bool` | 逻辑与、逻辑或 |
| 布尔取反 | `not` | `bool → bool` | 逻辑非 |
| 位运算 | `bit_and`、`bit_or`、`bit_xor` | `(I, I) → I` | 按位与、或、异或 |
| 按位取反 | `bit_not` | `I → I` | 在本 dtype 位宽内逐位取反 |
| 左移 | `shl` | `(I, u32) → I` | 左移，低位补零，舍弃移出的高位 |
| 逻辑右移 | `lshr` | `(I, u32) → I` | 右移，高位补零 |
| 算术右移 | `ashr` | `(S, u32) → S` | 右移，高位填充原符号位 |
| 条件选值 | `select` | `(bool, V, V) → V` | `select(p,a,b)`：p 为真取 a，否则取 b |
| 数值转换 | `cast<dst>` | `N → dst`，`dst ∈ N` | 按下面的转换规则产生新 dtype 的数值 |
| 浮点取整 | `round<mode>` | `F → F` | 取整后仍为原浮点 dtype；mode 必须显式指定 |

**数值规则也是原语定义的一部分：**

1. **整数。** `add/sub/mul` 保留结果低 w 位，有符号类型按二补码解释；需要更大数域时先 `cast` 扩宽。`idiv/imod` 要求除数非零，排除有符号 `MIN / -1` 的溢出情形。比较与极值按 dtype 的有符号/无符号解释。移位量满足 `0 ≤ s < w`，不自动对位宽取模。
2. **浮点。** `add/sub/mul/div/fma` 的基准语义为结果 dtype 的 nearest-even 舍入，保留 subnormal；每个节点独立舍入。`add(mul(a,b),c)` 有两次舍入，`fma(a,b,c)` 只有一次。NaN/Inf 及浮点除零遵循 IEEE 浮点数值规则，例如非零有限数除以零得到相应符号的 Inf，`0/0` 得到 NaN；不承诺 NaN payload 或异常标志。浮点 `min/max` 遇任一 NaN 返回 NaN；对两种零，`min(-0,+0)=-0`、`max(-0,+0)=+0`。比较遇 NaN 时只有 `ne` 为真，其余比较为假。
3. **转换。** `I→I` 把原整数值对目标位宽取模，再按目标符号解释，覆盖扩宽、缩窄和符号改变。`I→F`、`F→F` 按目标格式 nearest-even 舍入；`F→I` 向零截断，并要求输入有限且截断后的整数在目标范围内。饱和转换通过 `min/max` 限幅后再 `cast` 表达。
4. **取整。** mode 为 `rne`（最近，恰好一半取偶数）、`rtz`（向零）、`floor`（向负无穷）、`ceil`（向正无穷）。例如 `round<rne>(2.5)=2.0`、`round<rne>(3.5)=4.0`；它不负责改变 dtype 或限幅。NaN 返回 NaN，Inf 保持其符号；结果为零时保留输入符号。
5. **选值。** `select` 消费已经定义的两个值，没有短路含义，不能用它掩盖另一输入子图中的非法整数除法、越界索引或转换。需要避免非法除数时先选出安全除数，再做除法。

**复合表达的固定展开：** `relu(x) = max(x, 0)`；`clip(x,l,h) = min(max(x,l),h)`；整数 `floordiv(a,b)` 可由 `idiv/imod`、符号比较和 `select` 在非整除且异号时把商减一。常量、输入元素引用、输出绑定、索引范围和重复子图属于图结构；`matmul`、`reduce_sum`、`reduce_max` 等阅读分组必须能展开到表中原语。v1 不设任意外部 `call` 逃逸口；新增基础运算须在后续原语版本中补齐签名、数值规则和参考求值。

**借鉴范围：** 算术、比较、逻辑、选值及转换的划分参考 [TVM v0.26.0 的表达式节点](https://github.com/apache/tvm/blob/v0.26.0/include/tvm/tirx/expr.h)；位运算、取整和 FMA 的参考入口为其 [tirx/op.py](https://github.com/apache/tvm/blob/v0.26.0/python/tvm/tirx/op.py)。上表是 Meteor 自行选定的集合与命名，数值规则也由本节明确规定。HW 映射可使用一条指令或指令组合；近似除法、FTZ 或融合与上述基准有差异时，须记录差异、核对算子契约的容许范围并验证，不能静默改写原语含义。

### 4.2 用原语完整表达 quant_matmul_relu_quant

下面是计算图的文本表达。`m/n/k` 为索引重复的记号，不指定串行或并行调度；每条赋值定义一个值及其依赖。所有 `0/1/127/-128` 均显式标成 `f32`。本例使用的计算原语只有 **9 个：`cast, mul, add, max, min, div, gt, select, round`**。

```text
# 每个 (m,n,k) 的乘积；先扩宽，避免在 i8 内乘法溢出
lhs[m,k] = cast<i32>(x1[m,k])
rhs[n,k] = cast<i32>(x2[n,k])
p[m,n,k] = mul(lhs[m,k], rhs[n,k])

# K 个 i32 乘积接成 add 树
acc[m,n] = tree(add, p[m,n,0:K])

# 每一次乘 scale 都产生独立的 f32 结果
v0[m,n] = cast<f32>(acc[m,n])
v1[m,n] = mul(v0[m,n], x1Scale[m])
v2[m,n] = mul(v1[m,n], x2Scale[n])
a[m,n]  = max(v2[m,n], f32(0))

# 同一行的 N 个激活值接成 max 树
row[m]    = tree(max, a[m,0:N])
scaled[m] = div(row[m], f32(127))
active[m] = gt(row[m], f32(0))
yScale[m] = select(active[m], scaled[m], f32(1))

# 复用原来的 a[m,n]；一行的 yScale[m] 被本行所有 n 引用
ratio[m,n]   = div(a[m,n], yScale[m])
rounded[m,n] = round<rne>(ratio[m,n])
lower[m,n]   = max(rounded[m,n], f32(-128))
clamped[m,n] = min(lower[m,n], f32(127))
y[m,n]       = cast<i8>(clamped[m,n])
```

`tree` 是**展开记法**：长度为 1 时直接引用该值；长度大于 1 时在 `floor(length/2)` 处分成前后两段，分别展开，再由一个指定的二元原语连接。长度须大于 0。因此 `tree(add,[p0,p1,p2,p3])` 精确展开为 `add(add(p0,p1),add(p2,p3))`，每条依赖都有确定来源。保存时可以共享这一重复定义，查看时展开某个元素或 tile；逻辑图始终明确。对浮点加法，更换归约树会改变舍入顺序，属于数值变换；本例的整数加法树和有限非负数的 max 树不引入该问题。

这份展开采用当前 qmq-v1 契约（使用启动包 operator_contract_ref）和 [CPU oracle](../runners/remote/gen_case.py)：整数结果须在 i32 范围内；依次执行 `cast<f32> → ×x1Scale → ×x2Scale → max(0)`；激活须有限，输出 scale 须有限且大于零；量化采用 nearest-even。全零行经 `select` 得到 `yScale=1` 和全零输出。激活溢出或正行最大值除以 127 后下溢为零时，沿用 oracle 的报错行为，不自行添加 epsilon。附件的 `×s2 → ReLU → ×s1` 仅沿用图形组织，其运算顺序不替换现有契约。

**计算图检查的设计目标：** 当前 MVP 检查原语名称、基本类型签名、契约输入输出 dtype、依赖顺序与节点覆盖。下面的索引域检查、数值定义域证明及独立图求值尚未实现，不能作为现有检查器已经通过的结论；作者仍须依据公式、契约和实际测试核查。

- 节点名属于 28 个原语；参数数量、dtype、`cast` 目标和 `round` mode 符合 4.1；每个值只有一个定义，依赖无环，索引在声明范围内。
- 所有输出都有完整来源；重复子图和归约树可展开；广播表现为多条边引用同一值。当前图中的 `a` 同时供行最大值与量化使用，不能丢失任一分支。
- 检查整数除法、移位、转换等定义域，以及固定算子的溢出/有限性条件；无法静态证明时报告具体缺口，再用契约约束及测试核查，不能把有限测试写成全域证明。
- 按这些原语独立求值，与固定 CPU oracle 比较。至少覆盖负累加经过 ReLU、全零行、K/N 为 1 或奇数、nearest-even 的半整数，以及分阶段 FP32 舍入。

Agent 先把该计算图写入 kernel 的结构化注释，再设计符合其计算语义的执行 IR 注释，包括硬件计算方式、分块、存储、搬运、同步和可重叠关系。程序检查事前设计后，Agent 编写 Ascend C 等代码实现这些活动。真实编译与 case 测量用于核对实现和活动设计；性能以真实测量评价。

### 4.3 执行 IR：由当前硬件准备结果定义

硬件活动目录不随插件预设。Chief 使用 `meteor-hardware-prepare` 对给定硬件搜索、实验并发布执行模型；本研究从冻结的 `hardware_execution_model_ref` 读取资源、操作、证据和约束。

源码活动的 `kind` 取模型 `primitives[].id`，`resource` 取该 primitive 允许的 resource ID。操作语义、dtype、数据路径、容量和同步条件依据该模型及其原始证据，不能从历史机器名称或 API 名称推定。模型的 documented/measured/hypothesis/unknown 状态不被语法检查升级。

计算图原语仍使用 4.1 的硬件无关语义；一个图节点可由多个活动实现，一个活动可覆盖多个节点。记录编译器实际降低与理想设计的差异；观测粒度不足时在 compare 保留 unknown。模型发布和活动 ID 命中均不证明单条指令、分支、并行或全域等价。
