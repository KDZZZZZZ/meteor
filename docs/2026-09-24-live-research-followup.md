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
