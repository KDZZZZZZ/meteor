# 先写预期活动，再实现和对照

你在同一研究会话完成四步：**写预期活动注释 → 写实现代码 → 看实际活动 → 对照注释找偏差**。理想硬件活动是目标，Ascend C 等代码是实现手段。计算图必须符合固定公式，执行 IR 的计算语义必须符合计算图，主体描述硬件怎样计算、搬运、等待和并行。

Chief 已为 workspace 准备共享硬件原语。这里设计的是你自己的 kernel 中间表达：组合已发布原语、表达数据依赖与执行安排；不重新探测设备、建立环境或定义硬件原语。`open` 读取冻结模型并创建本候选的设计记录，不执行准备实验。

## 最短调用顺序

1. 在本轮 `drafts/<kernel>/<revision>/` 写 `kernel.json`。源码路径相对 `project_root`，与现有模块 ABI 一致；初始 `device.asc`、`host.asc` 先写为空文件或纯注释。
2. `meteor_design({action:"open",experiment_id,kernel_path})`。使用返回的 `design_ref`、`formula_ref`、`guide_ref`，不要猜目录。新工程多个 op/dtype 共享唯一 HW，当前 target 由宿主固定。
3. 在 `device.asc` 写下方 `meteor-ir:v1` JSON 注释，`graph.formula_ref` 原样使用返回值。先只写注释，暂不加 include、声明或函数体。`meteor_design({action:"check",design_ref,stage:"expected"})` 会保存不可变的事前注释快照。
4. 保持该注释不变，填入真实 device/host 代码。在每组相关代码前写 `// meteor-activity: <id>`，覆盖所有活动 ID。可以多次写文件调试。然后 `meteor_design({action:"check",design_ref,stage:"implementation"})`、`meteor_design({action:"freeze",design_ref})`。
5. 用 `meteor_kernel_build({experiment_id,kernel_path,design_ref})` 构建，用已有工具做 probe、full 及所需 profile。每个最终提交的精确 revision 仍由你完成独立全尺寸测试。
6. `meteor_design({action:"compare",design_ref,receipt_refs:[实际测试或profile回执],analysis:{matched:[],deviations:[],unknown:[]}})`。读取实际观测，在自己的分析中逐项说明符合、偏差、未知及下一步。该工具不替你判定假设，也不启动实验或集成。

`research_id` 由宿主绑定，不传入工具参数。`design_ref` 指向工具生成的控制回执；两种 IR 的作者定义仍只有源码注释一份。`ir/` 是工具控制的快照和派生结果，不能自行改写。

## 简短注释语法 v1

这是本次 MVP 的源码注释格式，不是独立 IR 文件。下面以 `y=a+b` 展示语法；实际使用必须换成当前公式的全部输入、输出和完整计算图。

```cpp
/* meteor-ir:v1
{
  "graph": {
    "formula_ref": "使用 open 返回的 formula_ref",
    "inputs": {"a":"f32", "b":"f32"},
    "nodes": [
      {"id":"sum", "op":"add", "args":["a", "b"], "dtype":"f32"}
    ],
    "outputs": {"y":"sum"}
  },
  "execution": {
    "semantics":"每个元素分别按 f32 nearest-even 加法生成 y；不改变公式的舍入和依赖。",
    "activities":[
      {"id":"compute", "kind":"从当前模型复制 primitive ID", "operation":"该硬件上实现加法的具体动作",
       "resource":"该 primitive 允许的 resource ID", "implements":["sum"], "after":[],
       "description":"依据当前模型及证据说明输入、输出、同步和边界。", "expected_cost":"未知，需本次观测"}
    ]
  }
}
*/
```

在注释通过 `expected` 检查后，才追加例如 `// meteor-activity: compute` 及其实现。标记可以重复，同一区段可关联多个活动。标记只提供关联，不能证明代码真的实现了声明。

修一个字段或一段代码时，优先用 `meteor_write_file({path,mode:"replace",old_text:"文件内唯一的原文",content:"替换后的原文"})`，避免反复重写整个文件。原文缺失或出现多次会拒绝；替换后仍校验完整文件。`expected` 保存后不能借此修改已冻结的 IR，调整预期仍须新 attempt。

直接沿用上面的注释边界和字段形状：JSON 全部位于 `/* meteor-ir:v1` 与 `*/` 之间，不能放到已关闭的说明注释后面。`inputs` 的值是 `i8/i32/f32` 等 dtype 字符串，`outputs` 的值是节点或输入 ID；不要换成 C++ 类型名或 shape 对象。节点使用 `args` 数组，活动依赖使用 `after`，图节点覆盖使用 `implements`；归约按下述 `reduce` 展开，不自行创造 `reduce_add` 等原语。

### 计算图

- `inputs` 是公式输入名到 dtype 的映射；`outputs` 是公式输出名到图值的映射，必须与实际算子契约相符。
- `nodes` 按依赖顺序排列，使用 [reference.md](reference.md) 的 28 个基础计算原语。每个节点具有 `id/op/args/dtype`；依赖可以使用 `a[m,k]` 这种索引记法，`repeat` 写清索引范围。检查器目前检查引用的基础值，索引边界需要作者分析与测试，不能冒称已经自动证明。
- `args` 的每一项都是已有值的字符串引用，不能内嵌子表达式对象。先为比较、乘除等子表达式定义节点，再引用它的 ID；例如 `select` 的三个参数依次为 bool 条件、同 dtype 的真分支和假分支。
- 常量使用可选 `constants`，例如 `"constants":{"zero":{"dtype":"f32","value":0}}`。节点引用常量名，无隐式 dtype 提升。JSON 整数常量须在安全整数范围；更宽的整数值暂不支持。
- `cast` 用节点 `dtype` 指定结果类型；`round` 额外写 `"mode":"rne"`、`rtz`、`floor` 或 `ceil`。
- 归约是二元图的结构化展开。例如 `{"id":"acc","op":"add","args":["product[m,n,k]"],"dtype":"i32","repeat":"m in [0,M), n in [0,N)","reduce":{"axis":"k","extent":"K","tree":"balanced"}}`。`reduce` 只允许 `add/min/max`；正长度为 1 时直接引用元素，更长时在 floor(length/2) 处分半递归组合。它不是一个额外计算原语。范围表达式目前由作者明确，程序没有符号求值或全域等价证明。
- QMQ 的完整分阶段 FP32、两次归约、零行分支和 nearest-even 量化展开见参考文件。不要用一个 `matmul`、`softmax` 或自定义 `call` 节点代替完整图。

### 执行 IR

活动 `kind` 必须取自 `open` 返回的 `activity_primitives[].id`；`resource` 必须在对应 primitive 的允许集合中。这些定义来自 Chief 对当前 HW 的搜索与实验，插件不预设活动词汇。`operation` 写该模型下的具体动作或原生 API，`description` 写数据位置、形状、生命周期、同步范围与边界处理。

`implements` 对应图节点 ID；所有图节点必须被活动覆盖，模型中 `graph_required=true` 的活动至少对应一个节点。`after` 引用必须完成的前序活动；无依赖不自动证明能并行，资源约束仍需说明。`semantics` 明确数据类型、累加、舍入、融合、量化及输出对应关系。硬件活动目录、证据及已知/未知约束从冻结模型读取；不能用其它硬件的目录替代。

活动列表也按依赖顺序排列，`after` 只能引用列表中更早定义的活动 ID。`implements` 引用 `graph.nodes` 的 ID，不能填输入、常量或活动 ID。循环内部的活动依赖用一次迭代的顺序表达，在 `description` 说明跨迭代的等待和缓冲复用；不要用自引用或向后引用伪造循环边。

`expected_cost` 可记录推测及单位，也可以明确未知。硬件资源和性能计数器不能混为原语；读取 GM 不等于真实访问 HBM。不能把整 kernel 延迟按工作量分摊为逐活动实测值。

## 修订、兼容和证据

需要改预期时保留原 attempt，使用新 `design_id`；先保存新注释、通过 `expected`，再写对应实现。已有 kernel 可读作启发，修订实现也遵循先写本次活动预期。已经 freeze 或构建过的候选变化时创建新 revision，旧成绩不转挂新源码。

`freeze` 绑定本 research、experiment、target、环境、不可变硬件执行模型、module revision 与精确源码/依赖。构建若把草稿归档到正式 kernel 目录，由构建回执保存草稿哈希到归档哈希的关联；比较会核对此关联。旧 receipt 仍可读取，但旧的 `direct-code` 回执不能批准新 SSH 候选绕过设计。只有明确传入 fixture 的 mock 协议测试可以走标记为模拟的兼容路径。

检查结果明确区分已检查与未证明范围。当前实现检查语法、基础类型、引用、DAG 顺序、图节点覆盖、源码标记和证据身份；没有自动证明公式与计算图等价、任意 C++ 与 IR 等价，或每项活动满足硬件约束。正确性由契约和真实测试继续核查，硬件活动由实际能力允许的观测核对。实测证据不覆盖原预期，比较结果是独立不可变产物。
