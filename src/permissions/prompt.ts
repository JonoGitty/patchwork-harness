import readline from "node:readline";
import chalk from "chalk";

/**
 * Interactive y/n prompt for permission gates. Returns true on yes.
 * Non-TTY environments default to false (safe).
 */
export async function confirm(question: string, def: boolean = false): Promise<boolean> {
  if (!process.stdin.isTTY) return def;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const tag = def ? "[Y/n]" : "[y/N]";
  return new Promise<boolean>((res) => {
    rl.question(`${chalk.yellow("?")} ${question} ${chalk.dim(tag)} `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (!a) return res(def);
      res(a === "y" || a === "yes");
    });
  });
}
