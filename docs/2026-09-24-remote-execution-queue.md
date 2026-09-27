# 同机研究测试自动排队

## 人类设计

用户要求：同一台机器多个研究轮次并行容易堵死，subagent 的测试应自动排队。保留 Chief 管理多个研究、每个研究一个连续会话、编写者负责全尺寸测试、完成提交后程序自动集成的约定。

## Agent 自主决策

- 远端共享 FIFO，一台机器同一 SSH 用户默认一个执行名额。跨 research、项目根目录、profile 别名、device_id 共用。将 build、test、profile 和 hardware 都纳入，防止并发编译占满 CPU/内存，也减少测量干扰；Chief 的资料分析、Agent 推理和源码编写继续并行。
- 一次 full 测试及其 profiler witness 整体占用名额，不逐 case 交替。既有本地 request_id、SSH 幂等 ID、原会话和证据身份保持不变；已完成重放只读结果。
- 默认 Linux `/tmp/meteor-execution-<uid>`，不随 remote_root、snapshot 或 bundle hash 改变。集中 profile 可配 `queue_root`；不同账户要使用同一有权限的本地目录。没有新增依赖、后台调度服务或 Agent。
- ticket 顺序在短暂 metadata 文件锁内分配；每个 ticket 用独立 OS 文件锁证明存活。等待者发现 ticket 锁已释放才清理，不按时间强夺名额。命令继承 ticket fd：驱动退出但子进程活着时继续占位，避免同时跑两个实验。
- 排队前落盘大 payload，等待期间释放 base64 case 数据，获得名额后重读。SSH bootstrap 也使用临时文件传 stdin，避免整个等待期保留一份大 JSON 字符串。
- 排队取消不启动命令；运行时约每 200 ms 检查取消，终止命令进程组并等待退出。超时从命令启动起计算；研究墙钟预算仍包括排队，不能借队列自动扩预算。
- poll/collect/cancel 不排队。远端 `RUNNING` 的 `state.state` 区分 queued/running，`queue` 含 ticket、position、active_request_id、enqueued_at、started_at、wait_seconds；最终原始回执保留排队信息。位置 0 表示执行中，1 表示下一位。队列耗时不进入 kernel samples。
- `UNKNOWN_REMOTE` 不当成失败重试或完成；远端已确认取消在 poll/collect 中保留 CANCELLED，并单独标识释放。崩溃可能留下旧 per-request operation.lock 和未知结果；队列能放行其他请求，但不自动重跑这个部分执行过的实验。

## 成熟实现借鉴

2026-09-24 查阅：

1. **NVIDIA Nsight Compute Profiling Guide，§2.6.1 Serialization**：多个 profiler 进程通过设备锁文件串行采集；也支持全局串行模式。借鉴跨进程文件锁与隔离测量资源的思路，Meteor 的主机 FIFO、公平性、数据落盘与研究语义由本项目实现，未复制 NVIDIA 代码，也不假定 Ascend 有相同设备接口。官方链接：<https://docs.nvidia.com/nsight-compute/ProfilingGuide/index.html#serialization>。
2. **Python 官方 fcntl / subprocess 文档**：使用非阻塞 flock、POSIX pass_fds 和 start_new_session 实现进程锁与命令组。官方链接：<https://docs.python.org/3/library/fcntl.html>、<https://docs.python.org/3/library/subprocess.html>。
3. **Linux man-pages flock(2)**：锁与 open file description 关联，继承 fd 继续持有；最后一个描述符关闭才释放。队列关闭自己的 fd 而不显式 LOCK_UN，防止解除存活子进程持有的锁。官方链接：<https://man7.org/linux/man-pages/man2/flock.2.html>。

## 验证与限制

针对性测试覆盖 FIFO/不重叠、跨目录和不同动作共用名额、排队取消、等待者/执行者退出、独立队列并行、请求幂等、运行中取消、SSH 状态与释放语义、bootstrap 并发安装和 stdin 数据完整性。Linux 另验证继承 fd 的子进程仍存活时不提前放行。

本次结果：完整回归 152/152；最后补充 durable payload 完整性检查及已确认取消的收取后，相关测试 25/25。语法、TypeScript、构建、skill 校验通过。通过现有集中 SSH 配置在开发机独立临时目录运行进程测试，`posix_pass_fds_checked:true`；覆盖正常退出与 `os._exit` 的父进程、存活子进程继承锁。

已同步当前运行项目 `reports/e2e/persistent-research` 的工具和 skill，供之后创建的研究快照使用；同步核验既有 60 个相关 snapshot 文件未改变。服务和持续 goal 未重启，也未修改模型/SSH 凭据或当前研究的源码、输入和回执。

这些是进程与协议测试，不是新 kernel 的 NPU 全尺寸成绩。真实算子的测试仍由 DSH 研究 Agent 完成。Windows 路径仅验证 fake 协议；生产进程组与继承 fd 行为面向 Linux。

队列是协作式的，只约束使用同一队列的新 Meteor driver；外部进程、不同容器的独立文件系统或不同 queue_root 不受它约束。旧 per-root DeviceLock 保留以兼容同 root 的旧 driver，但已经冻结的旧研究不获得新队列。升级只更新未来研究使用的项目工具和 skill，不修改活动 snapshot、kernel 或回执。

活着的挂死或孤儿设备进程不能靠锁过期安全解决；应查询原请求并诊断/停止真实进程。驱动失联且结果不明时继续 UNKNOWN_REMOTE，不伪造释放。队列元数据保存在本地文件系统，不将 NFS/跨主机共享目录当成全局调度器。
