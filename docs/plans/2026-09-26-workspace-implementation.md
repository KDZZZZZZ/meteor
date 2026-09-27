# 单 HW workspace 与 kernel 注释循环实施

状态：schema 2 与注释循环 MVP 已实施并验证。依据 2026-09-25 仓库级改造与可替换 kernel 设计步骤，以及最新四步循环要求。真实旧实例保留，原因见实例核对。

## 范围与顺序

1. 核对初始化模板、实际实例、提示词与工具。现有 `persistent-research` 为 schema 1；保留其冻结证据和实际 case suite。空的 `test-meteor` 不作为旧实例。
2. 引入 schema 2 的 workspace/target 注册与统一路径；新初始化生成按产物/op/dtype 分类的目录，硬件初始未配置。
3. 同步构建、测量、知识库、研究、集成和 DSH 宿主的路径与 target 身份；共享物理设备队列及正式 catalog，mock 独立。
4. 将同一研究 Agent 的 kernel 编写步骤替换为预期活动注释、实现、观测、对照。设计方法可替换；新工具检查可落实的约束，不宣称任意代码的全域等价。
5. 在临时实例完成初始化、重复初始化、同名对象跨 target 隔离、完整 mock 研究与自动集成回归，执行项目检查及构建。
6. 对已有实例先盘点、备份和迁移演练；不覆盖旧快照、源码或回执，不把历史成绩重新挂给改过的源码。

## 协作边界

- 主 agent：配置/初始化、公共类型和路径、case 与硬件准备、DSH 工具和首包、迁移及整体验证。
- runtime lane：研究/构建/测量/提交/知识库/集成的路径与 target 隔离及对应测试。
- design lane：设计工具、结构化注释检查、策略接口、persona/skill 指导与对应测试。

## 验收

- fresh init 的配置、提示词、首包、构建模板与实际写入路径一致；重复初始化保留人工编辑。
- 新 workspace 有明确唯一硬件绑定；op/dtype 不串用源码、case、成绩、知识身份和版本。
- 注释先于实现，修改候选后旧设计回执失效；真实观测与原预期可追溯对照。
- 原 Agent 连续研究，作者完成每个提交 kernel 的独立全尺寸测试，自动按 case 路由形成 version。
- v1 兼容路径与新库隔离；迁移不刷新科学新鲜度，不改旧证据。

新增初始化回归与隔离测试在实现前后作为行为验证。现有测试先跑基线；最终记录实际结果和未覆盖的硬件实验。

## 实例核对

- 原有研究实例是 `reports/e2e/persistent-research`，使用 schema 1、`asc/` 和 `reports/meteor/ssh/`。共 171 轮研究，实际 suite 为 `qmq-v1-wide-cbf6fc413babbc41`，包含 192 个 case。
- 旧实例与本次修改前的打包模板已有差异：配置、suite、persona、运行时契约、远端 driver 等并非全都相同，且缺少全尺寸策略文件。直接补拷贝文件不能视作安全升级。
- `E:/brief2great/CANN/test-meteor` 原先为空，现已用打包后的 CLI 初始化为独立 Git/schema 2 实例。创建 59 个模板文件，12 类目录按 op/dtype 分类；再次初始化新增 0、冲突 0。默认未配置硬件，由 Chief 进行真实设备探测；没有复制旧设备事实或填占位硬件。
- 旧实例只读迁移盘点检索到 4,133 份 JSON 证据文件、10 条 ACTIVE 研究记录和 20 个可重试的 FAILED 集成事件。没有发现本机运行中的 DSH/13880 服务；SSH 队列为空，但一个缺失结果的远端请求仍是未知状态。进程消失不构成成功/失败的实验回执，也不自动改变研究状态。
- 真实旧实例没有执行迁移或取消；其配置、冻结快照和证据保留。迁移工具要求先结清旧会话/请求和待处理集成，再发布新配置。

## 已实现的接口与目录

- `loadWorkspace` 管共享配置；`loadProject(root,target)` 固定一组契约、suite、oracle、适配器和模板。多 target 时研究入口要求明确选择。
- `workspace.ts` 统一路径、scope 与证据身份；正式产物为 `<kind>/<op>/<dtype>`，模拟产物在 `.meteor/mock`。源码按精确 kernel/revision 归档，build 保存草稿到归档的身份关联。
- `hardware/target.json` 初始化为未配置。真实探测完成后绑定 SoC/architecture；换 HW 需另建实例。同一设备队列继续覆盖所有目标组。
- 正式 SQLite catalog 在 `knowledge/`。主键与提交、回执、路由、事件按 target 区分；读取和初始材料抽样覆盖共享 workspace。材料保留来源 target，不能把别组成绩作为本轮提交证据。
- 知识可分类为 `research`、`prediction_rule`、`ir_technique`，适用范围为 `target` 或 `hardware`；分类视图引用同一权威库。预测器 manifest 初始为空，不生成虚构硬件规则。
- `meteor_design` 在原 Agent 内提供 open/check/freeze/compare；源码中的 `meteor-ir:v1` 是两种 IR 的权威定义，`meteor-activity` 标记实现区域。`ir/` 保存事前快照与冻结身份，对照结果进入 `comparisons/`。
- 写实现前检查纯注释预期；构建前核对冻结源码、依赖、公式、target、环境与实验身份。对照核对实际 test/profile 回执及对应 build，不把整体延迟分摊为逐活动实测。
- 单 persona、两个 skill、DSH 首包及构建/测试/分析/提交工具使用相同路径和约定。交付 kernel 的全尺寸测试仍由原 subagent 完成；有效最终提交后自动生成所属目标组的 shape 路由版本。

## 验证与边界

- 修改前基线：152 通过、1 跳过。
- 全套测试 **191/191 通过，0 失败、0 跳过**，包括本机原生 DSH ToolRuntime；覆盖初始化、重复初始化、人工编辑保留、同名多 target 并行、硬件绑定、注释门槛、源码身份、自动路由与迁移事务。
- 8 项迁移回归通过：只读盘点、未结清状态阻断、旧源码/数据库/新鲜度保留、幂等、发布异常回滚、死进程锁恢复、旧最优候选继续可用、可信来源拒绝篡改。新 Oracle 注册内容与实际 SSH 部署字节一致；跨 target 新进展更新源材料新鲜度，重复提交不重复刷新。
- `npm run check`：68 个源文件语法/空白检查通过。使用本机既有 TypeScript 编译器及 Node 类型执行严格 `tsc --project tsconfig.json` 通过；没有安装或新增依赖。`npm run build` 与 diff 空白检查通过。
- `npm run demo` 已通过新设计门槛，完成两轮 mock 候选的独立全尺寸测试、profile、对照、准备/最终提交与自动集成，集成状态 ASSEMBLED。真实命题保持 INCONCLUSIVE，研究目标为 false，集成测试为 NOT_RUN。
- 已定位本机 DSH 0.1.7-alpha.2，并通过真实 ToolRuntime 合约和完整 Web 组合测试；Web 验证包括 target、snapshot、同 session design 工具、skill、job 和结构化交付，模型请求与硬件测量均为 0。
- 当前真实执行适配器仍为 qmq-v1/int8。公共 namespace 可以登记多组，但新增算子或 dtype 需实现对应适配器；不能仅改目录名即声称支持。
- 检查器验证名称、基本 dtype/引用/DAG、活动覆盖、先后顺序和证据身份；独立计算图数值求值、索引域证明、任意代码等价、所有硬件活动的自动转述均未实现。真实活动仍由原 Agent 按当前设备可观测能力分析。
- 本次没有用新流程完成真实 NPU kernel 研究；旧硬件成果不转挂新代码。

## 设计来源

- **人类设计：** 单 HW workspace、按种类/op/dtype 分类、共享知识与新鲜度材料、同上下文研究、预期活动先于实现、作者全尺寸测试、周期末自动集成。
- **Agent 补充：** schema 2 注册/复合身份、通用路径函数、源码注释最小语法与策略检查入口、不可变事前/实现回执、独立迁移 catalog、锁/备份/发布日志与旧证据来源校验。
- **成熟借鉴：** 沿用已记录的 TVM 计算原语分类与 Ascend 硬件活动/测量资料；本轮 DSH 接口直接对照本机官方 alpha.2 包验证。没有新增运行时依赖或复制厂商 kernel。
