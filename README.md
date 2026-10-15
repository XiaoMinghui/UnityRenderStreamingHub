# Unity Render Streaming Hub

基于 [Unity 官方 Render Streaming](https://github.com/Unity-Technologies/UnityRenderStreaming) `3.1.0-exp.9` 维护和扩展的串流项目，包含 **Unity 插件、信令服务器和网页接收端**。

在原有 WebRTC 音视频与远程交互能力上，完善连接恢复，并增加多实例分配、排队、管理后台和进程管理工具，方便多个应用共享同一套串流服务。

## 做了哪些改进

| 功能 | 本项目的处理 |
| --- | --- |
| 连接稳定性 | 增加心跳、断线重连、首帧超时和画面停滞检测，恢复时清理旧连接资源 |
| 网页接收体验 | 自动播放、连接状态提示、画面等比适配、全屏和输入坐标映射 |
| Unity 原生接收 | 提供 `StreamingReceiver`，统一接收、重连、画面状态和输入通道管理 |
| 多实例池 | 按内容池分配空闲 Unity 实例，一位用户独占一个实例，容量不足时排队；会话结束后等待业务重置完成再分配 |
| 短暂断线恢复 | 实例池网页接收端默认保留原实例或排队位置 30 秒，支持短暂断网和同一标签页刷新后恢复 |
| 管理后台 | 查看实例、会话、队列和近期事件，支持停止接单、恢复接单、重新准备和结束会话 |
| 进程管理 Agent | 在渲染机器上启动配置好的 Unity 程序，支持启停、重启、崩溃重试和日志查看 |

**兼容原有接入方式。** 保留 `com.unity.renderstreaming` 包标识、原有公开 API 和资产 GUID。Public/Private 连接及普通接收页面继续使用；实例池、管理接口和 Agent 服务均需显式开启。

## 如何使用

在 Unity Package Manager 中通过 Git URL 安装插件：

```text
https://github.com/XiaoMinghui/UnityRenderStreamingHub.git?path=/com.unity.renderstreaming#main
```

克隆仓库并安装 Node.js 22 后，在仓库根目录启动普通信令服务器：

```powershell
powershell -ExecutionPolicy Bypass -File Tools/Start-Server.ps1 -Port 8080
```

Unity 推流端连接该服务器后，通过 `/receiver/index.html` 访问画面。需要同时服务多个独立用户时，配置多个 Unity 推流实例，并按下面的文档启用实例池。

| 文档 | 内容 |
| --- | --- |
| [开发与维护](MAINTENANCE.md) | 本地共享包、安装配置、运行环境和验证方式 |
| [实例池](INSTANCE_POOL.md) | Unity 推流端接入、内容分组、排队、重置与断线恢复 |
| [管理后台](WebApp/ADMINISTRATION.md) | `/admin/` 页面、管理凭证和操作接口 |
| [进程管理](Tools/ProcessAgent/README.md) | 渲染机器 Agent 配置及 Unity 进程管理 |
| [平台要求](com.unity.renderstreaming/Documentation~/index.md#requirements) | Unity、Render Streaming 与 WebRTC 兼容要求 |

## 项目范围

本仓库维护通用串流能力；业务场景、设备 SDK、相机配置和业务重置逻辑由接入项目负责。插件、服务器、工具和 Unity 测试工程分别位于 `com.unity.renderstreaming/`、`WebApp/`、`Tools/` 和 `TestProjects/`。

当前实例池接收与会话保留面向网页端，队列及会话保存在单个服务器进程内存中。平台支持以依赖要求和实际设备验证为准；浏览器、Unity 编辑器测试不代表 Android 实机或所有设备均已验证。

## 许可证

保留上游 [许可证](LICENSE.md)、[Unity 包许可证](com.unity.renderstreaming/LICENSE.md)及[第三方声明](Third%20Party%20Notices.md)。
