import { main } from './agent-runtime.mjs';

main('start').catch((error) => {
  console.error(error instanceof Error ? error.message : 'Agent 启动失败。');
  process.exitCode = 1;
});
