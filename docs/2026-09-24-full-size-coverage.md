# 现有 kernel 与全尺寸范围（2026-09-24）

## 已有证据

| 对象 | 可确认的范围 | 限制 |
| --- | --- | --- |
| Meteor `qmq_fused_scalar@r2` | 16×32×64、32×32×64、64×64×128、128×64×256，4 个真实设备 case 通过 | 尚无大尺寸测量；旧成绩不能迁移到新 suite |
| CANN `kernel.asc` / `versions/kernel_v235_scoped_batched_entries.asc` | 下表所列源码路由条件 | guard 不等于所有组合已通过 |
| `versions/experiments/batched_kernels_20260924/v235_exact.json` | 542 个 shape；M=1～8192、N=1～32769、K=1～4096 | 只核查目录，不把列出 case 当作通过证据 |
| `versions/CURRENT_BUCKET_BASELINE.json` | 记录 v235 官方单次 15/15 通过，源码 SHA256 `2952dc379ab088828ea5056eb57c96cf14be7e1d24b8e06ffb6a8fa0be60a57a` | 本次未重跑或向官方验证该历史成绩 |

CANN 源码和目录位于 Meteor 仓库的父项目，是本次本地审查的输入，未复制为 Meteor 的候选实现。

### v235 主要路由条件

| 路径 | 源码边界 | `kernel.asc` 参考位置 |
| --- | --- | --- |
| small AIV | M≤128、N≤128、K≤256，并受 `N*Kstride≤8192` 等约束 | 1199、1212、1245、1975 行 |
| batched small N | N≤2048，batch 目标元素数 4096 | 447～483 行 |
| 常规 / 宽向量 | N≤4096；宽向量为 4096<N≤16384 | 752、823 行 |
| short aligned MIX | N≤2048，M、N 为 16 倍数；32≤K≤128 且 K 为 32 倍数 | 1988 行 |
| long aligned MIX | N≤4096，M、N 为 16 倍数；128<K≤1024 且 K 为 32 倍数 | 2027 行 |

`v235_verified_manifest.json` 还声明更大的 fallback 域（包括 M/N≤65536）。这些是路由元数据，缺少对应完整测量，不能据此说 65536² 等尺寸已验证。

## 新的默认范围

采用 **192 个固定 shape**，覆盖 **M=1～8192、N=1～32769、K=1～8192**。保留旧 4 个 smoke 点，围绕对齐和现有分支加入边界点，再加入 2048³、4096³、长 K、宽 N 和高 M 的代表组合。分组及成本见 [全尺寸策略](../templates/project/asc/full-size-policy.md)，准确列表见 [case-suite.json](../templates/project/asc/case-suite.json)。

这是分层矩阵，不穷举范围的笛卡尔积。192-case 支持性由后续研究 subagent 对精确 revision 的 full 回执建立；本次不声称已有 kernel 已通过新尺寸。

输入加 golden 共 211,292,067 bytes；全取历史 542 个 case 约 433.5 MiB，base64 后约 578 MiB，会超过当前单 JSON 传输的实用上限。因此第一版选择 192 个覆盖主要边界的点，把 K 扩至 8192，保留可审查的静态清单。这个取舍是 Agent 自主决定。

## 复现与旧工程迁移

在 Meteor 源码目录重新选点：

```powershell
node scripts/generate-full-size-suite.mjs ../versions/experiments/batched_kernels_20260924/v235_exact.json
```

源目录 SHA256 记录在 suite 中。脚本需要该本地历史输入；发布插件只消费静态 JSON，不依赖父项目。历史目录只用于补充选点，新增长 K 和部分大矩阵不声称来自历史测试。

`meteor_init` 保留已有文件。对老项目使用新的 suite 文件名，更新 `meteor.config.json.case_suite`，在下一轮之前固定数据；历史 suite、快照、回执和提交不得改写。测试 skill 已明确区分旧 4-case smoke 与新 192-case 全集。

## 实现与验证

准备 case 改为可取消的异步子进程，逐 case 在临时目录生成、成功后发布，避免 WebUI 被长时 CPU 参考计算阻塞。oracle 使用有整数精度条件的 FP64 BLAS 点积，分块限制临时内存，保留 INT32 检查与逐阶段 FP32 语义。

oracle 在 NumPy 2.3.5 与 1.26.4 上分别通过 5 项回归：独立 INT64 参考、舍入、零行、溢出与多块处理；旧样例的 6 个输入/golden 文件哈希一致。

本地完整物化实测：**192/192**，数据 **211,292,067 bytes**，每个文件大小、哈希及 suite 中的输入/oracle 哈希均核验通过；耗时 **52.96 秒**，revision 为 `qmq-v1-wide-cbf6fc413babbc41`。证据保存在未入库的 `reports/e2e/full-size-suite/preparation-evidence.json`。首次运行遇到 Windows 临时目录重命名 `EPERM`；加入仅针对文件占用错误的有界重试后，全量生成成功，原目标目录不会被删除。

针对性测试 **9/9**，完整串行回归 **150/150**、无跳过，涵盖中止清理、旧 suite 保留、元数据不匹配拒绝和原有提交/集成链路。选择脚本重新生成的矩阵与提交模板完全一致。CPU 数据准备及上述回归不替代真实 NPU 测试；这 192 个 case 尚未对现有 kernel 完成实机验证。
