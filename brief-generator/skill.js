#!/usr/bin/env node
/**
 * skill.js — Skill OpenClaw : regénère le brief manuellement
 *
 * Usage : node skill.js
 */

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.join(process.env.HOME, 'vps-stack', '.env');
  const vars = {};
  if (!fs.existsSync(envPath)) return vars;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

const env        = { ...process.env, ...loadEnv() };
const scriptPath = path.join(__dirname, 'generate-brief.js');

const result = spawnSync('node', [scriptPath], {
  env,
  cwd: __dirname,
  encoding: 'utf-8',
  timeout: 60_000,
});

if (result.error) {
  console.log(JSON.stringify({ error: result.error.message }));
  process.exit(1);
}

const output = (result.stdout || '') + (result.stderr || '');
const jsonLine = [...output.trim().split('\n')].reverse().find(l => l.trim().startsWith('{'));

if (jsonLine) {
  console.log(jsonLine);
} else if (result.status === 0) {
  console.log(JSON.stringify({ ok: true, message: 'Brief régénéré avec succès' }));
} else {
  console.log(JSON.stringify({ error: output.trim().slice(-500) }));
  process.exit(1);
}
