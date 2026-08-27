import { main } from './agent-runtime.mjs';

main('stop').catch((error) => {
  console.error(error instanceof Error ? error.message : 'Agent 停止失败。');
  process.exitCode = 1;
});
