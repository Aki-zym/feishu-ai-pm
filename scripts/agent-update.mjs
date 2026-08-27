import { main } from './agent-runtime.mjs';

main('update').catch((error) => {
  console.error(error instanceof Error ? error.message : 'Agent 更新失败。');
  process.exitCode = 1;
});
