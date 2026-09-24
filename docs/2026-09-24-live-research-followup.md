# WebUI 真实研究续测（2026-09-24）

## 测试方式

通过 DSH 0.1.7-alpha.2 WebUI 发起新 chief 会话，沿用用户在 UI 中选择的模型和集中 SSH 配置。每轮使用相同目标：自动初始化、探测和调试 SSH 设备，生成真实硬件报告，随后完成一个 qmq-v1 性能假设研究并汇报。研究运行期间不发送补充提示，不代写候选 kernel，不修改研究快照或原始回执。

前面三次使用已有测试工程；第四次使用新的空目录，检验初始化及空材料库场景，保留旧工程和知识库。更换目录同时改变了初始材料，因此不能把结果变化单独归因于提示词。

## 已观察到的结果

| 研究 | 实际执行 | 交付与限制 |
| --- | --- | --- |
| `qmq-v1-hypothesis-round-1` | Chief 自动探测通过。Subagent 只写假设，尝试构建不存在的模块后提前停止。 | 有效 INCONCLUSIVE 提交，0 kernel，自动集成 SKIPPED；未执行设备构建。 |
| `qmq-v1-cube-path-hypothesis-20260924` | Chief 自动探测通过。Subagent 一次写路径错误后能写入其他文件，却将问题概括为目录不可写。 | 有效 INCONCLUSIVE 提交，0 kernel；没有 kernel 源码或设备构建。 |
| `qmq-v1-real-hypothesis-round` | Chief 自动探测通过。Subagent 写入清单和仅含注释的源码，实际 SSH 编译因 launcher 未声明失败。 | 有效 INCONCLUSIVE 提交，0 kernel，自动集成 SKIPPED；没有全尺寸正确性或性能数据。 |
| `qmq-v1-real-20260924`（空工程） | Chief 从空目录初始化、自动探测通过，并保留默认 12 次实验预算。Subagent 写了实际设备计算和 launcher 源码，但因 prefix/launcher 不匹配在远端编译之前失败，随后提前停止。 | 有效 INCONCLUSIVE 提交，0 kernel，自动集成 SKIPPED；未产生设备构建或全尺寸测试。不能断言候选正确。 |

这些报告闭环说明空交付可以被准确记录，不证明算子已实现或性能目标已完成。编译失败也不构成性能机制假设的反证。空工程同样未完成算子，现有证据不支持将失败只归因于旧知识材料。

## 根据轨迹修复

### 人类设计

- Chief 自动准备和调试设备；研究 Agent 编写候选并承担每个交付 revision 的全尺寸测试。
- 修复工具和现有 persona/skill；不向运行中的 Agent 喂提示，不替它完成实验。
- 保留一份 persona、两个 skill、一个连续研究会话和自动集成职责。

### Agent 自主决策

- `meteor_read_file` 支持 chief 在初始化前后读取当前工程，同时保持研究会话绑定。
- `meteor_write_file` 接受研究相对路径、当前工程相对路径和绝对路径，统一限制在本研究允许写入的区域；其他研究、快照、回执和符号链接逃逸仍被拒绝。
- 缺清单或声明源码时返回明确的创建/重试诊断，在产生实验回执前失败，允许同一 experiment 补齐后重试。
- SSH 构建失败但远端没有顶层 error 时，从失败命令的 stderr/stdout 提取有界诊断，保留完整原始回执。
- 续测还发现发布后的 TypeScript 类型文件不存在，旧逻辑把 `contracts_ref` 指向不存在的 `contracts.md`。现在为每次研究生成只读的实际模块契约，原生 Web smoke 检查文件可读；launcher 错误直接给出 prefix、expected、actual 及精确拼接规则。
- Persona/skill 明确编码责任、真实设备实现、首个编译错误后的修复，以及合理停止条件；仅有 TODO 的文件仍属未实现。Chief 核对源码和实际调用，不把候选未完成写成环境能力限制。
- 假设定义区分有效实验的前提与命题的反例；编译或正确性失败先修复实验，不能据此判定性能假设不成立。

### 成熟实现借鉴

本次修复依据实际 DSH 轨迹、现有工具契约和编译回执，未引入第三方实现或新依赖。设备测量依据沿用 [官方测量指导](ascend-measurement-guide.md)；真实探测使用现有通用 add 自检，不能替代 qmq-v1 测试。

## 证据位置

原始研究位于本地测试工程的 `reports/meteor/ssh/research/<research_id>/`。其中 manifest、冻结 snapshot、experiments、准备提交与最终报告保持原样。DSH 原生会话保留在用户的集中 DSH session 存储中。运行数据和配置不随代码提交。

## 本地验证

- 全套测试串行运行：**133/133 通过，无跳过**，包括实际安装的 alpha.2 兼容性测试。
- `npm run check`：55 个源文件语法检查通过；TypeScript 类型检查通过。
- 原生 Web-profile smoke 校验实际生成的契约文件、技能发现和连续 subagent 会话等接口；该检查不发模型请求，不等于真实算子成功。
- 第四轮发现的契约文档/launcher 诊断修复通过本地测试，尚未在下一轮真实模型研究中证明能完成算子。

## Chief 派发职责续测

用户随后要求优先让 DSH 完成算子，并明确 Chief 的主要责任是启动 subagent。现有入口 skill 和 `meteor_start` 描述已把设备就绪后的实际派发置于首位：只给目标即可启动，完整假设、现成基线与穷尽调研不是默认前置条件。

通过 WebUI 在新的 `delegation-research` 工程仅发送“使用 meteor 实现并优化 qmq-v1 算子，完成真实设备验证，交付可用的 kernel 和实验结论”。Chief 自主初始化、探测到 READY，并在第 8 步启动 `qmq-v1-real-device`，保留 12 次实验预算。研究会话读到了生成的契约，实际写入源码并两次远端编译；分别遇到标量 `Round` 调用错误和 kernel 类型无法自动推导，随后提前提交 INCONCLUSIVE、0 kernel。Chief 收取报告后自行尝试安排下一研究，说明派发职责开始落实，但尚无正确 kernel。

后续指定材料启动反复携带非空 sampling，连续遭参数拒绝。测试者在 WebUI 停止该无效重试，保留原会话、提交和快照，没有向 Agent 发送修复指令。不能把该轨迹解释为 Chief 没有尝试继续派发。

本次针对暴露的问题修复，并补充输入预检：

- `specified` 的实际语义始终是只分发指定材料；合法但无关的 sampling 规范化后忽略，并在启动结果中明示，不偷偷改成随机材料。非法值继续校验。
- 原始 `.asc`/C/C++ 文件可作为启发材料，标记 `kernel_source` 并记录内容 hash；不伪装成已经构建或测试的 KernelModule。
- 文件读取明确字符分页、截断与 next_offset；另加未知 case_id 的构建前预检，返回有效 ID 列表且不占实验预算。本轮新工程的 `qmq_i8_*` 是实际 suite 的合法 ID，与早先自定义四 case 工程的 ID 不同。
- 现有测试 skill 添加 [Ascend 编写参考](../templates/project/.dsh/skills/meteor-kernel-test/references/ascend-authoring.md)，依据官方资料说明执行类型属性、标量/LocalTensor 接口、nearest-even 和标量 GM 缓存。Subagent 在当前 session 修复可定位的编译错误，不能仅凭两次不同错误结束研究。

上述属于通用提示词和工具修改；测试者没有编写、修复任何被测 qmq 候选源码。原生接口检查或本地测试通过，仍不能替代下一次模型自主完成的设备实验。

### 新工程中的实际设备结果

随后在空的 `authoring-research` 工程再次仅通过 WebUI 发送同一简短目标。Chief 在第 6 步启动 `qmq-v1-ascend-real`。Subagent 自己完成四个 revision：前两次编译失败后继续修复，r3 构建成功但全尺寸正确性失败；r4 改为单 block 实现，在固定 suite 全部 4 个 case 中正确，且每个 case 都匹配到当前目标符号的 `AI_VECTOR_CORE` 任务。独立 full 回执为 `04c70923468715796e517307`，计时每 case 保留 5 个样本。

这证明 DSH 已自主编写出真实可运行的 qmq-v1 基线。它仍不是优化收益证明：r3 正确性失败，不能拿其时间作为有效性能对照。Subagent 首次准备提交 r4 时给了空推荐范围，随后撤下 kernel 并提交 INCONCLUSIVE。历史提交保留，自动集成 SKIPPED；不能把这个结果写成已正式交付或已集成。

Chief 收取结果后自行启动 `qmq-v1-ascend-real-followup`，指定前轮材料并要求验证并行输出、对照实验；同时明确即使未赢得优化，也可交付全测通过且注明限制的正确 kernel。测试者没有在两次研究之间向 Chief 或 subagent 追加消息。现有 persona、skill 和 schema 描述进一步澄清：推荐范围表示允许集成考虑的适用 case，并不承诺加速或假设成立。

最新本地检查为 **137/137 测试通过、无跳过**；原生 Web 接口 smoke、语法和类型检查通过。随后对源文件装配说明与提交字段描述的补充，相关测试 **20/20 通过**。真实端到端交付继续以最终提交和自动集成回执为准。
