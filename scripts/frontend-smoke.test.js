/**
 * Frontend demo smoke tests.
 *
 * This is a dependency-free quality gate for the single-file demo UI. It does
 * not replace browser screenshot tests, but it catches broken script syntax,
 * missing demo-critical modules, and accidental customer-facing dev wording.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const htmlPath = path.join(ROOT, 'frontend', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const checks = [];

function check(name, condition, detail) {
  checks.push({ name, passed: Boolean(condition), detail });
}

function requireText(label, text) {
  check(`contains ${label}`, html.includes(text), `Missing: ${text}`);
}

const scriptMatch = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
check('inline script exists', scriptMatch, 'Expected a single inline script before </body>.');

if (scriptMatch) {
  try {
    // Parse only. Browser globals are resolved at runtime, so do not execute.
    new Function(scriptMatch[1]);
    check('inline script parses', true);
  } catch (err) {
    check('inline script parses', false, err.stack || err.message);
  }
}

[
  ['start screen', '星盘结算上线指挥舱'],
  ['three-column app shell', 'grid-template-areas:'],
  ['budget panel', '决策行动窗口'],
  ['interview coach', '访谈教练'],
  ['demo route panel', '演示路线'],
  ['decision workbench', '决策工作台'],
  ['evidence graph', '证据图谱'],
  ['evidence network', '关系图谱'],
  ['network role filter', 'selectEvidenceRole'],
  ['network critical filter', 'networkRiskBtn'],
  ['network to workbench action', 'networkAddBtn'],
  ['evidence path list', 'evidencePathList'],
  ['D2 workbench validation', 'D2 工作台未填齐'],
  ['report diagnosis', '决策结果诊断'],
  ['report evidence path', '证据路径图'],
  ['counterfactual cards', 'counterfactual-grid'],
  ['training plan', '下一轮训练计划'],
  ['mobile breakpoint', '@media (max-width: 768px)'],
].forEach(([label, text]) => requireText(label, text));

[
  'renderFacts',
  'renderEvidenceNetwork',
  'addFilteredEvidenceToWorkbench',
  'recordEvidencePathEvents',
  'buildReportEvidencePath',
  'buildDiagnosisPanel',
  'buildCounterfactualCards',
  'buildActionPlan',
  'prepareDemoStep',
].forEach(fn => requireText(`function ${fn}`, `function ${fn}`));

const staticHtmlBeforeScript = html.split('<script>')[0];
const forbiddenVisibleTerms = [
  'Mock',
  '未接 LLM',
  '规则引擎模式',
  '关键词兜底',
  '17 事实',
  '4 干系人',
  '7 约束',
];

for (const term of forbiddenVisibleTerms) {
  check(`customer copy hides "${term}"`, !staticHtmlBeforeScript.includes(term), `Found visible dev wording: ${term}`);
}

const failed = checks.filter(c => !c.passed);
for (const c of checks) {
  console.log(`${c.passed ? 'PASS' : 'FAIL'} ${c.name}`);
  if (!c.passed && c.detail) console.log(`  ${c.detail}`);
}

if (failed.length) {
  console.error(`\nFrontend smoke failed: ${failed.length}/${checks.length} checks failed.`);
  process.exit(1);
}

console.log(`\nFrontend smoke passed: ${checks.length}/${checks.length} checks.`);
