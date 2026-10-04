#!/usr/bin/env bash
set -euo pipefail

dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/biaodian-tests.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

node "$dir/scripts/lint_punctuation.mjs" --input "$dir/tests/fixtures/good-sample.md" --format json > "$tmp/good.json"
node "$dir/scripts/lint_punctuation.mjs" --input "$dir/tests/fixtures/bad-sample.md" --format json > "$tmp/bad.json"

node - "$tmp/good.json" "$tmp/bad.json" <<'NODE'
import { readFileSync } from 'node:fs';
const [goodPath, badPath] = process.argv.slice(2);
const good = JSON.parse(readFileSync(goodPath, 'utf8'));
const bad = JSON.parse(readFileSync(badPath, 'utf8'));

let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`); }
  else { console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); failed++; }
};

console.log('干净样例应无机械问题');
check('good.total === 0', good.total === 0, `实际 ${good.total}`);

console.log('含错样例应命中预期规则');
check('bad.total >= 15', bad.total >= 15, `实际 ${bad.total}`);

const rules = new Set(bad.issues.map((i) => i.rule));
for (const r of ['R1', 'R2', 'R2b', 'R3', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'R14a', 'R14b', 'R15', 'R18']) {
  check(`命中 ${r}`, rules.has(r));
}

console.log('每条问题都应带依据条款与建议');
check('均有 clause', bad.issues.every((i) => i.clause && i.clause.length > 0));
check('均有 suggestion', bad.issues.every((i) => i.suggestion && i.suggestion.length > 0));
check('均有行号', bad.issues.every((i) => Number.isInteger(i.line) && i.line > 0));

process.exit(failed ? 1 : 0);
NODE

echo "全部通过。"
