const REQUIRED_PROJECTS = Object.freeze(['browser-desktop-chromium', 'browser-mobile-chromium']);
const FORBIDDEN_DIRECTIVE = /\btest\s*(?:\.\s*describe\s*)?\.\s*(only|skip|fixme)\s*\(/g;

export function findForbiddenPlaywrightDirectives(files) {
  const violations = [];
  for (const file of files) {
    for (const match of file.content.matchAll(FORBIDDEN_DIRECTIVE)) {
      violations.push({ file: file.path, directive: match[1] });
    }
  }
  return violations;
}

export function collectPlaywrightTests(report) {
  const tests = [];
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        tests.push({ id: spec.id, title: spec.title, ...test });
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  return tests;
}

function annotationTypes(test) {
  return [
    ...(test.annotations ?? []),
    ...(test.results ?? []).flatMap((result) => result.annotations ?? []),
  ].map((annotation) => String(annotation.type ?? '').toLowerCase());
}

export function summarizePlaywrightReport(report, { phase }) {
  if (phase !== 'inventory' && phase !== 'execution') throw new Error(`Unknown Playwright evidence phase: ${phase}.`);
  const projects = Object.fromEntries(REQUIRED_PROJECTS.map((project) => [project, {
    discovered: 0,
    executed: 0,
    passed: 0,
    skipped: 0,
    failed: 0,
    ids: [],
  }]));
  const unknownProjects = new Set();
  for (const test of collectPlaywrightTests(report)) {
    const project = projects[test.projectName];
    if (!project) {
      unknownProjects.add(test.projectName ?? '<missing>');
      continue;
    }
    project.discovered += 1;
    project.ids.push(`${test.projectName}:${test.id}`);
    const results = test.results ?? [];
    if (results.length > 0) project.executed += 1;
    const finalStatus = results.at(-1)?.status;
    const forbiddenAnnotation = annotationTypes(test).some((type) => type === 'skip' || type === 'fixme');
    const isSkipped = test.expectedStatus === 'skipped'
      || forbiddenAnnotation
      || (phase === 'execution' && (test.status === 'skipped' || finalStatus === 'skipped'));
    if (isSkipped) {
      project.skipped += 1;
    } else if (finalStatus === 'passed' && (test.status === 'expected' || test.status === 'flaky')) {
      project.passed += 1;
    } else if (results.length > 0) {
      project.failed += 1;
    }
  }
  for (const project of Object.values(projects)) project.ids.sort();
  return {
    forbidOnly: report.config?.forbidOnly === true,
    runnerErrors: (report.errors ?? []).length,
    total: Object.values(projects).reduce((sum, project) => sum + project.discovered, 0),
    projects,
    unknownProjects: [...unknownProjects].sort(),
  };
}

export function verifyPlaywrightInventory(summary) {
  const errors = [];
  if (!summary.forbidOnly) errors.push('forbidOnly is not enabled');
  if (summary.runnerErrors > 0) errors.push(`runner reported ${summary.runnerErrors} error(s)`);
  if (summary.unknownProjects.length > 0) errors.push(`unknown projects: ${summary.unknownProjects.join(', ')}`);
  for (const projectName of REQUIRED_PROJECTS) {
    const project = summary.projects[projectName];
    if (!project || project.discovered < 1) errors.push(`${projectName} inventory is empty`);
    if ((project?.skipped ?? 0) > 0) errors.push(`${projectName} inventory contains skip/fixme tests`);
  }
  if (summary.total < 1) errors.push('Playwright inventory is empty');
  if (errors.length > 0) throw new Error(`Playwright inventory policy failed: ${errors.join('; ')}.`);
}

export function verifyPlaywrightExecution(inventory, execution) {
  verifyPlaywrightInventory(inventory);
  const errors = [];
  if (!execution.forbidOnly) errors.push('forbidOnly is not enabled');
  if (execution.runnerErrors > 0) errors.push(`runner reported ${execution.runnerErrors} error(s)`);
  if (execution.unknownProjects.length > 0) errors.push(`unknown projects: ${execution.unknownProjects.join(', ')}`);
  for (const projectName of REQUIRED_PROJECTS) {
    const expected = inventory.projects[projectName];
    const actual = execution.projects[projectName];
    if (!actual || actual.discovered < 1) errors.push(`${projectName} execution is empty`);
    if ((actual?.executed ?? 0) !== (expected?.discovered ?? -1)) errors.push(`${projectName} executed count does not match inventory`);
    if ((actual?.passed ?? 0) < 1) errors.push(`${projectName} has no passed tests`);
    if ((actual?.skipped ?? 0) > 0) errors.push(`${projectName} contains runtime skip/fixme`);
    if ((actual?.failed ?? 0) > 0) errors.push(`${projectName} contains failed tests`);
    if (JSON.stringify(actual?.ids ?? []) !== JSON.stringify(expected?.ids ?? [])) errors.push(`${projectName} test ids do not match inventory`);
  }
  if (execution.total !== inventory.total) errors.push('executed inventory total mismatch');
  if (errors.length > 0) throw new Error(`Playwright execution policy failed: ${errors.join('; ')}.`);
}

export function formatPlaywrightCounts(label, summary) {
  const lines = [`${label} total=${summary.total}`];
  for (const projectName of REQUIRED_PROJECTS) {
    const project = summary.projects[projectName];
    lines.push(`${projectName} discovered=${project.discovered} executed=${project.executed} passed=${project.passed} skipped=${project.skipped} failed=${project.failed}`);
  }
  return `${lines.join('\n')}\n`;
}

export { REQUIRED_PROJECTS };
