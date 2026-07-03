const on = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (on ? `\u001b[${code}m${s}\u001b[0m` : s);

export const c = {
  green: wrap('32'),
  red: wrap('31'),
  yellow: wrap('33'),
  cyan: wrap('36'),
  dim: wrap('2'),
  bold: wrap('1'),
};

export const mark = { pass: c.green('PASS'), fail: c.red('FAIL'), skip: c.dim('SKIP') } as const;

export function hr(title = ''): void {
  const line = '─'.repeat(64);
  console.log(title ? `${c.dim('──')} ${c.bold(title)} ${c.dim(line.slice(title.length + 4))}` : c.dim(line));
}
