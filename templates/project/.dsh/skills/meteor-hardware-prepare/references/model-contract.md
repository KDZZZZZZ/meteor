# 执行模型协议

由 Chief 编写 JSON，再调用 `meteor_hardware_model publish`。没有示例硬件活动实例，所有 ID、语义、范围与约束都取自当前硬件资料和实验。

| 字段 | 结构/含义 |
|---|---|
| `schema_version` | `1` |
| `model_id` | 安全唯一标识；不同内容保存为不同 hash 的不可变版本 |
| `hardware_id` | 复制当前 `hardware/target.json` 的值 |
| `environment_ref` | 复制当前仓库 `.meteor.local.json.environment.environment_ref`；探测结果写入此根目录文件，覆盖基础 `meteor.config.json` 的空值 |
| `sources[]` | `{id,kind,ref,description,url?,version?}`；kind 为 `documentation` 或 `experiment` |
| `resources[]` | `{id,description,evidence_refs:[source_id]}` |
| `primitives[]` | `{id,description,resources:[resource_id],graph_required:boolean,evidence_refs:[source_id]}` |
| `constraints[]` | `{statement,scope,status,evidence_refs:[source_id]}` |
| `limitations[]` | 非空文本列表，包含观测缺口、适用范围及后续验证问题 |

作者只需复制当前 `hardware_id/environment_ref`，无需填写、计算内部 `hardware_report_hash/profile_hash`，也无需为了查身份读取工具实现或旧实例。工具负责冻结和核对这些内部身份。`inspect` 用于读取已发布模型，首次发布前按上述文件取值。

资料 `ref` 是保存的本地摘录路径，必须带实际文档/工具链版本；取得日期单独记录，不能当作版本。实验 `ref` 使用工具返回的精确 `hardware/experiments/<experiment_id>/result.json`；当前 `.meteor.local.json.environment.hardware_report_ref` 指向的 probe 报告也可作为补充 `experiment` 引用，工具核对当前报告身份、真实设备见证和释放。探测报告不是 `documentation`，也不能代替至少一份本 Chief 成功的自定义诊断。不能用叙述夹路径、旧 probe 或研究 Agent 的 test 回执替代。工具冻结所引文件内容，因此资料摘录要精炼且每份不超过 2 MB。

`graph_required` 表示使用这个硬件操作表达计算时必须关联至少一个计算图节点。`resources` 是该操作可绑定的资源 ID 集合，不表示这些资源能任意并行；约束与实测对照单独记录。仅取名不同不会产生新硬件能力。

发布前逐原语核对 `ID/首句语义 → 精确类型、方向或同步条件 → 直接来源 → 已知与未知`。ID 中的 dtype、转换模式和描述中的搬运端点、事件名都构成能力声明，不能仅凭一个泛型声明或相关 API 名称补齐。把有依据的定义写入原语描述；待验证的具体类型/路径在同一描述中明确标为 hypothesis/unknown，并在 constraints 记录，不能先称已支持再只在 limitations 撤回。相应 IR 可表达明确标注的待验证预期，原语进入词汇表不代表该预期已被证明。

一条约束同时含已测观察与未测预测时拆开记录。例如一种任务类型被本次日志观察到，不能使对另一种任务类型的预测也成为 measured。诊断统计、API 声明、编译通过、正确性与设备任务分别支持各自范围，不互相替代。

约束 status：`documented` 引用资料；`measured` 引用能支持本断言的实验；`hypothesis` 是待检验解释；`unknown` 保留信息缺口。发布只检查来源存在、身份、状态和结构，不做语义证明。没有证据的限制不能升级为硬件禁令；局部尺寸点不能自动成为连续区间定律。

发布后返回 `model_ref/model_hash`。Chief 用 `inspect` 读取选中模型；研究的 `meteor_design open` 返回模型引用、资源和操作定义。依赖顺序、图节点覆盖与源码标记检查仍由设计工具执行，硬件约束的满足程度由本轮实验/compare 记录。

发布包还保存工具取得的 `hardware_report_hash`，不由模型作者伪填。诊断与模型必须属于同一探测报告；重新 probe 后旧模型不可直接用于新研究，即使稳定环境 ID 相同。已经开始的研究继续使用原快照。已释放的失败/取消诊断可以引用作局部观察，但模型至少需要一份命令完整成功的本设备诊断；失败状态不会被转换为成功或硬件机制结论。
