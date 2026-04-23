import type {
  FullConfig,
  FullResult,
  Suite,
  TestCase,
  TestResult,
  Reporter,
} from '@playwright/test/reporter';
import fs from 'fs';
import path from 'path';

class AiReporter implements Reporter {
  private failedTests: Array<{ test: TestCase; result: TestResult }> = [];

  onBegin(_config: FullConfig, _suite: Suite): void {
    this.failedTests = [];
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status !== 'passed' && result.status !== 'skipped') {
      this.failedTests.push({ test, result });
    }
  }

  onEnd(_result: FullResult): void {
    if (this.failedTests.length === 0) return;

    const reportDir = path.join(process.cwd(), 'test-results', 'failure-reports');
    fs.mkdirSync(reportDir, { recursive: true });

    for (const { test, result } of this.failedTests) {
      const testName = test
        .titlePath()
        .join(' > ')
        .replace(/[^a-zA-Z0-9_-]/g, '_');
      const reportPath = path.join(reportDir, `${testName}.md`);

      const lines = [
        `# Test Failure: ${test.title}`,
        '',
        `**File**: ${test.location.file}:${test.location.line}`,
        `**Browser**: ${test.parent?.project()?.name ?? 'unknown'}`,
        `**Duration**: ${result.duration}ms`,
        `**Retry**: ${result.retry}`,
        '',
        '## Error',
        '```',
        result.error?.message ?? 'No error message',
        '```',
        '',
        '## Stack Trace',
        '```',
        result.error?.stack ?? 'No stack trace',
        '```',
        '',
        '## Key Observations (auto-generated)',
        '',
        'Check the following artifacts for debugging:',
      ];

      // List relevant artifact paths
      const artifactDirs = [`test-results/traces/`, `test-results/failure-reports/`];

      for (const dir of artifactDirs) {
        const fullPath = path.join(process.cwd(), dir);
        if (fs.existsSync(fullPath)) {
          lines.push(`- \`${dir}\``);
        }
      }

      // Try to read and include the failure-report.txt if it exists
      const testSafeName = test.title.replace(/[^a-zA-Z0-9_-]/g, '_');
      const failureReportPath = path.join(
        process.cwd(),
        'test-results',
        'traces',
        testSafeName,
        'failure-report.txt'
      );
      if (fs.existsSync(failureReportPath)) {
        const reportContent = fs.readFileSync(failureReportPath, 'utf-8');
        lines.push('', '## Failure Report', '```', reportContent.slice(0, 10_000), '```');
      }

      lines.push('');
      fs.writeFileSync(reportPath, lines.join('\n'));
    }
  }
}

export default AiReporter;
