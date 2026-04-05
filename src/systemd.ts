import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { getCcgHome } from './config.js';

const SERVICE_NAME = 'ccgateway';

function serviceDir(): string {
  return join(homedir(), '.config', 'systemd', 'user');
}

function servicePath(): string {
  return join(serviceDir(), `${SERVICE_NAME}.service`);
}

function findCcgBin(): string {
  try {
    return execSync('which ccg', { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error(
      "'ccg' not found in PATH. Install it first: npm install -g ccgateway",
    );
  }
}

function systemctl(...args: string[]): string {
  try {
    return execSync(`systemctl --user ${args.join(' ')}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    throw new Error(
      `systemctl --user ${args.join(' ')} failed: ${(err as Error).message}`,
    );
  }
}

/**
 * Install and enable the ccgateway systemd user service.
 */
export function installService(): void {
  const ccgBin = findCcgBin();
  const envFile = join(getCcgHome(), '.env');
  const hasEnv = existsSync(envFile);

  const unit = [
    '[Unit]',
    'Description=ccgateway — multi-agent orchestration layer for Claude Code',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${ccgBin} start`,
    'Restart=on-failure',
    'RestartSec=5',
    ...(hasEnv ? [`EnvironmentFile=${envFile}`] : []),
    `Environment=PATH=${process.env.PATH}`,
    `Environment=HOME=${homedir()}`,
    'Environment=NODE_ENV=production',
    '',
    '[Install]',
    'WantedBy=default.target',
  ].join('\n');

  mkdirSync(serviceDir(), { recursive: true });
  writeFileSync(servicePath(), unit + '\n', 'utf-8');
  console.log(`Created ${servicePath()}`);

  systemctl('daemon-reload');
  systemctl('enable', SERVICE_NAME);
  systemctl('start', SERVICE_NAME);

  console.log('');
  console.log('ccgateway service installed and started.');

  if (!hasEnv) {
    console.log('');
    console.log(`Warning: ${envFile} not found.`);
    console.log('  If your bots need tokens, create that file and run:');
    console.log('  systemctl --user restart ccgateway');
  }

  console.log('');
  console.log('Useful commands:');
  console.log(`  systemctl --user status  ${SERVICE_NAME}`);
  console.log(`  journalctl --user -u ${SERVICE_NAME} -f`);
  console.log(`  systemctl --user restart ${SERVICE_NAME}`);
  console.log(`  ccg uninstall`);

  // Linger hint
  try {
    const linger = execSync(`loginctl show-user ${process.env.USER} --property=Linger`, {
      encoding: 'utf-8',
    }).trim();
    if (!linger.includes('yes')) {
      console.log('');
      console.log(`Tip: Run 'loginctl enable-linger ${process.env.USER}' to keep`);
      console.log('     the service running after you log out.');
    }
  } catch {
    // loginctl not available — skip hint
  }
}

/**
 * Stop, disable, and remove the ccgateway systemd user service.
 */
export function uninstallService(): void {
  if (!existsSync(servicePath())) {
    console.log('ccgateway systemd service is not installed.');
    return;
  }

  try { systemctl('stop', SERVICE_NAME); } catch { /* may already be stopped */ }
  try { systemctl('disable', SERVICE_NAME); } catch { /* may already be disabled */ }

  unlinkSync(servicePath());
  systemctl('daemon-reload');

  console.log('ccgateway systemd service removed.');
}
