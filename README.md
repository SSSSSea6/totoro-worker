# Totoro Worker

Supabase 队列驱动的后台 Worker，用于从 `Tasks` 表中拉取待执行任务，调用 Totoro 跑步接口并回写执行结果。

> 仅供学习和技术研究使用，请勿用于任何违规用途。

## 功能概览

- 周期性轮询 Supabase 数据库中的 `Tasks` 表；
- 以「抢占锁」的方式将 `PENDING` 任务更新为 `PROCESSING`；
- 将任务中的 `user_data` 传给 `executeRunTask`（见 `runner.js`）；
- 负责：
  - 构造加密请求体（RSA）并请求 `https://app.xtotoro.com/app/*`；
  - 调用 `sunrun/getRunBegin`、`platform/recrecord/sunRunExercises`、`platform/recrecord/sunRunExercisesDetail` 等接口；
  - 根据 `runPoint.pointList` 生成一条随机扰动的跑步线路；
  - 将执行日志写回 `Tasks.result_log`，并更新任务状态为 `SUCCESS` 或 `FAILED`。

核心代码文件：

- `worker.js`：主轮询 Worker，从 `Tasks` 取任务并调用 `executeRunTask`；
- `runner.js`：具体的 Totoro 任务执行逻辑（加密、接口调用、路线生成）；
- `rsaKeys.js`：RSA 公私钥配置；
- `.env.example`：环境变量示例；
- `package.json`：依赖与启动脚本。

## 环境要求

- Node.js **>= 18**（需要内置 `fetch` 和 WebCrypto）；
- 已创建 Supabase 项目，且包含 `Tasks` 表：
  - 至少需要字段：`id`、`status`、`user_data`、`result_log`；
  - `status` 约定枚举：`PENDING` / `PROCESSING` / `SUCCESS` / `FAILED`；
  - `user_data` 推荐为 `jsonb` 字段。

## 快速开始

1. 复制环境变量模板并填写：
   ```bash
   cp .env.example .env
   ```
   将其中的 `SUPABASE_URL` 和 `SUPABASE_SERVICE_KEY` 替换为你自己的 Supabase 项目配置。

2. 安装依赖：
   ```bash
   npm install
   ```

3. 启动 Worker：
   ```bash
   npm start
   ```

启动后，`worker.js` 会持续轮询 Supabase，发现 `PENDING` 状态任务时即尝试领取并执行。

## 环境变量说明（`.env`）

必填：

- `SUPABASE_URL`：Supabase 项目的 URL（形如 `https://xxx.supabase.co`）；
- `SUPABASE_SERVICE_KEY`：Supabase Service Role Key，用于服务端访问；

可选（有默认值）：

- `WORKER_RATE_LIMIT_DELAY`：同一实例在连续处理任务之间的等待时间（毫秒），默认 `5000`；
- `WORKER_POLLING_DELAY`：队列为空时的轮询间隔（毫秒），默认 `15000`；
- `WORKER_ID`：Worker 实例标识，默认随机生成（仅用于日志输出）。

## 任务数据结构（`Tasks.user_data`）

Worker 只关心 `user_data` 字段，`worker.js` 会将其原样传入：

```js
executeRunTask(job.user_data);
```

`runner.js` 期望的 `user_data` 大致结构如下（类型仅供参考）：

```ts
{
  session: {
    token: string;
    schoolId: string | number;
    campusId: string | number;
    stuNumber: string;
    phoneNumber?: string;
  };
  runPoint: {
    taskId: string | number;
    pointId: string | number;
    // 路线关键点，用于生成完整跑步轨迹
    pointList: Array<{
      longitude: string | number;
      latitude: string | number;
    }>;
  };
  // 目标里程（公里）
  mileage: number | string;
  // 预计最短/最长用时（分钟），用于生成合理的配速与用时
  minTime: number | string;
  maxTime: number | string;
}
```

当 `session` 或 `runPoint` 缺失时，`executeRunTask` 会抛出异常并导致任务标记为 `FAILED`。

## 工作流程概览

1. **轮询队列**：`worker.js` 定期查询 `Tasks` 表中首个 `status = 'PENDING'` 的任务；
2. **任务锁定**：通过 `update ... where id = ? and status = 'PENDING'` 的方式将任务状态更新为 `PROCESSING`，避免多实例抢同一条任务；
3. **执行任务**（`executeRunTask`）：
   - 校验 `user_data`；
   - 调用 `sunrun/getRunBegin` 初始化跑步；
   - 根据 `mileage` 和 `runPoint.pointList` 生成一条高密度、带随机扰动的跑步轨迹；
   - 根据 `minTime` / `maxTime` 生成合理的用时和配速；
   - 调用 `sunRunExercises` 提交主体记录，拿到 `scantronId`；
   - 调用 `sunRunExercisesDetail` 提交轨迹详情；
4. **写回结果**：
   - 成功：将 `status` 更新为 `SUCCESS`，`result_log` 写入一条成功说明；
   - 失败：将 `status` 更新为 `FAILED`，`result_log` 写入错误信息。

## 日志与调试

- Worker 日志中包含 `WORKER_ID`，便于在多实例部署时定位问题；
- 当上游接口返回非 2xx 响应时，会抛出带有状态码与原始响应文本的错误；
- 若 Supabase 查询/更新失败，会打印错误信息并在下一轮轮询继续尝试。

本地调试建议：

- 先在 Supabase 控制台手动插入一条 `PENDING` 任务，`user_data` 按上文结构填写；
- 启动 `npm start` 观察日志是否如预期流转到 `SUCCESS` 或 `FAILED`；
- 如需频繁修改逻辑，可在 `worker.js` 中临时缩短轮询间隔（如 `WORKER_POLLING_DELAY=3000`）。

## 安全与免责声明

- 本项目仅用于学习研究 Supabase 队列任务处理与第三方接口调用流程；
- 请确保在符合所在学校、平台以及相关法律法规的前提下使用；
- 使用本项目产生的一切后果由使用者自行承担。

