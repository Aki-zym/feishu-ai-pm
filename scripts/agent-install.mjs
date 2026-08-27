import { main } from './agent-runtime.mjs';

main('install').catch((error) => {
  console.error(error instanceof Error ? error.message : 'Agent 安装失败。');
  process.exitCode = 1;
});
