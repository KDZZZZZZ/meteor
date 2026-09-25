# Meteor 仓库级改造：单 HW workspace 与产物分类

状态：仓库级设计稿，尚未实施代码或现有工作区迁移。人类已明确本轮先完成整体设计。

## 1. 这次改造的范围

**一个实验仓库实例只负责一个 HW；多个 op、dtype、shape 共享这个 workspace。所有正式产物按“产物种类 → op → dtype”组织。shape 分桶与 version 自动寻找实测优势区间的逻辑保持原意。**

这是一项独立的仓库级改造，覆盖初始化、根配置、算子加载、文件路径、身份索引、源码注册、缓存、经验库、实验记录、提交与版本发布。即使研究 Agent 继续直接编写 kernel，也应使用这个仓库结构。

“把设计实验并编写 kernel 抽成可替换策略”是另一项局部改造，消费这里定义的 workspace/target 和公共产物接口。二者可以分别实现与验收。

本设计规范 `meteor_init` 生成和管理的实验仓库。Meteor 插件源码中的通用工具与模板负责生成这种实例；一个模板包可以包含多个硬件适配实现，每个生成的仓库只绑定其中一个真实 HW。

## 2. 根边界与共享资源

### 2.1 一个仓库实例，一个 HW

- 根配置记录稳定的 `workspace_id` 和唯一 `hardware_ref`。初始化为 `unconfigured`；chief 通过真实探测、调试和硬件报告建立绑定，不能生成占位设备事实。
- 初始化显式确定本实验仓库的根；复用已有实例时先核对其绑定，不能把上级目录中另一实例的配置或 Git 根默认为本实例。不同 HW 的实例不共用正式数据根。
- `hardware/target.json` 保存 HW 绑定及报告引用。SSH profile 是连接配置，不能代替 HW 身份；连接地址改变不能使已有实验默默变成另一个目标硬件。
- 启动与执行核对真实目标和仓库绑定。需要研究另一个 HW 时使用独立 workspace，不在同一个实例增加第二个硬件实验通道。
- 具体设备实例、驱动、编译器、运行配置和测量协议保存在 environment 与回执中。它们变化时产生新环境身份，并重新检查可比性，不能因 workspace 相同就混用成绩。

当前 `environment_ref` 同时包含 profile、工具链和测量协议，不能直接拿它作稳定的 HW 仓库身份。新增 workspace/HW 绑定与既有测量环境引用分别保存、共同校验。

整个 workspace 共享：

| 资源 | 共享方式 |
| --- | --- |
| Chief、基础 persona、两个 skill | 同一套管理和研究约定，按本轮目标组读取对应算子材料 |
| 执行 IR 生成规则 | 按本 HW 共享规则从原生代码生成预测执行 IR，与对应实测转述对照后改进规则；规则包含硬件执行能力和原语使用方式，由各 op/dtype 复用 |
| 结构化经验库 | 一份正式 catalog 与内容寻址 artifact 库，记录共享规则及具体目标组知识 |
| 执行工具和设备队列 | 统一身份检查、预算、远端状态及物理设备锁；不同 op/dtype 的测试仍排队 |
| 设计策略注册表 | 直接编写与分层 IR 策略共用公共契约，同一策略可服务多个目标组；分层策略由计算图直接编写原生代码，再消费编译/运行后的执行 IR 反馈 |

设备锁按实际物理设备建立，不能因 op、dtype 或仓库目录不同创建互不相干的锁。不同研究可并行设计与分析；计时和占用同一设备的实验仍遵循原队列。

### 2.2 op/dtype 是仓库内的目标组

`target = {op_id, dtype_id}` 标识一组算子语义和类型契约：

- `op_id` 指向明确的算子定义/ABI，不能用 kernel 名代替。
- `dtype_id` 对应算子契约中完整的输入/输出类型组合；混合类型需登记完整组合。目录可以使用规范化简称，例如现有 `qmq-v1/int8`，含义由该组契约明确。
- 每组有独立的算子契约、CPU oracle、case suite、kernel 候选池与 version 序列；共用 workspace 的 HW 能力与通用知识。
- 每轮 research 固定一组 target；chief 可以同时启动多个组的研究，不新增一层“op Agent”或“dtype Agent”。组内仍是一个持续上下文的研究 subagent。
- 初始分发不限制读取。其他 op/dtype 的源码和知识可作启发，但不是当前组的可直接比较成绩。

注册新组需要可用的契约、oracle、case schema、模块/构建适配和结果校验，不是只建一个目录。当前源码的 `qmq-v1/int8` 单例假设需要移除；它作为首个迁移及真机验收组，而非新结构只能容纳的唯一组。

## 3. 完整目标目录

正式产物使用 `<产物种类>/<op>/<dtype>/...`。HW、预测器、工具和共享知识是仓库根级资源。shape 保存在 case、支持域和路由中，不设 shape 目录。

```text
<workspace>/                              # 一个独立 Git 实例，一个 HW
  meteor.config.json                      # workspace/HW 引用、target 注册和默认配置
  hardware/
    target.json                           # 真实探测后的唯一 HW 绑定
    reports/<probe_id>/                   # 不可变探测报告及环境事实
  predictors/
    manifest.json                         # 本 HW 预测器与规则集合引用
  prompts/meteor.md                       # 唯一研究 persona
  .dsh/skills/                            # 两个共享 skill
  tools/meteor/                           # 通用 runtime、适配、存储、执行、集成
  templates/                             # 通用包装模板；组内配置引用所需模板

  contracts/<op>/<dtype>/
    operator.json / oracle/ / adapter.json
  cases/<op>/<dtype>/<suite_revision>/
    suite.json / inputs/ / oracle-results/
  kernels/<op>/<dtype>/<kernel_id>/<revision>/
    kernel.json / device.asc / host.asc
  ir/<op>/<dtype>/<design_id>/<revision>/  # 按产物种类预留位置，内部格式另行定义
  experiments/<op>/<dtype>/<research_id>/<experiment_id>/
    plan.json / analysis.json / artifact-refs.json
  builds/<op>/<dtype>/<build_id>/           # 冻结源码、二进制与构建回执
  measurements/<op>/<dtype>/<run_id>/       # 单 kernel test/profile 与原始观测
  comparisons/<op>/<dtype>/<comparison_id>/ # 实验对比与派生阅读视图
  versions/<op>/<dtype>/<version_id>/
    kernel.asc / spec.json / selections.json / manifest.json
  reports/<op>/<dtype>/<research_id>/
    research.json / research.md / integration-refs.json

  research/<op>/<dtype>/<research_id>/      # Agent 过程工作目录
    manifest.json / seed.json / material_refs.jsonl
    hypothesis.json / hypothesis_history/
    memory.md / checkpoint.json / submission-draft.json
    snapshot/ / drafts/
  knowledge/
    catalog.sqlite                        # workspace 级正式结构化库
    artifacts/                            # 按内容哈希寻址的权威证据/知识对象
    shared/                               # 跨 op/dtype 规则和技巧的可导航索引
    prediction-rules/<op>/<dtype>/         # 分类视图，引用同一库中对象
    ir-techniques/<op>/<dtype>/            # 分类视图，引用同一库中对象
  .meteor/
    state/                                # 宿主运行状态、请求/集成事件索引
    migrations/                           # 迁移清单、检查点与验证报告
    mock/                                 # 显式协议测试的独立 catalog 和产物
```

`research` 是过程工作目录，不再是所有正式产物的总容器。正式 IR、kernel、build、测量和报告按类型归档；实验记录保存它们的引用。不可变文件可以按哈希复用，但身份关联必须包括目标组，不能因内容相同就混用算子语义。

上述目录统一通过 `WorkspacePaths` 一类公共路径解析接口生成，调用方不再拼接 `reports/meteor/<backend>/...`。目录名使用登记的规范化存储键；op/dtype 展示名不直接作为任意文件路径。所有引用仍可追溯到实际内容、版本及哈希。

作者可写自己的 drafts、计划、分析和交付草案。正式归档、快照、原始回执、已提交 kernel 和 version 由对应工具生成并保护。知识分类目录是索引/投影视图，SQLite 与内容寻址对象保持权威来源，不维护多份互相覆盖的规则文件。

## 4. 配置、启动与公共上下文

### 4.1 根配置管理全部目标组

拟议配置分为三部分：

| 配置 | 作用 |
| --- | --- |
| workspace | `workspace_id`、格式版本、唯一 HW/report 引用、正式存储根 |
| shared | 集中 SSH profile 引用、默认预算、设备队列、采样、设计策略、集成策略 |
| targets | 按 `op_id/dtype_id` 登记 contract/oracle/adapter/template/suite 引用及必要覆盖配置 |

`meteor_init` 初始化仓库根与公共代码，登记已有算子组，不再把全仓库锁在一个 `asc/operator.json` 和一个全局 suite 上。`meteor_hardware_probe` 在 workspace 级准备一次真实 HW；之后每轮按当前报告与环境检查就绪状态。每个新 target 的算子/runner 适配还需自己的就绪验证，设备 probe 不能替代它。

Chief 启动研究时指定 `target`，工具解析并固定对应全部引用。只有一个已登记组时可默认解析；多组时 chief 根据用户目标选择，未知或无法唯一解析的组必须明确报告，不默默落到 qmq。参数、选择结果和实际文件哈希进入 manifest。

构建、测试、profile、提交与集成均读取宿主绑定的 `ResolvedTarget`。工具不能让 Agent 通过更换路径、裸 case ID 或 manifest 中的 dtype 字符串跳到其他组。所有 target 仍共享同一组通用工具入口，不为每个 op/dtype 复制整套工具与提示词。

每组的适配器明确提供 shape schema、tensor 文件协议、输入生成器、oracle/比对器、host context、单 kernel 包装和集成路由渲染。现有 QMQ 专用的六张量白名单、`m/n/k` 假设及远端 `qmq_remote_main` 应移入 QMQ 适配器，由通用 runtime 按 target 选择并冻结。已有远端 build/request 的内容哈希隔离保留，同时确保选中组的适配资源进入 bundle 和缓存身份。

### 4.2 与可替换设计步骤的关系

`DesignContext` 接收 `workspace_ref`、`target` 和已解析的契约/oracle/suite/HW 引用。设计策略只产生当前组的实验计划、候选及内部产物引用，不管理仓库布局、全局配置或其他组的版本。

同一仓库结构可以先运行现有直接编写方式，再启用[可替换的 kernel 设计步骤](2026-09-25-pluggable-kernel-design-step.md)。策略切换不重新创建 workspace，也不改变 shape 与 version 契约。

## 5. 身份、经验库与可比性

公共作用域为 `TargetRef = workspace_id + op_id + dtype_id`。HW 从 workspace 绑定取得，回执仍保留实际 hardware/environment 指纹。

| 对象 | 身份/分区要求 |
| --- | --- |
| kernel revision | `TargetRef + kernel_id + revision`；源码注册和不可变检查使用同一完整键 |
| case | `TargetRef + suite_revision + case_id`；shape 与其他现有 case 条件仍是内容 |
| 输入/oracle 缓存 | 带 target、case/suite、输入生成器/oracle/协议版本或内容哈希，避免同名 case 复用错误数据 |
| build/test/profile | 固定 research/experiment/target、精确源码/构建、case、环境及协议 |
| hypothesis/claim/material | 本地记录有 workspace 身份；组内材料带 target，共享材料有显式适用域，不靠同名文件推断 |
| version | `TargetRef + version_id`，并保留原有环境/suite/协议兼容通道；每组自己的基底与序列 |
| 提交/集成事件 | 原幂等 ID 与目标组绑定；重试不重复提交，其他目标组不能消费此事件 |

同一仓库可以有同名 kernel、case 或 version，组别不同就不是同一对象。`kernel@revision` 等旧的裸材料引用仅在具有明确旧作用域时解析；多组下不能按第一个同名对象猜测。

正式 catalog 只有一份，按 scope 查询；保留知识分类、来源、证据与适用范围，适用范围可覆盖多个 op/dtype。现有 observation/mechanism/hypothesis/counterexample 分类继续使用；HW 通用知识不强行复制到每组目录。

人类确定的“预测编译规则”和“IR 编写技巧”两类设计知识继续保留，分别对应分类视图；其具体字段与 IR 数据结构待重新设计。

迁移按表同步类型、严格 JSON schema、数据库键/外键、查询、材料采样、导出视图和新鲜度索引。不能只在路径加两级目录，或仅在 schema 中增加允许任意字段。

现有 migration 未声明实际外键，不能认为启用 `PRAGMA foreign_keys` 就已有关系保护。迁移先检查引用完整性，并为新 scope 关系定义实际复合约束或同等的事务内强校验；不能将旧的裸 `claim_id` upsert 原样留给多组使用。

知识共享不代表成绩可比。候选排名必须先按 target 和原有环境、suite、协议条件过滤；模拟数据保持独立。迁移、索引重建、路径投影和重复导入都不创造科学进展，不刷新新鲜度。

## 6. Shape 与 version 的逻辑保持原意

每个单 kernel revision 必须在**本组固定全尺寸 suite** 上完整记账。支持域可以不同，unsupported 如实记录；编写 subagent 负责在提交之前完成全尺寸测试，不转交 chief。

有效最终提交后，原自动集成流程在所属目标组内执行：

1. 收集新提交与历史已提交的合法 kernel，核对完整全尺寸数据、精确 revision 及可比环境。
2. 按每个 case 的真实成绩选择实现，沿用噪声、近似持平和候选合法性规则。
3. 将有证据支持的选择自动归并成 shape 优势区间/桶，限制在支持域内，不无依据外推到未测 shape。
4. 把多个 kernel 和 case-shape 路由装配进同一个 version，发布到 `versions/<op>/<dtype>/<version_id>`。
5. 更新本组基底并保存原选择依据、内容哈希和集成回执；不更新其他组的当前版本。

因此一个 version 的不同 shape 仍可选择不同 kernel；不会变成“一 shape 一目录/一 version”，也不由 chief 手选区间。假设结论和预测器估计都不能替代用于路由的真实全尺寸成绩。

调用与集成先选定 `op/dtype` 及其 version，再执行该版本内部的 shape 路由。当前 QMQ 路由最终只比较 `m/n/k`，因此不能只删除“重复 shape”校验并把不同 dtype 混进同一 suite；同 shape 的另一 dtype 属于另一目标组/版本通道。其他算子的 shape 解释由自身适配器提供，仍按 case 证据选择实现。

集成通道保留现有 `operator_abi + suite + environment + protocol` 等兼容性条件，再显式补齐 target；同一通道的更新仍串行、幂等，异组可以独立推进。生成版继续标注 `integration_validation=NOT_RUN`，单 kernel 数据不被宣称为已实测的 version 性能。

## 7. 当前实现必须改变的位置

| 当前假设/接点 | 仓库级修改 |
| --- | --- |
| `src/init.ts` 与项目模板 | 从单算子模板生成改为 workspace 公共资源 + target 注册；真实 HW 初始化仍归 chief |
| `src/project.ts` 的单一 suite、qmq/int8 校验及 backend 数据根 | 拆为 `loadWorkspace` 与 `resolveTarget`；按组解析契约、suite、oracle、适配器及存储路径 |
| `contracts.ts`、根 config、`meteor_start`、`host.ts` | 加入 workspace/HW/target 身份；由宿主绑定到研究和所有后续请求 |
| `research.ts` 快照与写入 allowlist | 固定公共 runtime 和当前组所需文件；保留真实引用，更新作者目录及工具产物写权限 |
| `src/cases.ts` 及输入/oracle 缓存 | 从裸 case 路径变为 target/suite/生成与参考身份的路径及缓存键 |
| `kernel-build.ts` 的 `kernel-source-registry/<kernel>/<revision>` | 使用完整 target 键，分类保存构建与源码；保留原 revision 不可变约束 |
| test/profile/SSH runner 请求 | 显式携带固定 target 与当前组的适配协议；复用物理设备队列，不按组分裂设备锁 |
| `store.ts`、`store.py`、`query.py`、迁移脚本、提交 schema | 改为 workspace 级 catalog，升级身份/外键/材料引用及查询；版本升级必须单调且有兼容检查 |
| `integrate.ts`、事件通道与版本发布 | 原选择/分桶语义不变；候选、基底、幂等事件和发布目录按组隔离 |
| 报告、状态工具与 Chief 指导 | 按 op/dtype 汇总同一 HW 的研究状态，引用分类产物；无需用户逐次交代目录规则 |

运行目录迁移不能通过局部 `DesignStrategy` 的私有字段完成；这些是公共 runtime 和存储边界，必须一起升级与验收。

现状核查入口：[项目加载](../../src/project.ts)、[case 缓存](../../src/cases.ts)、[源码身份与构建](../../templates/project/tools/meteor/kernel-build.ts)、[数据根与集成通道](../../templates/project/tools/meteor/store.ts)、[数据库读写](../../templates/project/knowledge/store.py)、[逐 case 集成](../../templates/project/tools/meteor/integrate.ts)。这些链接指向当前实现；表中改动是待实施内容。

## 8. 现有仓库迁移

### 8.1 已核实的兼容风险

现有工程存在未显式包含 op/dtype 的源码注册、材料 ID 和 case 缓存。集成已有 operator ABI、suite、环境、协议隔离，应扩充这些条件，不能替换成更弱的“同一个 workspace 就可比较”。

另一个关键点是旧研究快照携带旧 `knowledge/store.py`：其初始化会重放旧迁移并写回 schema version。**不能让旧快照进程直接打开已升级的正式数据库**，否则会破坏版本标记与兼容性判断。实现前先加入未知版本拒绝/只读兼容以及单调 migration 机制。

状态查询和恢复同样需要新旧格式分派：旧回执由兼容读取器解析，不能把新 `Project` 数据根传给旧 snapshot runtime。旧工具只能访问迁移前的隔离数据，新格式写入由新 runtime 负责。

### 8.2 迁移步骤

1. **盘点与 dry-run。** 记录真实 HW、目标组、运行中研究/远端请求、尚未消费的提交事件、catalog 版本、所有精确源码/回执和路径引用；不能据目录名猜 HW。
2. **停止接收旧格式新研究。** 由 chief 等待现有研究及自动集成收尾；未知远端任务先核对原任务。迁移不以另起 Agent、改写运行中 snapshot 或补造提交结束旧研究。
3. **形成一致检查点。** 确认旧写入者退出，保存可恢复的配置、数据库一致备份、哈希清单和迁移 journal。新 catalog 在独立路径构建，旧快照始终不能指向它。
4. **登记身份与导入。** 为旧工程登记真实 workspace/HW 与 `qmq-v1/int8` 组；将旧对象按明确映射补充作用域、重建引用和索引，新记录采用新分类布局。导入幂等，不刷新新鲜度、不重复触发历史集成。
5. **保留旧证据身份。** 对已有源码/回执使用只读兼容引用，保留实际旧路径与原哈希。不能移动源文件、修改 manifest 或添加注释后继续沿用受旧身份约束的成绩。旧目录作为可解析的历史证据，不再承接新写入。
6. **验证后原子切换。** 校验记录数、引用、哈希、组别、知识关系和历史版本选择，再将根配置/runtime 切到新格式。旧引用仍能查询，新研究只使用新代码与新快照。

切换前可恢复旧配置并舍弃未发布的新 catalog；切换后若已有新记录，需停写并按 journal 恢复，不能把新数据交给不理解新格式的旧 runtime。迁移报告区分历史只读路径和新产物位置。

本轮只定义迁移设计，不停止当前研究、不移动实物产物、不连接或修改现有 catalog。

## 9. 实施分期与验收门槛

### 阶段 A：公共身份与根配置

实现单 HW workspace、target 注册/解析、公共路径服务、全链路 scope、catalog 格式检查。旧单算子路径通过明确兼容适配器读取。先用现有直接编写流程验证。

### 阶段 B：分类归档与自动集成

改造 init、case/oracle 缓存、构建/测量/报告路径、知识查询和版本发布。新旧组内候选均经过原有全尺寸门槛，自动形成本组的 shape 路由。

### 阶段 C：现有工作区迁移与真机验证

先在复制的数据上演练导入与恢复，再按阶段 8 的检查点迁移真实工作区。以 qmq/int8 完成真实研究、全尺寸提交和自动 version 装配；另用隔离协议夹具验证多 op/dtype 的身份与路由隔离。夹具通过不代表新增算子的真机支持。

验收必须覆盖：

- 根目录只绑定一个真实 HW，探测结果不匹配不能静默运行；多个 op/dtype 共用该 HW 的通用资源。
- 两个 op、同 op 的两种 dtype 中使用相同局部 kernel/revision/case/version 名，不发生源码注册、缓存、查询或事件碰撞。
- 不同组可引用共享规则；旧材料的来源与反例仍可追溯，迁移不产生新鲜度事件。
- 相同组、相同候选和测量输入在迁移前后的逐 case 选择、shape 桶与引用结果等价；新增成绩只更新所属组版本。
- 同一 version 可路由到多个 kernel；每个提交 kernel 仍有自己完整的全尺寸记录；不以预测替代成绩。
- 并行 op/dtype 研究的设备测试仍自动排队，未知远端请求不会因切换目录重复执行。
- 旧快照无法改写新 catalog，旧证据哈希不变；迁移可重入，重复导入不重复提交或发布版本。
- 研究 Agent 上下文连续；可替换设计步骤后续接入不需要再次调整仓库身份或目录体系。

## 10. 设计来源与决策

**人类确定的边界：** 一个 HW 一个仓库实例；所有 op/dtype/shape 共用 workspace；按产物种类/op/dtype 分类；shape 与 version 继续自动寻找实测最优区间；这是一项当前仓库整体改造，而不是局部策略替换。本轮先完成改造设计。

**Agent 补充：** target 与完整身份键、具体目录名、公共路径服务、每组注册与版本通道、知识投影视图、旧数据兼容和分阶段迁移/恢复。依据是当前代码的单例假设与精确证据契约，不新增外部依赖。

**取舍：** 保留 workspace 共享目录与分类目标目录，增加统一身份/路径解析的一次改造成本，换取同仓库多算子不会串用成绩；保留少量历史旧路径来维持证据身份。未采用按 op/dtype 拆仓库，也未采用只在设计策略目录里增加层级的方案。

**当前交付：** 仓库级架构、全局影响范围和迁移验收方案；实际迁移、代码实现与真机验证均尚未执行。
