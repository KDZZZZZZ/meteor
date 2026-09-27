# Ascend 测量与设备准备依据

面向 CANN 9.0 的官方资料已核查于 2026-09-24。随初始化工程和研究快照分发的详细指导维护在 [skill 的 Ascend 测量参考](../templates/project/.dsh/skills/meteor-kernel-test/references/ascend-measurement.md)，两个现有 skill 按问题引用它。

## 执行职责

- Chief 在初始化后调用 `meteor_hardware_probe(profile_ref?)`，调试实际 SSH 设备、阅读硬件报告和 setup 状态；设备未配置或未就绪时不启动研究。
- 硬件报告记录真实查询与探测结果。没有默认 mock、占位 SoC、假定核数/内存或未经验证的编译架构。
- 每个研究保持一个 subagent 的连续上下文；由它主动使用测试与性能分析 skill。设备准备报告不能替代其 kernel 的执行证据及全尺寸测试。
- 目标 kernel 的实际设备执行、计时语义和假设结论独立检查。profiler 行说明任务发生过，不能单独排除 Host CPU 替算，也不自动证明机制假设。
- 最终交付链接采用准备提交返回的实际产物引用。有效交付后的 case 路由/version 生成继续由程序自动完成。

## 指导内容

参考页包含设备身份与架构查询、最小真实 kernel 探测、ACL event 的单位与同步、H2D/D2H 边界、全尺寸 suite 的适用范围、`msprof` 任务关联、单算子 profiler 能力发现、配对测试与消融。普通计时和插桩采集分别解释；根据具体命题选择机制证据，不要求所有假设都由 profiler 证明。

主要依据为 [CANN 9.0 msprof 参数](https://www.hiascend.com/doc_center/source/en/CANNCommunityEdition/900/devaids/Profiling/atlasprofiling_16_0011.html)、[CANN 9.0 op_summary 定义](https://www.hiascend.com/doc_center/source/en/CANNCommunityEdition/900/devaids/Profiling/atlasprofiling_16_0067.html)、[官方 ACL event 说明](https://www.hiascend.com/doc_center/source/zh/canncommercial/850/API/appdevgapi/aclcppdevg_03_0090.html) 及 [Ascend/msopprof 指南](https://github.com/Ascend/msopprof/blob/master/docs/zh/user_guide/msopprof_user_guide.md)。补充来源的版本和限制见参考页；不同版本参数以安装环境和实际能力探测为准。
