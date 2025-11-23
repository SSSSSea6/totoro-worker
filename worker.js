require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { executeRunTask } = require('./runner');

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[Worker] \u672a\u68c0\u6d4b\u5230 SUPABASE_URL \u548c SUPABASE_SERVICE_KEY \u73af\u5883\u53d8\u91cf\uff0c\u65e0\u6cd5\u542f\u52a8');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const RATE_LIMIT_DELAY = Math.max(0, Number(process.env.WORKER_RATE_LIMIT_DELAY ?? 0));
const POLLING_DELAY = Number(process.env.WORKER_POLLING_DELAY ?? 15000);
const WORKER_ID = process.env.WORKER_ID || `worker-${Math.random().toString(36).slice(2, 8)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquireJob() {
  const { data: pendingJobs, error: fetchError } = await supabase
    .from('Tasks')
    .select('id, user_data')
    .eq('status', 'PENDING')
    .order('id', { ascending: true })
    .limit(1);

  if (fetchError) {
    console.error(`[Worker ${WORKER_ID}] \u83b7\u53d6\u5f85\u5904\u7406\u4efb\u52a1\u5931\u8d25:`, fetchError.message);
    return null;
  }

  const job = pendingJobs?.[0];
  if (!job) return null;

  const { data: updatedJob, error: lockError } = await supabase
    .from('Tasks')
    .update({ status: 'PROCESSING', result_log: null })
    .eq('id', job.id)
    .eq('status', 'PENDING')
    .select('id, user_data')
    .single();

  if (lockError || !updatedJob) {
    console.warn(`[Worker ${WORKER_ID}] \u4efb\u52a1 ${job.id} \u88ab\u5176\u4ed6\u5b9e\u4f8b\u9501\u5b9a\uff0c\u8df3\u8fc7`);
    return null;
  }

  return updatedJob;
}

async function processJob(job) {
  const start = Date.now();
  console.log(`[Worker ${WORKER_ID}] \u5f00\u59cb\u5904\u7406\u4efb\u52a1 ${job.id}`);
  try {
    const resultLog = await executeRunTask(job.user_data);
    await supabase
      .from('Tasks')
      .update({ status: 'SUCCESS', result_log: resultLog })
      .eq('id', job.id);
    console.log(`[Worker ${WORKER_ID}] \u4efb\u52a1 ${job.id} \u6210\u529f\uff0c\u8017\u65f6 ${Date.now() - start} ms`);
  } catch (taskError) {
    await supabase
      .from('Tasks')
      .update({ status: 'FAILED', result_log: taskError.message })
      .eq('id', job.id);
    console.error(`[Worker ${WORKER_ID}] \u4efb\u52a1 ${job.id} \u5931\u8d25\uff0c\u8017\u65f6 ${Date.now() - start} ms: ${taskError.message}`);
  }
}

async function mainLoop() {
  console.log(`[Worker ${WORKER_ID}] \u542f\u52a8\uff0c\u5f00\u59cb\u8f6e\u8be2 Supabase`);
  while (true) {
    try {
      const job = await acquireJob();
      if (job) {
        await processJob(job);
        if (RATE_LIMIT_DELAY > 0) {
          await sleep(RATE_LIMIT_DELAY);
        }
      } else {
        await sleep(POLLING_DELAY);
      }
    } catch (error) {
      console.error(`[Worker ${WORKER_ID}] \u4e3b\u5faa\u73af\u5f02\u5e38:`, error);
      await sleep(POLLING_DELAY);
    }
  }
}

mainLoop();
