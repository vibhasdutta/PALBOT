#!/usr/bin/env node
// Interactive deploy: pick which of the apps in deploy/ecosystem.config.js
// to (re)start via PM2. Restarts in place if an app is already running,
// otherwise starts it fresh -- same logic the old deploy.sh had, just
// per-component and interactive instead of "always bot+agent." Plain
// node:readline/promises -- no TUI library needed for a short checklist
// prompt, and this runs the same way on Windows (dev machine) and Linux
// (the VM), unlike a bash script.
import { createInterface } from 'node:readline/promises';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ecosystemConfig from '../deploy/ecosystem.config.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The app list is read from ecosystem.config.js itself, not duplicated
// here -- add/remove/rename an app there and this picker follows without
// needing a matching edit. LABELS is purely cosmetic (falls back to the
// raw pm2 name for anything not listed), so it's fine for it to lag behind.
const LABELS = {
  palworld: 'Palworld game server (world)',
  'palworld-bot': 'Discord bot',
  'palworld-agent': 'Remote agent',
};

const APPS = ecosystemConfig.apps.map((app) => ({ name: app.name, label: LABELS[app.name] || app.name }));

function run(cmd, cwd = repoRoot) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd });
}

function isRunning(appName) {
  try {
    execSync(`pm2 describe ${appName}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const BANNER = String.raw`
██████╗  █████╗ ██╗     ██████╗  ██████╗ ████████╗
██╔══██╗██╔══██╗██║     ██╔══██╗██╔═══██╗╚══██╔══╝
██████╔╝███████║██║     ██████╔╝██║   ██║   ██║
██╔═══╝ ██╔══██║██║     ██╔══██╗██║   ██║   ██║
██║     ██║  ██║███████╗██████╔╝╚██████╔╝   ██║
╚═╝     ╚═╝  ╚═╝╚══════╝╚═════╝  ╚═════╝    ╚═╝
`;

const rl = createInterface({ input: process.stdin, output: process.stdout });

console.log(BANNER);
console.log('Select which components to deploy:');
APPS.forEach((app, i) => console.log(`  ${i + 1}) ${app.name} -- ${app.label}`));

const answer = (await rl.question('Enter numbers separated by commas (e.g. 1,2), or "all": ')).trim().toLowerCase();
rl.close();

const selected = answer === 'all'
  ? APPS
  : answer.split(',').map((s) => s.trim()).filter(Boolean).map((n) => APPS[Number(n) - 1]).filter(Boolean);

if (selected.length === 0) {
  console.log('Nothing selected, exiting.');
  process.exit(0);
}

console.log(`Deploying: ${selected.map((a) => a.name).join(', ')}`);

// Each component's own test suite runs only when that component is
// actually selected -- deploying just the agent shouldn't require the
// bot's tests to pass, and vice versa. palworld itself isn't a Node
// project, so it has no test step.
if (selected.some((a) => a.name === 'palworld-bot')) run('npm test');
if (selected.some((a) => a.name === 'palworld-agent')) run('npm test', path.join(repoRoot, 'agent'));

for (const app of selected) {
  if (isRunning(app.name)) {
    console.log(`${app.name} already running -- restarting in place`);
    run(`pm2 restart ${app.name}`);
  } else {
    console.log(`${app.name} not running -- starting fresh`);
    run(`pm2 start deploy/ecosystem.config.js --only ${app.name}`);
  }
}

run('pm2 save');
