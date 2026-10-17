import { spawn } from 'node:child_process';
import path from 'node:path';

export function runJsonCommand(file, args, input, timeoutMs = 15_000) {
  if (!file || typeof file !== 'string') throw new Error('Adapter command is not configured.');
  return new Promise((resolve, reject) => {
    const commandArgs = Array.isArray(args) ? args : [];
    const batch = process.platform === 'win32' && ['.cmd', '.bat'].includes(path.extname(file).toLowerCase());
    const executable = batch ? (process.env.ComSpec || 'cmd.exe') : file;
    const actualArgs = batch ? ['/d', '/s', '/c', `"${file}"`, ...commandArgs] : commandArgs;
    const child = spawn(executable, actualArgs, {
      shell: false,
      // The quoted path is meant for cmd's own quote stripping; without this
      // flag Node escapes the quotes and cmd fails to find the adapter.
      windowsVerbatimArguments: batch,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Adapter command timed out.'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2_000_000) child.kill();
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Adapter command failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 500)}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')));
      } catch {
        reject(new Error('Adapter command returned invalid JSON.'));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
