import { main } from './agent-runtime.mjs';

main('status').catch((error) => {
  console.error(error instanceof Error ? error.message : 'Agent 状态读取失败。');
  process.exitCode = 1;
});
